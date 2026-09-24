const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db/database');
const { compressAndGate } = require('../utils/imageUtils');
const { generateReceiptPDF } = require('../utils/receiptGenerator');
const { logActivity, addNotification } = require('../utils/activityLogger');
const { notifyPaymentRecorded } = require('../utils/emailSender');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

// Optional photo of the cheque, sent as multipart alongside the payment fields.
// Plain JSON requests (no photo) pass straight through multer untouched.
const chequeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, 'payment-tmp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + (path.extname(file.originalname) || '.jpg')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
}).single('chequePhoto');

function withChequePhoto(req, res, next) {
  chequeUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    next();
  });
}

// ── Record payment ────────────────────────────────────────────────────────────
router.post('/', withChequePhoto, async (req, res) => {
  // The upload lands in a temp folder before validation runs, so every early
  // exit has to throw it away.
  const discardUpload = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) { /* already gone */ } } };
  try {
    const { contractId, amount, method, chequeNumber, date, notes } = req.body;
    if (!contractId || !amount || !method) {
      discardUpload();
      return res.status(400).json({ error: 'contractId, amount and method are required' });
    }

    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      discardUpload();
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
    if (!contract) { discardUpload(); return res.status(404).json({ error: 'Contract not found' }); }

    const totalPaidBefore = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(contractId).t;
    const grandTotalCheck = parseFloat(JSON.parse(contract.data)?.costing?.grandTotal || 0);
    const balanceBefore   = Math.max(0, grandTotalCheck - totalPaidBefore);
    if (amt > balanceBefore + 0.01) {
      discardUpload();
      return res.status(400).json({ error: `Amount exceeds remaining balance of $${balanceBefore.toFixed(2)}` });
    }

    // Compress the cheque photo up front, so an oversized/unreadable one is
    // rejected before the payment is recorded rather than after. A photo sent
    // with a non-cheque method is simply ignored.
    let chequeTmpPath = null;
    if (req.file) {
      if (method !== 'cheque') {
        discardUpload();
      } else {
        const comp = await compressAndGate(req.file.path);
        if (comp.error || !comp.path) return res.status(400).json({ error: comp.error || 'Could not process the cheque photo' });
        chequeTmpPath = comp.path;
      }
    }

    // Insert payment
    const ins = db.prepare(`
      INSERT INTO payments (contract_id,amount,method,cheque_number,date,notes,recorded_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(contractId, amt, method, chequeNumber||null,
        date||new Date().toISOString().slice(0,10), notes||null, req.session.username);

    // Recalculate balance = grand_total - all payments recorded
    const totalPaid  = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(contractId).t;
    const grandTotal = parseFloat(JSON.parse(contract.data)?.costing?.grandTotal || 0);
    const newBalance = Math.max(0, grandTotal - totalPaid);

    db.prepare('UPDATE contracts SET due_prior=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(String(newBalance), contractId);

    // Sync updated Paid/Pending to Google Sheets (non-fatal)
    try {
      const { updatePaymentInSheet } = require('../services/driveInventory');
      await updatePaymentInSheet(contract.contract_number, totalPaid, newBalance);
    } catch(e) { console.error('[Drive payment update failed — non-fatal]', e.message); }

    const paymentId = ins.lastInsertRowid;

    // File the cheque photo next to the receipt as cheque-<paymentId>.jpg (non-fatal)
    let chequeImagePath = null;
    if (chequeTmpPath) {
      try {
        const photoDir = path.join(UPLOADS_DIR, 'contracts', contract.contract_number);
        fs.mkdirSync(photoDir, { recursive: true });
        chequeImagePath = path.join(photoDir, `cheque-${paymentId}.jpg`);
        fs.renameSync(chequeTmpPath, chequeImagePath);
        db.prepare('UPDATE payments SET cheque_image_path=? WHERE id=?').run(chequeImagePath, paymentId);
      } catch (e) {
        console.error('[Cheque photo save failed — non-fatal]', e.message);
        chequeImagePath = null;
      }
    }

    // Save receipt PDF to contract folder (non-fatal)
    let receiptPath = null;
    try {
      const { generateReceiptPDF } = require('../utils/receiptGenerator');
      const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
      const pdfBuf  = await generateReceiptPDF({ payment, contract, totalPaid, balance: newBalance });
      const buf     = Buffer.isBuffer(pdfBuf) ? pdfBuf : Buffer.from(pdfBuf);
      const pdfDir  = path.join(UPLOADS_DIR, 'contracts', contract.contract_number);
      fs.mkdirSync(pdfDir, { recursive: true });
      receiptPath = path.join(pdfDir, `receipt-${paymentId}.pdf`);
      fs.writeFileSync(receiptPath, buf);
    } catch(e) { console.error('[Receipt save failed — non-fatal]', e.message); }

    // Email notification: Admin, with the receipt PDF attached (non-fatal)
    try {
      const custName = (() => { try { return JSON.parse(contract.data||'{}').customer?.name || ''; } catch(e){ return ''; } })();
      await notifyPaymentRecorded({
        contract, customerName: custName, amount: amt, method,
        totalPaid, balance: newBalance, receiptPath, chequeImagePath
      });
    } catch (e) { console.error('[Email notify PAYMENT_RECORDED failed — non-fatal]', e.message); }

    // Activity log + notification
    const _pc = db.prepare('SELECT contract_number,data FROM contracts WHERE id=?').get(contractId);
    if (_pc) {
      const _amt = '$' + Math.round(amount).toLocaleString();
      logActivity(db, {
        contractId, contractNum: _pc.contract_number,
        eventType: 'PAYMENT_RECORDED', actor: req.session.username||'system',
        detail: `${_amt} via ${method}${chequeNumber?' (#'+chequeNumber+')':''}`
      });
      addNotification(db, {
        contractId, contractNum: _pc.contract_number,
        eventType: 'PAYMENT', color: 'green',
        message: `${_pc.contract_number} — Payment of ${_amt} recorded (${method})`
      });
    }

    res.json({
      success:    true,
      paymentId,
      totalPaid,
      newBalance,
      fullyPaid:  newBalance <= 0,
    });
  } catch (err) {
    discardUpload();
    console.error('Payment error:', err);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ── List payments for a contract ──────────────────────────────────────────────
router.get('/contract/:contractId', (req, res) => {
  try {
    const payments = db.prepare(
      'SELECT * FROM payments WHERE contract_id=? ORDER BY date,created_at'
    ).all(req.params.contractId);
    const totalPaid = payments.reduce((s,p) => s + p.amount, 0);
    res.json({ payments, totalPaid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ── Receipt PDF ───────────────────────────────────────────────────────────────
router.get('/:id/receipt', async (req, res) => {
  try {
    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const contract = db.prepare('SELECT c.*, cu.name AS customer_name FROM contracts c LEFT JOIN customers cu ON c.customer_id=cu.id WHERE c.id=?').get(payment.contract_id);

    // Serve cached receipt if it exists
    const pdfDir  = path.join(UPLOADS_DIR, 'contracts', contract.contract_number);
    const pdfPath = path.join(pdfDir, 'receipt-' + payment.id + '.pdf');
    if (fs.existsSync(pdfPath)) {
      const buf = fs.readFileSync(pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="receipt-' + contract.contract_number + '-' + payment.id + '.pdf"');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    // Generate, cache, then serve
    const totalPaid = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(payment.contract_id).t;
    const balance   = parseFloat(contract.due_prior || 0);
    const pdfBuffer = await generateReceiptPDF({ payment, contract, totalPaid, balance });
    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(pdfPath, buf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="receipt-' + contract.contract_number + '-' + payment.id + '.pdf"');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    console.error('Receipt PDF error:', err);
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

module.exports = router;
