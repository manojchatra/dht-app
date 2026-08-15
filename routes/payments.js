const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const db      = require('../db/database');
const { generateReceiptPDF } = require('../utils/receiptGenerator');
const { logActivity, addNotification } = require('../utils/activityLogger');

// ── Record payment ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { contractId, amount, method, chequeNumber, date, notes } = req.body;
    if (!contractId || !amount || !method) {
      return res.status(400).json({ error: 'contractId, amount and method are required' });
    }

    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    const totalPaidBefore = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(contractId).t;
    const grandTotalCheck = parseFloat(JSON.parse(contract.data)?.costing?.grandTotal || 0);
    const balanceBefore   = Math.max(0, grandTotalCheck - totalPaidBefore);
    if (amt > balanceBefore + 0.01) {
      return res.status(400).json({ error: `Amount exceeds remaining balance of $${balanceBefore.toFixed(2)}` });
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

    const paymentId = ins.lastInsertRowid;

    // Save receipt PDF to contract folder (non-fatal)
    try {
      const { generateReceiptPDF } = require('../utils/receiptGenerator');
      const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
      const pdfBuf  = await generateReceiptPDF({ payment, contract, totalPaid, balance: newBalance });
      const buf     = Buffer.isBuffer(pdfBuf) ? pdfBuf : Buffer.from(pdfBuf);
      const pdfDir  = path.join(__dirname, '../uploads/contracts', contract.contract_number);
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, `receipt-${paymentId}.pdf`), buf);
    } catch(e) { console.error('[Receipt save failed — non-fatal]', e.message); }

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
    const pdfDir  = path.join(__dirname, '../uploads/contracts', contract.contract_number);
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
