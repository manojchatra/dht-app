const express = require('express');
const sharp   = require('sharp');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db/database');
const { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = require('../services/googleCalendar');
const { compressImage, compressAndGate } = require('../utils/imageUtils');
const { logActivity, addNotification }   = require('../utils/activityLogger');
const {
  writeToAssigned, writeToTBO, writeToDelivered,
  updateToScheduled, moveToDelivered, moveToCancelled,
  revertToAssigned, updateTBOSerial,
  moveToReceived, moveFromReceivedToScheduled,
  moveFromReceivedToDelivered, moveFromReceivedToCancelled,
  updateReceivedSerial, deleteInventoryRow
} = require('../services/driveInventory');
const { generateContractPDF } = require('../utils/pdfGenerator');
const { requireAdmin, requireRole } = require('../middleware/auth');

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/contracts');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.fieldname}${path.extname(file.originalname) || '.jpg'}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadFields = upload.fields([
  { name: 'contractImage', maxCount: 1 },
  { name: 'chequeImage',   maxCount: 1 },
  { name: 'extraImages',   maxCount: 10 },
]);
const uploadSingle = upload.single('image');
const uploadSerial = upload.single('serialPhoto');


// ── Image / PDF compression ────────────────────────────────────────────────────
// ── Contract number generator ─────────────────────────────────────────────────
// Format: DHT2607PH00001 (5-digit sequence, uses form date field)
const STORE_CODES = {
  Phoenix: 'PH', Goodyear: 'GY', Chandler: 'CH', Surprise: 'SU', Tolleson: 'TO'
};

function generateContractNumber(store, contractDate) {
  // Use form date for year/month (supports historical contract digitization)
  const date  = contractDate ? new Date(contractDate + 'T12:00:00') : new Date();
  const year  = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const storeCode = STORE_CODES[store] || 'XX';
  // Atomically increment settings counter (handles concurrent saves safely)
  db.prepare("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'contract_sequence'").run();
  const seqRow = db.prepare("SELECT value FROM settings WHERE key='contract_sequence'").get();
  const seq = String(parseInt(seqRow.value || '0')).padStart(5, '0');
  return `DHT${year}${month}${storeCode}${seq}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SALESMEN = [
  'Michael Ioli','Jeff Geffre','Robert Heger','Dave Pepe',
  'Paul Williamson','Barbara Hodges','Gaurav Shetty','Joe Sorensen'
];

function summariseCover(cover = {}) {
  const parts = [];
  if (cover.coverType?.length) parts.push(cover.coverType.join('/'));
  if (cover.brand)    parts.push(cover.brand);
  if (cover.lift && cover.lift !== 'none') parts.push(cover.lift);
  if (cover.otherLift) parts.push(cover.otherLift);
  return parts.join(', ');
}

function summariseAccessories(acc = {}) {
  const items = [...(acc.items || [])];
  if (acc.other) items.push(acc.other);
  return items.join(', ');
}

function extractPaid(payment = {}) {
  if (payment.cheque?.selected)     return payment.cheque.amount   || '';
  if (payment.cash?.selected)       return payment.cash.amount     || '';
  if (payment.creditCard?.selected) return 'CC';
  if (payment.finance?.selected)    return payment.finance.amount  || '';
  return '';
}

function initialStatus(productStatus) {
  return productStatus === 'instock' ? 'assigned' : 'tbo';
}

// Convert absolute path to web-accessible URL path
function toUrlPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  try {
    const uploadsDir = path.join(__dirname, '../uploads');
    const rel = path.relative(uploadsDir, absPath);
    if (rel.startsWith('..')) return null; // path outside uploads — reject
    return '/uploads/' + rel.replace(/\\/g, '/');
  } catch(e) { return null; }
}

// ── List contracts ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        c.id, c.contract_number, c.store, c.date, c.delivery_date,
        c.salesman, c.product_status, c.status,
        c.serial_number, c.make, c.model,
        c.grand_total, c.paid_amount, c.due_prior,
        c.scheduled_datetime, c.scheduled_duration, c.delivery_team, c.acknowledgement_pdf, c.contract_image_path, c.cheque_image_path, c.extra_images, c.created_at,
        COALESCE(json_extract(c.data,'$.customer.name'), cu.name, '') AS customer_name,
        cu.email      AS customer_email,
        cu.zip        AS customer_zip,
        cu.phone_cell AS customer_phone,
        cu.address    AS customer_address,
        cu.address    AS address,
        cu.city       AS city
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      ORDER BY c.created_at DESC
    `).all();

    const contracts = rows.map(r => ({
      ...r,
      acknowledgement_pdf_url: r.acknowledgement_pdf ? toUrlPath(r.acknowledgement_pdf) : null,
      contract_image_url:   toUrlPath(r.contract_image_path),
      cheque_image_url:   toUrlPath(r.cheque_image_path),
      extra_images_data:  r.extra_images ? JSON.parse(r.extra_images).map(item =>
          typeof item === 'string' ? { url: toUrlPath(item), label:'' } : { url: toUrlPath(item.path), label: item.label||'' }
        ) : [],
      total_paid: db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(r.id)?.t || 0,
    }));
    res.json(contracts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
});

// ── Get single contract ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT c.*, cu.name AS customer_name, cu.address AS customer_address
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const payments = db.prepare('SELECT * FROM payments WHERE contract_id=? ORDER BY date,created_at').all(req.params.id);
    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);

    const extraRaw = row.extra_images ? JSON.parse(row.extra_images) : [];
    const extraImagesData = extraRaw.map(item =>
      typeof item === 'string'
        ? { url: toUrlPath(item), label: '' }
        : { url: toUrlPath(item.path), label: item.label || '' }
    ).filter(i => i.url);

    res.json({
      ...row,
      data: JSON.parse(row.data),
      acknowledgement_pdf:     row.acknowledgement_pdf || null,
      acknowledgement_pdf_url: row.acknowledgement_pdf ? toUrlPath(row.acknowledgement_pdf) : null,
      contract_image_url: toUrlPath(row.contract_image_path),
      cheque_image_url:   toUrlPath(row.cheque_image_path),
      extra_images_data:  extraImagesData,
      payments,
      total_paid: totalPaid,
    });
  } catch (err) {
    console.error('[GET contract error]', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch contract' });
  }
});


// ── Temp upload (called from Preview & Save before navigation) ───────────────
router.post('/upload-temp', uploadFields, async (req, res) => {
  try {
    const result = {};
    if (req.files?.contractImage?.[0]) result.contractImagePath = req.files.contractImage[0].path;
    if (req.files?.chequeImage?.[0])   result.chequeImagePath   = req.files.chequeImage[0].path;
    if (req.files?.extraImages?.length) {
      const labels = JSON.parse(req.body.extraImageLabels || '[]');
      result.extraImages = req.files.extraImages.map((f,i) => ({
        path: f.path, label: labels[i] || ''
      }));
    }
    // Compress uploaded images/PDFs
    const compressEntry = async (p) => { if(!p) return p; const r=await compressAndGate(p); return r.error?null:r.path; };
    if (result.contractImagePath) result.contractImagePath = await compressEntry(result.contractImagePath);
    if (result.chequeImagePath)   result.chequeImagePath   = await compressEntry(result.chequeImagePath);
    if (result.extraImages) result.extraImages = await Promise.all(result.extraImages.map(async i=>{const p=await compressEntry(i.path);return p?{path:p,label:i.label}:null;})).then(a=>a.filter(Boolean));

    res.json(result);
  } catch(err) {
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ── Salesman list ─────────────────────────────────────────────────────────────
router.get('/meta/salesmen', (req, res) => {
  try {
    const fromDb = db.prepare('SELECT DISTINCT salesman FROM contracts WHERE salesman IS NOT NULL ORDER BY salesman').all().map(r => r.salesman);
    const merged = [...new Set([...SALESMEN, ...fromDb])].sort();
    res.json(merged);
  } catch (_) { res.json(SALESMEN); }
});

// ── Create contract ───────────────────────────────────────────────────────────
router.post('/', uploadFields, async (req, res) => {
  try {
    const formData = JSON.parse(req.body.data);
    const { customer, product, payment, costing, details } = formData; // full formData for extraction

    // 0. Validate payment method requirements
    const payErrors = [];
    if (payment?.cheque?.selected) {
      if (!payment.cheque.number) payErrors.push('Cheque number is required');
      if (!(parseFloat(payment.cheque.amount) > 0)) payErrors.push('Cheque amount is required');
    }
    if (payment?.cash?.selected) {
      if (!(parseFloat(payment.cash.amount) > 0)) payErrors.push('Cash amount is required');
    }
    if (payment?.creditCard?.selected) {
      if (!payment.creditCard.lastFour) payErrors.push('Credit card last 4 digits are required');
      if (!(parseFloat(payment.creditCard.amount) > 0)) payErrors.push('Credit card amount is required');
    }
    if (payment?.finance?.selected) {
      if (!payment.finance.plan) payErrors.push('Finance lender/plan name is required');
      if (!(parseFloat(payment.finance.amount) > 0)) payErrors.push('Finance amount is required');
    }
    if (payErrors.length) {
      return res.status(400).json({ error: payErrors[0], errors: payErrors });
    }

    // 1. Upsert customer
    let customerId;
    const existing = db.prepare(
      `SELECT id FROM customers WHERE (email=? AND email!='') OR (name=? AND zip=?)`
    ).get(customer.email, customer.name, customer.zip);

    if (existing) {
      db.prepare(`UPDATE customers SET name=?,email=?,phone_cell=?,phone_home=?,phone_work=?,
        address=?,city=?,state=?,zip=?,gated=?,gate_code=?,heard_about=? WHERE id=?`
      ).run(customer.name, customer.email, customer.phone?.cell, customer.phone?.home, customer.phone?.work,
        customer.address, customer.city, customer.state||'AZ', customer.zip,
        customer.gated?1:0, customer.gateCode, customer.heardAbout, existing.id);
      customerId = existing.id;
    } else {
      const ins = db.prepare(`INSERT INTO customers
        (name,email,phone_cell,phone_home,phone_work,address,city,state,zip,gated,gate_code,heard_about)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(customer.name, customer.email,
        customer.phone?.cell, customer.phone?.home, customer.phone?.work,
        customer.address, customer.city, customer.state||'AZ', customer.zip,
        customer.gated?1:0, customer.gateCode, customer.heardAbout);
      customerId = ins.lastInsertRowid;
    }

    // 2. File paths — support both direct upload and pre-uploaded (from Preview & Save flow)
    // Strip _uploadedPaths — internal state, not contract data
    const { _uploadedPaths: preUploaded = {}, ...cleanData } = formData;

    // Temp file paths from pre-upload or direct upload
    const tempContractImg = preUploaded.contractImagePath || req.files?.contractImage?.[0]?.path || null;
    const tempChequeImg   = preUploaded.chequeImagePath   || req.files?.chequeImage?.[0]?.path   || null;
    const tempExtras      = preUploaded.extraImages || (req.files?.extraImages || []).map(f => ({ path: f.path, label: '' }));

    // 3. Generate contract number first (needed for folder name)
    const contractNumber = generateContractNumber(cleanData.store, cleanData.date);

    // Create contract folder and move files
    const contractFolder = path.join(__dirname, '../uploads/contracts', contractNumber);
    fs.mkdirSync(contractFolder, { recursive: true });

    function moveToContract(srcPath, destName) {
      if (!srcPath || !fs.existsSync(srcPath)) return srcPath || null;
      const ext = path.extname(srcPath) || '.jpg';
      const destPath = path.join(contractFolder, destName + ext);
      try { fs.renameSync(srcPath, destPath); return destPath; }
      catch(e) { console.error('[Move file error]', e.message); return srcPath; }
    }

    const contractImagePath = moveToContract(tempContractImg, 'contract');
    const chequeImagePath   = moveToContract(tempChequeImg,   'cheque');
    const extraImagePaths   = tempExtras.map((item, i) => {
      const src   = typeof item === 'string' ? item : item.path;
      const label = typeof item === 'object' ? (item.label || '') : '';
      const safe  = label.replace(/[^a-zA-Z0-9 -]/g,'').trim().replace(/\s+/g,'-').slice(0,30) || 'image';
      const newPath = moveToContract(src, `extra-${i+1}-${safe}`);
      return newPath ? { path: newPath, label } : null;
    }).filter(Boolean);

    // 4. Summary fields
    const cover       = summariseCover(details?.cover);
    const steps       = details?.steps?.type || '';
    const waterCare   = details?.waterCareSystem?.type || '';
    const accessories = summariseAccessories(details?.accessories);
    const paid        = extractPaid(payment);
    const pending     = payment?.duePriorToDelivery || '';
    const grandTotal  = costing?.grandTotal || '';
    const status      = initialStatus(product?.status);

    // 4. Insert contract
    const ins = db.prepare(`
      INSERT INTO contracts
        (contract_number,customer_id,store,date,delivery_date,salesman,
         product_status,status,serial_number,make,model,
         grand_total,paid_amount,due_prior,
         data,contract_image_path,cheque_image_path,extra_images)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      contractNumber, customerId,
      formData.store, formData.date, formData.deliveryDate, formData.salesman,
      product?.status, status, product?.serialNumber, product?.make, product?.model,
      grandTotal, paid, pending,
      JSON.stringify(cleanData),
      contractImagePath, chequeImagePath,
      extraImagePaths.length ? JSON.stringify(extraImagePaths) : null
    );

    const contractId = ins.lastInsertRowid;

    // 5. Auto-seed payments from contract form
    const pmEntries = [
      { method:'cheque',      sel:payment?.cheque?.selected,     amount:parseFloat(payment?.cheque?.amount||0),     chequeNum:payment?.cheque?.number,        notes:'Cheque #'+(payment?.cheque?.number||'').trim() },
      { method:'cash',        sel:payment?.cash?.selected,       amount:parseFloat(payment?.cash?.amount||0),       chequeNum:null,                            notes:'Cash' },
      { method:'credit_card', sel:payment?.creditCard?.selected, amount:parseFloat(payment?.creditCard?.amount||0), chequeNum:null,                            notes:'Card ending '+(payment?.creditCard?.lastFour||'') },
      { method:'finance',     sel:payment?.finance?.selected,    amount:parseFloat(payment?.finance?.amount||0),    chequeNum:null,                            notes:payment?.finance?.plan||'Finance' },
    ];
    const today = new Date().toISOString().slice(0,10);
    let totalSeeded = 0;
    for (const pm of pmEntries) {
      if (pm.sel && pm.amount > 0) {
        db.prepare('INSERT INTO payments (contract_id,amount,method,cheque_number,date,notes,recorded_by) VALUES (?,?,?,?,?,?,?)')
          .run(contractId, pm.amount, pm.method, pm.chequeNum||null, today, pm.notes, req.session?.username||'system');
        totalSeeded += pm.amount;
      }
    }
    // Update balance = grand_total - total_seeded
    const grandTotalNum = parseFloat(costing?.grandTotal||0);
    const dueBalance    = Math.max(0, grandTotalNum - totalSeeded);
    db.prepare('UPDATE contracts SET due_prior=? WHERE id=?').run(String(dueBalance), contractId);

    // 6. Auto-deliver if delivery date is in the past
    // Compare as plain YYYY-MM-DD strings (lexicographic order == chronological order for ISO dates) —
    // avoids new Date(dateOnlyStr) being parsed as UTC while new Date().toDateString() parses as server-local.
    const deliveryDateVal = cleanData.deliveryDate;
    const todayPhoenix    = new Date(Date.now() - 7 * 3600000).toISOString().slice(0,10);
    const isAutoDeliver = deliveryDateVal && deliveryDateVal < todayPhoenix;
    if (isAutoDeliver) {
      db.prepare('UPDATE contracts SET status=? WHERE id=?').run('delivered', contractId);
    }

    // 7. Google Sheets write-back (non-fatal)
    const driveRow = {
      contractNumber: contractNumber,
      contractDate:   cleanData.date || '',
      make: product?.make || '', model: product?.model || '', year: product?.year || '',
      shellColor: product?.shellColor || '', cabinetColor: product?.cabinetColor || '',
      serialNumber: product?.serialNumber || '',
      salesman: cleanData.salesman || '',
      customerName: customer.name || '',
      address: customer.address + (customer.city ? ', ' + customer.city : ''),
      zip: customer.zip || '',
      cover, steps, waterCare, accessories, paid, pending,
    };
    try {
      if (isAutoDeliver) {
        // Write directly to Delivered tab
        await writeToDelivered(driveRow, deliveryDateVal);
        if (product?.status === 'instock' && product?.serialNumber) {
          await deleteInventoryRow(product.serialNumber);
        }
      } else if (product?.status === 'instock') {
        await writeToAssigned(driveRow);
        if (product?.serialNumber) {
          await deleteInventoryRow(product.serialNumber);
        }
      } else {
        await writeToTBO(driveRow);
      }
    } catch (driveErr) {
      console.error('[Drive write failed — non-fatal]', driveErr.message);
    }

    // Activity log
    const actor = req.session.username || 'system';
    const cnum  = contractNumber;
    const isNew = !req.body.contractId;
    logActivity(db, {
      contractId, contractNum: cnum,
      eventType: isNew ? 'CONTRACT_CREATED' : 'CONTRACT_UPDATED',
      actor,
      detail: isNew
        ? `${customer.name||''}, $${Math.round(cleanData.costing?.grandTotal||0)} (${cleanData.store||''})`
        : `Contract updated`
    });
    if (isNew) {
      addNotification(db, {
        contractId, contractNum: cnum,
        eventType: 'CONTRACT_CREATED', color: 'green',
        message: `${cnum} — New contract by ${cleanData.salesman||actor} for ${customer.name||''}`
      });
    }

    res.json({ success: true, contractId, contractNumber });

  } catch (err) {
    console.error('Contract save error:', err);
    res.status(500).json({ error: 'Failed to save contract', detail: err.message });
  }
});


// ── Build driveData from contract + customer ──────────────────────────────────
function buildDriveData(contract, customer, formData) {
  const d  = formData || JSON.parse(contract.data || '{}');
  const de = d.details || {};
  const pa = d.payment || {};
  function sumCover(cover) {
    if (!cover) return '';
    const parts = [];
    if (cover.coverType && cover.coverType.length) parts.push(cover.coverType.join('/'));
    if (cover.brand) parts.push(cover.brand);
    if (cover.lift && cover.lift !== 'none') parts.push(cover.lift);
    return parts.join(', ');
  }
  function extractPaidLocal(payment) {
    if (!payment) return '';
    if (payment.cheque && payment.cheque.selected) return payment.cheque.amount || '';
    if (payment.cash && payment.cash.selected) return payment.cash.amount || '';
    if (payment.creditCard && payment.creditCard.selected) return 'CC';
    if (payment.finance && payment.finance.selected) return payment.finance.amount || '';
    return '';
  }
  const cu = d.customer || {};
  return {
    contractNumber: contract.contract_number,
    contractDate:   contract.date || d.date || '',
    make:           contract.make || '',
    model:          contract.model || '',
    year:           d.product ? d.product.year || '' : '',
    shellColor:     d.product ? d.product.shellColor || '' : '',
    cabinetColor:   d.product ? d.product.cabinetColor || '' : '',
    serialNumber:   contract.serial_number || '',
    salesman:       contract.salesman || '',
    customerName:   customer ? customer.name : (cu.name || ''),
    address:        customer ? (customer.address||'') + (customer.city ? ', '+customer.city : '') : (cu.address||''),
    zip:            customer ? customer.zip || '' : cu.zip || '',
    cover:          sumCover(de.cover),
    steps:          de.steps ? de.steps.type || '' : '',
    waterCare:      de.waterCareSystem ? de.waterCareSystem.type || '' : '',
    accessories:    de.accessories ? [...(de.accessories.items||[]), de.accessories.other||''].filter(Boolean).join(', ') : '',
    paid:           extractPaidLocal(pa),
    pending:        pa.duePriorToDelivery || '',
  };
}

// ── Update status ─────────────────────────────────────────────────────────────
router.patch('/:id/status', requireRole(['admin','sales']), async (req, res) => {
  const VALID = ['assigned','tbo','scheduled','delivered','cancelled','received'];
  const { status, deliveryDate, scheduledDatetime, scheduledDuration } = req.body;
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (req.session.role === 'sales' && status !== 'scheduled') {
    return res.status(403).json({ error: 'Forbidden — only scheduling is allowed for this role' });
  }

  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Not found' });

    // Block In Stock → Received
    if (status === 'received' && contract.product_status === 'instock') {
      return res.status(400).json({ error: 'In Stock contracts do not go through Received. Change to Scheduled or Delivered directly.' });
    }

    // Block scheduling if balance > 0
    if (status === 'scheduled') {
      const totalPaidRow = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(req.params.id);
      const totalPaidAmt = totalPaidRow.t || 0;
      const gtNum = parseFloat(contract.grand_total || 0);
      const balance = gtNum - totalPaidAmt;
      if (balance > 0) {
        return res.status(400).json({
          error: 'Balance of $' + Math.round(balance).toLocaleString() + ' must be cleared before scheduling.'
        });
      }
    }

    // Block Delivered → anything (terminal status)
    if (contract.status === 'delivered') {
      return res.status(400).json({ error: 'Delivered contracts cannot be changed. This status is final.' });
    }

    // Serial number required for Delivered
    if (status === 'delivered' && !contract.serial_number) {
      return res.status(400).json({ error: 'Serial number required before marking as Delivered. Use Assign SI. No first.' });
    }

    // Serial number required before Scheduling (can't acknowledge delivery without one)
    if (status === 'scheduled' && !contract.serial_number) {
      return res.status(400).json({ error: 'Serial number required before scheduling. Use Assign SI. No first.' });
    }

    // Scheduled requires datetime
    if (status === 'scheduled' && !scheduledDatetime) {
      return res.status(400).json({ error: 'Schedule date and time is required.' });
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(contract.customer_id);
    const driveData = buildDriveData(contract, customer, null);
    const today = new Date().toISOString().slice(0,10);

    // Update SQLite
    if (status === 'scheduled') {
      const duration = parseInt(scheduledDuration) || 120;
      const teamVal  = req.body.deliveryTeam || null;

      // Team capacity check — one booking per team per overlapping window
      if (teamVal) {
        const startMs = new Date(scheduledDatetime + '-07:00').getTime();
        const endMs   = startMs + duration * 60000;
        const conflicts = db.prepare(
          "SELECT id,contract_number,scheduled_datetime,scheduled_duration FROM contracts " +
          "WHERE delivery_team=? AND status='scheduled' AND id!=? AND scheduled_datetime IS NOT NULL"
        ).all(teamVal, req.params.id);
        for (const ex of conflicts) {
          const exStart = new Date(ex.scheduled_datetime + '-07:00').getTime();
          const exEnd   = exStart + (ex.scheduled_duration||120)*60000;
          if (startMs < exEnd && endMs > exStart) {
            const teamLabel = teamVal==='team_a'?'JV Spa Movers':'Clear Choice Movers';
            return res.status(400).json({
              error: teamLabel+' is already booked at this time ('+ex.contract_number+'). Choose a different slot or team.'
            });
          }
        }
      }

      db.prepare('UPDATE contracts SET status=?,scheduled_datetime=?,scheduled_duration=?,delivery_team=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(status, scheduledDatetime, duration, teamVal, req.params.id);
    } else if (status === 'delivered') {
      const actualDelivery = deliveryDate || today;
      db.prepare('UPDATE contracts SET status=?,delivery_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(status, actualDelivery, req.params.id);
    } else if (status === 'cancelled') {
      db.prepare('UPDATE contracts SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(status, req.params.id);
    } else {
      // assigned — revert from cancelled
      db.prepare('UPDATE contracts SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(status, req.params.id);
    }

    // Google Sheets operations (non-fatal)
    try {
      if (status === 'scheduled') {
        if (contract.status === 'received') {
          await moveFromReceivedToScheduled(contract.contract_number, scheduledDatetime, driveData);
        } else {
          await updateToScheduled(contract.contract_number, scheduledDatetime, driveData);
        }
        // Google Calendar: create new event or update existing
        const updatedContract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
        const calData = JSON.parse(updatedContract.data || '{}');
        if (contract.calendar_event_id) {
          try { await updateCalendarEvent(contract.calendar_event_id, updatedContract, calData); } catch(e) { console.error('[Calendar update failed]', e.message); }
        } else {
          try {
            const eventId = await createCalendarEvent(updatedContract, calData);
            if (eventId) db.prepare('UPDATE contracts SET calendar_event_id=? WHERE id=?').run(eventId, req.params.id);
          } catch(e) { console.error('[Calendar create failed]', e.message); }
        }
      } else if (status === 'delivered') {
        const actualDelivery = deliveryDate || today;
        driveData.serialNumber = contract.serial_number || '';
        if (contract.status === 'received') {
          await moveFromReceivedToDelivered(contract.contract_number, actualDelivery, driveData);
        } else {
          await moveToDelivered(contract.contract_number, actualDelivery, driveData);
        }
        // Delete calendar event on delivery
        if (contract.calendar_event_id) {
          try { await deleteCalendarEvent(contract.calendar_event_id); db.prepare('UPDATE contracts SET calendar_event_id=NULL WHERE id=?').run(req.params.id); } catch(e) { console.error('[Calendar delete on deliver failed]', e.message); }
        }
      } else if (status === 'cancelled') {
        if (contract.status === 'received') {
          await moveFromReceivedToCancelled(contract.contract_number, today, driveData);
        } else {
          await moveToCancelled(contract.contract_number, today, driveData);
        }
        // Delete calendar event on cancel
        if (contract.calendar_event_id) {
          try { await deleteCalendarEvent(contract.calendar_event_id); db.prepare('UPDATE contracts SET calendar_event_id=NULL WHERE id=?').run(req.params.id); } catch(e) { console.error('[Calendar delete failed]', e.message); }
        }
      } else if (status === 'assigned') {
        await revertToAssigned(contract.contract_number, driveData);
      }
    } catch(e) { console.error('[Drive status update failed]', e.message, e.stack); }

    // Activity log + notifications
    const _actor  = req.session.username || 'system';
    const _cnum   = contract.contract_number;
    const _cuname = (() => { try { return JSON.parse(contract.data||'{}').customer?.name || ''; } catch(e){ return ''; } })();
    if (status === 'scheduled') {
      const _team  = req.body.deliveryTeam==='team_a'?'JV Spa Movers':'Clear Choice Movers';
      const _slot  = scheduledDatetime ? new Date(scheduledDatetime + '-07:00').toLocaleString('en-US',{timeZone:'America/Phoenix',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
      logActivity(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'SCHEDULED',
        actor: _actor, detail: `Team: ${_team} | Slot: ${_slot}` });
      addNotification(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'SCHEDULED',
        color: 'green', message: `${_cnum} — ${_cuname} scheduled for ${_slot} (${_team})` });
    } else if (status === 'delivered') {
      logActivity(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'STATUS_CHANGED',
        actor: _actor, detail: `${contract.status} → delivered` });
      addNotification(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'DELIVERED',
        color: 'green', message: `${_cnum} — ${_cuname} marked delivered` });
    } else if (status === 'received') {
      logActivity(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'MARK_RECEIVED',
        actor: _actor, detail: `${contract.status} → received` });
      addNotification(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'RECEIVED',
        color: 'green', message: `${_cnum} — ${_cuname} marked received` });
    } else {
      logActivity(db, { contractId: req.params.id, contractNum: _cnum, eventType: 'STATUS_CHANGED',
        actor: _actor, detail: `${contract.status} → ${status}` });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── Assign serial number ───────────────────────────────────────────────────────
router.patch('/:id/serial', requireAdmin, async (req, res) => {
  const { serialNumber } = req.body;
  if (!serialNumber || !serialNumber.trim()) {
    return res.status(400).json({ error: 'Serial number is required' });
  }
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Not found' });

    // Update data JSON
    const data = JSON.parse(contract.data || '{}');
    if (data.product) data.product.serialNumber = serialNumber.trim();

    db.prepare('UPDATE contracts SET serial_number=?,data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(serialNumber.trim(), JSON.stringify(data), req.params.id);

    // Update sheet (non-fatal)
    try {
      await updateTBOSerial(contract.contract_number, serialNumber.trim());
    } catch(e) { console.error('[Drive serial update failed]', e.message, e.stack); }

    res.json({ success: true });
  } catch(err) {
    console.error('Serial update error:', err);
    res.status(500).json({ error: 'Failed to update serial number' });
  }
});

// ── Mark as Received (TBO only) — requires serial + photo ────────────────────
router.post('/:id/received', requireRole(['admin','sales']), (req, res) => {
  uploadSerial(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    const { serialNumber, receivedDate } = req.body;
    if (!serialNumber || !serialNumber.trim()) return res.status(400).json({ error: 'Serial number is required' });
    if (!req.file) return res.status(400).json({ error: 'Serial number photo is required' });
    try {
      const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
      if (!contract) return res.status(404).json({ error: 'Not found' });
      if (contract.product_status === 'instock') {
        return res.status(400).json({ error: 'In Stock contracts do not go through Received. Change to Scheduled or Delivered directly.' });
      }
      // Move serial photo to contract folder
      const contractFolder = path.join(__dirname, '../uploads/contracts', contract.contract_number);
      fs.mkdirSync(contractFolder, { recursive: true });
      const ext = path.extname(req.file.originalname) || '.jpg';
      const serialPhotoPath = path.join(contractFolder, 'serial-photo' + ext);
      try { fs.renameSync(req.file.path, serialPhotoPath); } catch(e) { /* keep original */ }
      let finalPhotoPath = fs.existsSync(serialPhotoPath) ? serialPhotoPath : req.file.path;
      // Compress serial photo
      const compResult = await compressAndGate(finalPhotoPath);
      if (compResult.path) finalPhotoPath = compResult.path;
      // Update contract data JSON
      const data = JSON.parse(contract.data || '{}');
      if (data.product) data.product.serialNumber = serialNumber.trim();
      // Add serial photo to images (at front, remove old serial photo if exists)
      const existing = contract.extra_images ? JSON.parse(contract.extra_images) : [];
      const filtered = existing.filter(i => { const p = typeof i==='string'?i:i.path; return !p.includes('serial-photo'); });
      filtered.unshift({ path: finalPhotoPath, label: 'Serial Number Photo' });
      const actualDate = receivedDate || new Date().toISOString().slice(0,10);
      db.prepare('UPDATE contracts SET status=?,serial_number=?,data=?,extra_images=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run('received', serialNumber.trim(), JSON.stringify(data), JSON.stringify(filtered), req.params.id);
      // Google Sheets (non-fatal)
      try {
        const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(contract.customer_id);
        const driveData = buildDriveData(contract, customer, null);
        driveData.serialNumber = serialNumber.trim();
        const photoUrl = 'https://app.deserthottubsaz.com' + (toUrlPath(finalPhotoPath)||'');
        await moveToReceived(contract.contract_number, actualDate, photoUrl, driveData);
      } catch(e) { console.error('[Drive received failed]', e.message, e.stack); }
      res.json({ success: true });
    } catch(err) {
      console.error('Received error:', err);
      res.status(500).json({ error: 'Failed to mark as received' });
    }
  });
});

// ── Delete contract ───────────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Remove files
    [row.contract_image_path, row.cheque_image_path].forEach(p => { if(p && fs.existsSync(p)) fs.unlinkSync(p); });
    if (row.extra_images) {
      JSON.parse(row.extra_images).forEach(p => { if(p && fs.existsSync(p)) fs.unlinkSync(p); });
    }
    db.prepare('DELETE FROM payments WHERE contract_id=?').run(req.params.id);
    db.prepare('DELETE FROM contracts WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contract' });
  }
});

// ── PDF download — cached to contract folder ─────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  try {
    const row = db.prepare(`
      SELECT c.*, cu.name AS customer_name
      FROM contracts c LEFT JOIN customers cu ON c.customer_id=cu.id
      WHERE c.id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const custName  = (JSON.parse(row.data || '{}').customer?.name) || row.customer_name || 'Customer';
    const safeName  = custName.replace(/[^a-zA-Z0-9 -]/g,'').trim().replace(/\s+/g,'-').slice(0,30) || 'Customer';
    const pdfFilename = safeName + '-' + row.contract_number + '.pdf';

    // Serve cached PDF if it exists
    const pdfDir  = path.join(__dirname, '../uploads/contracts', row.contract_number);
    const pdfPath = path.join(pdfDir, 'contract.pdf');
    if (fs.existsSync(pdfPath)) {
      const buf = fs.readFileSync(pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + pdfFilename + '"');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    // Generate, cache, then serve
    const pdfBuffer = await generateContractPDF({ ...row, data: JSON.parse(row.data) });
    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(pdfPath, buf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + pdfFilename + '"');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ── Add image to existing contract — saves to contract folder ────────────────
router.post('/:id/images', (req, res) => {
  uploadSingle(req, res, err => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    if (!req.file)  return res.status(400).json({ error: 'No image provided' });

    const label = (req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Image label is required' });

    // Move to contract folder
    const contractFolder = path.join(__dirname, '../uploads/contracts', contract.contract_number);
    fs.mkdirSync(contractFolder, { recursive: true });
    const existing = contract.extra_images ? JSON.parse(contract.extra_images) : [];
    const safe     = label.replace(/[^a-zA-Z0-9 -]/g,'').trim().replace(/\s+/g,'-').slice(0,30) || 'image';
    const ext      = path.extname(req.file.originalname) || path.extname(req.file.path) || '.jpg';
    const destPath = path.join(contractFolder, `extra-${existing.length+1}-${safe}${ext}`);
    try { fs.renameSync(req.file.path, destPath); } catch(e) { /* keep original path */ }
    const finalPath = fs.existsSync(destPath) ? destPath : req.file.path;

    existing.push({ path: finalPath, label });
    db.prepare('UPDATE contracts SET extra_images = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(existing), req.params.id);

    res.json({ success: true, url: toUrlPath(finalPath), label });
  });
});

module.exports = router;
