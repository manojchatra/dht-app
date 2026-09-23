/**
 * delivery.js — Routes for delivery team role
 * GET  /api/delivery-contract/:id  — stripped contract (no pricing)
 * POST /api/acknowledgement/:id    — save acknowledgement + mark delivered + generate PDF
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const router  = express.Router();
const { compressAndGate } = require('../utils/imageUtils');
const { logActivity, addNotification } = require('../utils/activityLogger');
const db      = require('../db/database');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');
function toUrlPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  try {
    const rel = path.relative(UPLOADS_DIR, absPath);
    if (rel.startsWith('..')) return null;
    return '/uploads/' + rel.replace(/\\/g, '/');
  } catch(e) { return null; }
}

// Get email recipients from settings
function getEmailRecipients() {
  try {
    const rows = db.prepare("SELECT value FROM settings WHERE key='email_recipients'").get();
    return rows ? JSON.parse(rows.value || '[]') : [];
  } catch(e) { return []; }
}
const { generateAcknowledgementPDF } = require('../utils/acknowledgementPDF');
const { sendAcknowledgementEmail, smtpConfigured } = require('../utils/emailSender');
const { moveToDelivered } = require('../services/driveInventory');
const { buildDriveData } = require('./contracts');

// Auth middleware — delivery or admin
function requireDeliveryOrAdmin(req, res, next) {
  if (!req.session?.username) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.session.username);
  if (!user || !['admin','delivery'].includes(user.role))
    return res.status(403).json({ error: 'Access denied' });
  req.currentUser = user;
  next();
}

// Multer for exception images (PNG/JPEG, max 2)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.fieldname + path.extname(file.originalname))
});
const uploadAck = multer({ storage, limits:{ fileSize: 5*1024*1024 } });

// Helper to build drive data
// ── GET /api/delivery-contract/:id — stripped view ─────────────────────────
router.get('/contract/:id', requireDeliveryOrAdmin, (req, res) => {
  try {
    const contract = db.prepare(`
      SELECT c.*, cu.name AS customer_name, cu.address, cu.city, cu.zip,
             cu.phone_cell, cu.phone_home, cu.gate_code
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.id=?
    `).get(req.params.id);

    if (!contract) return res.status(404).json({ error: 'Not found' });

    // Delivery role can only see their own team's contracts
    if (req.currentUser.role === 'delivery' &&
        contract.delivery_team && contract.delivery_team !== req.currentUser.team) {
      return res.status(403).json({ error: 'Not assigned to your team' });
    }

    const data = JSON.parse(contract.data || '{}');
    const pr   = data.product || {};
    const cu   = data.customer || {};
    const de   = data.details  || {};
    const sv   = data.service  || {};

    // Strip all pricing — only operational details
    res.json({
      id:              contract.id,
      contract_number: contract.contract_number,
      status:          contract.status,
      delivery_team:   contract.delivery_team,
      scheduled_datetime: contract.scheduled_datetime,
      scheduled_duration: contract.scheduled_duration,
      date:            contract.date,
      delivery_date:   contract.delivery_date,
      // Customer (no pricing)
      customer_name:   JSON.parse(contract.data||'{}').customer?.name || contract.customer_name || '',
      address:         (contract.address || cu.address || '') + (contract.city ? ', '+contract.city : cu.city ? ', '+cu.city : ''),
      zip:             contract.zip || cu.zip || '',
      phone:           contract.phone_cell || contract.phone_home || cu.phone?.cell || cu.phone?.home || '',
      email:           cu.email || '',
      gated:           cu.gated,
      gate_code:       contract.gate_code || cu.gateCode || '',
      // Product
      make:            contract.make || pr.make || '',
      model:           contract.model || pr.model || '',
      year:            pr.year || '',
      serial_number:   contract.serial_number || pr.serialNumber || '',
      shell_color:     pr.shellColor || '',
      cabinet_color:   pr.cabinetColor || '',
      cover_color:     pr.coverColor || '',
      // Line items (names only, no prices)
      water_care_system: de.waterCareSystem?.type || '',
      upgraded_water_care: [
        de.upgradedWaterCare?.autoDosing ? 'Auto Dosing' : '',
        de.upgradedWaterCare?.fwssIq    ? 'FWSS/IQ'    : '',
      ].filter(Boolean).join(' + '),
      steps_type:      de.steps?.type || '',
      cover_type:      [(de.cover?.coverType||[]).join('/'), de.cover?.brand, de.cover?.lift].filter(Boolean).join(' - '),
      in_town_delivery: sv.inTownDelivery,
      crane:           sv.crane,
      salesman:        contract.salesman,
      has_acknowledgement: !!contract.acknowledgement_pdf,
    });
  } catch(e) {
    console.error('[Delivery contract GET]', e.message);
    res.status(500).json({ error: 'Failed to load contract' });
  }
});

// ── GET /api/delivery/acknowledgements — scheduled + completed list ────────
// For delivery role, scoped to their own team; admin sees everything. Same
// "strip all pricing" rule as GET /contract/:id above — this only returns
// the fields acknowledgement-hub.html actually renders.
router.get('/acknowledgements', requireDeliveryOrAdmin, (req, res) => {
  try {
    const scopedToTeam = req.currentUser.role === 'delivery';
    const rows = db.prepare(`
      SELECT c.id, c.contract_number, c.store, c.serial_number, c.status,
        c.delivery_team, c.delivery_date, c.scheduled_datetime, c.scheduled_duration,
        c.acknowledgement_pdf,
        COALESCE(json_extract(c.data,'$.customer.name'), cu.name, '') AS customer_name,
        cu.address AS cu_address, cu.city AS cu_city
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.status IN ('scheduled','delivered')
        ${scopedToTeam ? 'AND c.delivery_team = ?' : ''}
      ORDER BY c.created_at DESC
    `).all(...(scopedToTeam ? [req.currentUser.team] : []));

    res.json(rows.map(r => ({
      ...r,
      address: (r.cu_address || '') + (r.cu_city ? ', ' + r.cu_city : ''),
      cu_address: undefined, cu_city: undefined,
      acknowledgement_pdf_url: r.acknowledgement_pdf ? toUrlPath(r.acknowledgement_pdf) : null,
      acknowledgement_pdf: undefined,
    })));
  } catch(e) {
    console.error('[Delivery acknowledgements list]', e.message);
    res.status(500).json({ error: 'Failed to load acknowledgements' });
  }
});

// ── POST /api/acknowledgement/:id — save + mark delivered ──────────────────
router.post('/acknowledgement/:id', requireDeliveryOrAdmin,
  uploadAck.fields([{ name:'exceptionImages', maxCount:2 }, { name:'deliveryPhotos', maxCount:5 }]),
  async (req, res) => {
    try {
      const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
      if (!contract) return res.status(404).json({ error: 'Not found' });

      const { customerNameTyped, deliveredBy, formDataJson } = req.body;
      if (!customerNameTyped?.trim()) return res.status(400).json({ error: 'Customer name is required' });
      if (!deliveredBy?.trim())       return res.status(400).json({ error: 'Delivered By is required' });

      const formData = JSON.parse(formDataJson || '{}');

      // Signature validation — must be non-blank base64 PNGs
      if (!formData.customerSig || formData.customerSig.length < 100)
        return res.status(400).json({ error: 'Customer signature is required' });
      if (!formData.teamSig || formData.teamSig.length < 100)
        return res.status(400).json({ error: 'Delivery team signature is required' });

      // Exceptions + images validation
      const exceptions = (formData.exceptions || '').trim();
      const exFiles = req.files?.exceptionImages || [];
      if (exceptions && exFiles.length === 0)
        return res.status(400).json({ error: 'At least 1 photo required when exceptions are noted' });

      // Contract folder
      const contractFolder = path.join(__dirname, '../uploads/contracts', contract.contract_number);
      fs.mkdirSync(contractFolder, { recursive: true });

      // Save signatures as PNG (uncompressed — preserve signature quality)
      const custSigPath = path.join(contractFolder, 'sig-customer.png');
      const teamSigPath = path.join(contractFolder, 'sig-team.png');
      const custBase64 = formData.customerSig.replace(/^data:image\/png;base64,/, '');
      const teamBase64 = formData.teamSig.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(custSigPath, Buffer.from(custBase64, 'base64'));
      fs.writeFileSync(teamSigPath, Buffer.from(teamBase64, 'base64'));

      // Save delivery photos (1 required, up to 5)
      const delivPhotoFiles = (req.files && req.files.deliveryPhotos) || [];
      const delivPhotoPaths = [];
      for (var dpi = 0; dpi < delivPhotoFiles.length; dpi++) {
        const dpf  = delivPhotoFiles[dpi];
        const dpExt = path.extname(dpf.originalname) || '.jpg';
        const dpDest = path.join(contractFolder, 'delivery-photo-' + (dpi+1) + dpExt);
        fs.renameSync(dpf.path, dpDest);
        const dpComp = await compressAndGate(dpDest);
        delivPhotoPaths.push(dpComp.path || dpDest);
      }

      // Save exception images — with compression
      const exImgPaths = await Promise.all((exFiles).map(async (f, i) => {
        const ext = path.extname(f.originalname) || '.jpg';
        const p   = path.join(contractFolder, `exception-${i+1}${ext}`);
        fs.renameSync(f.path, p);
        const comp = await compressAndGate(p);
        return comp.path || p;
      }));

      // Generate acknowledgement PDF
      const today     = new Date().toISOString().slice(0,10);
      const pdfName   = `acknowledgement-${today}.pdf`;
      const pdfPath   = path.join(contractFolder, pdfName);

      await generateAcknowledgementPDF({
        contract, formData, customerSigPath: custSigPath, teamSigPath,
        exImgPaths, customerNameTyped: customerNameTyped.trim(),
        deliveredBy: deliveredBy.trim(), outputPath: pdfPath
      });

      // Update contract — mark delivered, save ack PDF path
      db.prepare(`UPDATE contracts SET status='delivered', delivery_date=?,
        acknowledgement_pdf=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(today, pdfPath, contract.id);

      // Add PDF + exception images to extra_images
      const existing = contract.extra_images ? JSON.parse(contract.extra_images) : [];
      // Add delivery photos first
      delivPhotoPaths.forEach((p, i) => existing.unshift({ path:p, label:`Delivery Photo ${i+1}` }));
      existing.push({ path: pdfPath, label: 'Delivery Acknowledgement' });
      exImgPaths.forEach((p, i) => existing.push({ path:p, label:`Exception Photo ${i+1}` }));
      db.prepare('UPDATE contracts SET extra_images=? WHERE id=?')
        .run(JSON.stringify(existing), contract.id);

      // Google Sheets (non-fatal)
      try {
        const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(contract.customer_id);
        const driveData = buildDriveData(contract, customer);
        driveData.serialNumber = contract.serial_number || '';
        await moveToDelivered(contract.contract_number, today, driveData);
      } catch(e) { console.error('[Drive ack delivery failed]', e.message); }

      // Attempt email send if requested (non-fatal — deliver is already saved)
      const sendEmail  = req.body.sendEmail === 'true';
      let emailError = null;
      if (sendEmail) {
        try {
          // extraRecipients is the full recipient list the sender actually
          // chose in the checkbox modal (showRecipientModal/confirmSend in
          // acknowledgement.html already includes the customer in it when
          // their box is checked) — it must be used as-is, not added to.
          // This used to also unconditionally push the customer's email
          // regardless of extraRecipients, so unchecking "Customer" in the
          // UI never actually excluded them from being emailed.
          const recipients = (req.body.extraRecipients
            ? JSON.parse(req.body.extraRecipients)
            : getEmailRecipients()).filter(Boolean);
          if (recipients.length > 0) {
            await sendAcknowledgementEmail({ contract, pdfPath, recipients });
            console.log('[Email] Acknowledgement sent for', contract.contract_number);
          }
        } catch(e) {
          console.error('[Email send failed — non-fatal]', e.message);
          emailError = e.message;
        }
      }

      logActivity(db, { contractId: req.params.id, contractNum: contract.contract_number, eventType: 'ACK_SUBMITTED', actor: req.session.username||req.session.team||'delivery', detail: emailError ? 'Acknowledgement saved, email failed: '+emailError : 'Acknowledgement submitted' });
      addNotification(db, { contractId: req.params.id, contractNum: contract.contract_number, eventType: 'DELIVERED', color: 'green', message: contract.contract_number+' — marked delivered via acknowledgement' });
      res.json(emailError ? { success: true, pdfName, emailError } : { success: true, pdfName });
    } catch(e) {
      console.error('[Acknowledgement POST]', e.message, e.stack);
      res.status(500).json({ error: 'Failed to save acknowledgement: ' + e.message });
    }
  }
);

// ── GET /api/delivery/smtp-status — check SMTP configuration ─────────────────
router.get('/smtp-status', requireDeliveryOrAdmin, (req, res) => {
  res.json({ configured: smtpConfigured() });
});

// ── GET /api/delivery/email-recipients — get recipients for popup ─────────────
router.get('/email-recipients/:contractId', requireDeliveryOrAdmin, (req, res) => {
  const contract = db.prepare('SELECT data, salesman FROM contracts WHERE id=?').get(req.params.contractId);
  const custEmail = contract ? JSON.parse(contract.data||'{}').customer?.email : null;
  const settingsRecipients = getEmailRecipients();

  const adminEmails = db.prepare(
    "SELECT email FROM users WHERE role='admin' AND email IS NOT NULL AND email != ''"
  ).all().map(r => r.email);

  // Best-effort: salesman is still free text on contracts (until it's a real
  // FK to users), so match it against a sales user's name to find their email.
  let salesEmail = null;
  if (contract?.salesman) {
    const match = db.prepare(
      "SELECT email FROM users WHERE role='sales' AND email IS NOT NULL AND email != '' AND LOWER(TRIM(name)) = LOWER(TRIM(?))"
    ).get(contract.salesman);
    salesEmail = match?.email || null;
  }

  res.json({
    customerEmail:     custEmail || null,
    settingsRecipients,
    adminEmails,
    salesEmail,
    smtpConfigured:    smtpConfigured(),
  });
});

// ── POST /api/delivery/send-ack/:id — resend ack email (admin) ───────────────
router.post('/send-ack/:id', requireDeliveryOrAdmin, async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Not found' });
    if (!contract.acknowledgement_pdf || !require('fs').existsSync(contract.acknowledgement_pdf)) {
      return res.status(400).json({ error: 'No acknowledgement PDF on file for this contract' });
    }
    const { recipients } = req.body;
    if (!recipients || recipients.length === 0) return res.status(400).json({ error: 'No recipients specified' });
    await sendAcknowledgementEmail({ contract, pdfPath: contract.acknowledgement_pdf, recipients });
    res.json({ success: true });
  } catch(e) {
    console.error('[Send-ack error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
