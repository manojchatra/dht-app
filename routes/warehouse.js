/**
 * warehouse.js — Stage 5: Warehouse role
 * Narrow, receiving-focused view of Order-Placed contracts (no pricing/
 * payment data exposed here — see routes/contracts.js for the full view
 * admin/sales use). Also the two-photo "mark received" flow, separate
 * from the existing single-photo POST /api/contracts/:id/received so
 * that flow (used by admin from the status board) isn't
 * touched.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db/database');
const { compressAndGate } = require('../utils/imageUtils');
const { requireRole } = require('../middleware/auth');
const { moveToReceived } = require('../services/driveInventory');
const { withLock } = require('../utils/asyncLock');
const { logActivity, addNotification } = require('../utils/activityLogger');
const { notifyReceived } = require('../utils/emailSender');
const { buildDriveData } = require('./contracts');
const { syncCustomerRecord } = require('../services/customers');
const { receiveSerialConflict, linkReceivedUnit, serialWas } = require('../services/orderedStock');
const { phoenixToday } = require('../utils/arizona');

router.use(requireRole(['admin', 'warehouse']));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/warehouse-tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadPhotos = upload.fields([
  { name: 'serialPhoto', maxCount: 1 },
  { name: 'skuPhoto',    maxCount: 1 },
]);

function toUrlPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  try {
    const uploadsDir = path.join(__dirname, '../uploads');
    const rel = path.relative(uploadsDir, absPath);
    if (rel.startsWith('..')) return null;
    return '/uploads/' + rel.replace(/\\/g, '/');
  } catch(e) { return null; }
}
function safeFolderName(s) {
  return String(s||'').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}
async function finalizePhoto(tmpFile, serialNumber, label) {
  if (!tmpFile) return null;
  const dir = path.join(__dirname, '../uploads/inventory', safeFolderName(serialNumber));
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(tmpFile.originalname) || '.jpg';
  const dest = path.join(dir, label + ext);
  try { fs.renameSync(tmpFile.path, dest); } catch(e) { /* keep original path */ }
  let finalPath = fs.existsSync(dest) ? dest : tmpFile.path;
  const compResult = await compressAndGate(finalPath);
  if (compResult.path) finalPath = compResult.path;
  return finalPath;
}

// ── GET /queue — everything awaiting receipt: Order-Placed contracts (narrow
// fields only) plus Ordered general-stock inventory items, merged into one
// list so warehouse has a single place to check. Each row is tagged `type`
// so the frontend routes to the right receive flow (photos required for a
// customer-linked contract, not for general stock).
router.get('/queue', (req, res) => {
  try {
    const contractRows = db.prepare(`
      SELECT c.id, c.contract_number, c.make, c.model, c.web_order_number, c.truck_number,
        json_extract(c.data,'$.product.shellColor')   AS shell_color,
        json_extract(c.data,'$.product.cabinetColor') AS cabinet_color,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.status = 'order_placed'
      ORDER BY c.created_at DESC
    `).all().map(r => ({ ...r, type: 'contract' }));

    const inventoryRows = db.prepare(`
      SELECT id, make, model, shell_color, cabinet_color, web_order_number, truck_number
      FROM inventory
      WHERE availability = 'Ordered' AND contract_id IS NULL  -- reserved stock shows as its contract's row
      ORDER BY created_at DESC
    `).all().map(r => ({ ...r, type: 'inventory', customer_name: '' }));

    res.json([...contractRows, ...inventoryRows]);
  } catch (err) {
    console.error('Warehouse queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

// ── GET /received — spas marked received (the Received tab) ──────────────────
// Every inventory spa with a received date (Mark Received, for a contract or
// general on-order stock), newest first. A spa tied to a contract — reserved
// before it came, or sold from stock later — carries the customer and
// contract number; only admin gets the contract id (the View contract link).
router.get('/received', (req, res) => {
  try {
    const isAdmin = req.session.role === 'admin';
    const rows = db.prepare(`
      SELECT i.id, i.make, i.series, i.model, i.shell_color, i.cabinet_color, i.serial_number, i.availability,
        i.web_order_number, i.truck_number, i.received_at,
        c.id AS contract_id, c.contract_number,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name
      FROM inventory i
      LEFT JOIN contracts c ON c.id = i.contract_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE COALESCE(i.received_at,'') <> ''
      ORDER BY i.received_at DESC, i.id DESC
    `).all();
    res.json(rows.map(r => ({ ...r, contract_id: isAdmin ? r.contract_id : null, customer_name: r.contract_number ? r.customer_name : '' })));
  } catch (err) {
    console.error('Warehouse received list error:', err);
    res.status(500).json({ error: 'Failed to load received spas' });
  }
});

// ── POST /:id/receive — two-photo mark-received, creates/links an inventory row ─
router.post('/:id/receive', (req, res) => {
  uploadPhotos(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    const { serialNumber, skuNumber, receivedDate } = req.body;
    if (!serialNumber || !serialNumber.trim()) return res.status(400).json({ error: 'Serial number is required' });
    if (!req.files?.serialPhoto?.[0]) return res.status(400).json({ error: 'Serial number photo is required' });
    if (!req.files?.skuPhoto?.[0])    return res.status(400).json({ error: 'SKU barcode photo is required' });

    try {
      // One receive at a time per contract (same lock as status changes and
      // edits): a double-tap's second request then finds it already Received.
      return await withLock('contract-status:' + req.params.id, async () => {
      const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
      if (!contract) return res.status(404).json({ error: 'Not found' });
      if (contract.status !== 'order_placed') {
        return res.status(400).json({ error: contract.status === 'received'
          ? `${contract.contract_number} is already received.` : 'Only Order Placed contracts can be marked received here.' });
      }

      const serial = serialNumber.trim();
      const sku    = (skuNumber || '').trim();
      const serialClash = receiveSerialConflict(db, contract.id, serial);
      if (serialClash) return res.status(409).json({ error: serialClash });
      const serialPhotoPath = await finalizePhoto(req.files.serialPhoto[0], serial, 'serial-photo');
      const skuPhotoPath    = await finalizePhoto(req.files.skuPhoto[0],    serial, 'sku-photo');
      const actualDate = receivedDate || phoenixToday();

      // Update contract: status, serial number, and extra_images (matches the
      // existing single-photo flow's convention so contract-detail.html's
      // "Serial Number Photo" display keeps working unchanged).
      const data = JSON.parse(contract.data || '{}');
      if (data.product) data.product.serialNumber = serial;
      const existingImages = contract.extra_images ? JSON.parse(contract.extra_images) : [];
      const filteredImages = existingImages.filter(i => { const p = typeof i==='string'?i:i.path; return !p.includes('serial-photo'); });
      filteredImages.unshift({ path: serialPhotoPath, label: 'Serial Number Photo' });

      db.prepare('UPDATE contracts SET status=?,serial_number=?,data=?,extra_images=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run('received', serial, JSON.stringify(data), JSON.stringify(filteredImages), req.params.id);

      // The spa in inventory: the reserved on-order unit gets the serial, or an
      // inventory spa with it is linked, or a new unit is added (Sold) — with
      // the Inventory Items Sheet row (services/orderedStock.js).
      await linkReceivedUnit(db, contract, { serial, sku, skuPhotoPath, serialPhotoPath,
        addedBy: req.session.username || 'system', addedDate: actualDate });

      // Google Sheets (non-fatal): move the contract's row to Received.
      try {
        const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(contract.customer_id);
        const driveData = buildDriveData(contract, customer, null);
        driveData.serialNumber = serial;
        const photoUrl = 'https://app.deserthottubsaz.com' + (toUrlPath(serialPhotoPath) || '');
        await moveToReceived(contract.contract_number, actualDate, photoUrl, driveData);
      } catch(e) { console.error('[Drive warehouse-received failed — non-fatal]', e.message); }
      await syncCustomerRecord(req.params.id);

      logActivity(db, { contractId: req.params.id, contractNum: contract.contract_number, eventType: 'MARK_RECEIVED',
        actor: req.session.username || 'warehouse', detail: 'order_placed → received (warehouse)' + serialWas(contract, serial) });
      const custName = (() => { try { return JSON.parse(contract.data||'{}').customer?.name || ''; } catch(e){ return ''; } })();
      addNotification(db, { contractId: req.params.id, contractNum: contract.contract_number, eventType: 'RECEIVED',
        color: 'green', message: `${contract.contract_number} — ${custName} marked received` });
      try {
        const freshContract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
        await notifyReceived({ contract: freshContract, customerName: custName });
      } catch (e) { console.error('[Email notify RECEIVED failed — non-fatal]', e.message); }

      res.json({ success: true });
      }); // end withLock
    } catch (err) {
      console.error('Warehouse receive error:', err);
      res.status(500).json({ error: 'Failed to mark as received' });
    }
  });
});

module.exports = router;
