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
function buildDriveData(contract, customer) {
  const d = JSON.parse(contract.data || '{}');
  const de = d.details || {};
  const pa = d.payment || {};
  const cu = d.customer || {};
  function sumCover(cover) {
    if (!cover) return '';
    const parts = [];
    if (cover.coverType&&cover.coverType.length) parts.push(cover.coverType.join('/'));
    if (cover.brand) parts.push(cover.brand);
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
  return {
    contractNumber: contract.contract_number,
    contractDate:   contract.date||'',
    make: contract.make||'', model: contract.model||'',
    year: d.product?.year||'', shellColor: d.product?.shellColor||'', cabinetColor: d.product?.cabinetColor||'',
    serialNumber: contract.serial_number||'',
    salesman: contract.salesman||'',
    customerName: customer?.name||cu.name||'',
    address: customer?.address||(cu.address||'')+(cu.city?', '+cu.city:''),
    zip: customer?.zip||cu.zip||'',
    cover: sumCover(de.cover), steps: de.steps?.type||'',
    waterCare: de.waterCareSystem?.type||'',
    accessories: de.accessories ? [...(de.accessories.items||[]), de.accessories.other||''].filter(Boolean).join(', ') : '',
    paid: extractPaidLocal(pa),
    pending: pa.duePriorToDelivery || '',
  };
}

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
      const recipients = [];
      let emailError = null;
      if (sendEmail) {
        try {
          const custEmail = JSON.parse(contract.data||'{}').customer?.email;
          if (custEmail) recipients.push(custEmail);
          const settingsRecipients = req.body.extraRecipients
            ? JSON.parse(req.body.extraRecipients)
            : getEmailRecipients();
          settingsRecipients.forEach(r => { if (r && !recipients.includes(r)) recipients.push(r); });
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
  const contract = db.prepare('SELECT data FROM contracts WHERE id=?').get(req.params.contractId);
  const custEmail = contract ? JSON.parse(contract.data||'{}').customer?.email : null;
  const settingsRecipients = getEmailRecipients();
  res.json({
    customerEmail:     custEmail || null,
    settingsRecipients,
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
