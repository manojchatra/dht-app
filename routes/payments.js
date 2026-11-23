const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db/database');
const { compressAndGate } = require('../utils/imageUtils');
const { generateReceiptPDF } = require('../utils/receiptGenerator');
const { logActivity, addNotification } = require('../utils/activityLogger');
const { notifyPaymentRecorded, notifyCashPending, notifyCashDecision } = require('../utils/emailSender');
const { withLock } = require('../utils/asyncLock');
const { requireRole, requireAdmin } = require('../middleware/auth');
const { phoenixToday } = require('../utils/arizona');
const { totalPaid: paidTotal, paidThrough, pendingTotal } = require('../utils/paymentTotals');
// "Ana Ruiz" for the logged-in user (falls back to the username).
const salesName = req => (db.prepare('SELECT name FROM users WHERE id=?').get(req.session.userId) || {}).name || req.session.username || '';
const { moneyOk } = require('../utils/money');

// Payment data is financial/customer data — only admin and sales have any
// business reason to see it. Ownership (which salesman) is checked per
// route below, same pattern as routes/contracts.js.
router.use(requireRole(['admin', 'sales']));

// Returns the same success shape as a fresh insert, for an idempotency-key
// hit — re-derives totals live rather than trusting anything cached.
function existingPaymentResponse(paymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  const totalPaid = paidTotal(db, payment.contract_id);
  const contract = db.prepare('SELECT data FROM contracts WHERE id=?').get(payment.contract_id);
  const grandTotal = parseFloat(JSON.parse(contract.data)?.costing?.grandTotal || 0);
  const newBalance = Math.max(0, grandTotal - totalPaid);
  return { success: true, paymentId, totalPaid, newBalance, fullyPaid: newBalance <= 0, pending: payment.approval === 'pending' };
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

// Builds a payment's receipt PDF and saves it in the contract folder as
// receipt-<id>.pdf. Totals are as of that payment (not today's), and the
// customer name comes from the customer record (or the contract form).
async function buildReceipt(paymentId) {
  const payment  = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  const contract = db.prepare('SELECT c.*, cu.name AS customer_name FROM contracts c LEFT JOIN customers cu ON c.customer_id=cu.id WHERE c.id=?').get(payment.contract_id);
  const data = JSON.parse(contract.data || '{}');
  contract.customer_name = contract.customer_name || data.customer?.name || '';
  const totalPaid  = paidThrough(db, contract.id, payment.id);
  const grandTotal = parseFloat(data?.costing?.grandTotal || 0);
  const balance    = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);
  const pdf = await generateReceiptPDF({ payment, contract, totalPaid, balance });
  const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  const pdfDir = path.join(UPLOADS_DIR, 'contracts', contract.contract_number);
  fs.mkdirSync(pdfDir, { recursive: true });
  const pdfPath = path.join(pdfDir, `receipt-${payment.id}.pdf`);
  fs.writeFileSync(pdfPath, buf);
  return { buf, pdfPath, contract };
}

// Optional photo of the cheque, or the photo of the cash a salesperson must
// add (Nov 2026), sent as multipart alongside the payment fields. Plain JSON
// requests (no photo) pass straight through multer untouched.
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, 'payment-tmp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + (path.extname(file.originalname) || '.jpg')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  // Reject with a visible error, not a silent drop — `cb(null, false)` would
  // make multer discard the file with no error at all, so a rejected photo
  // (e.g. an unexpected mimetype) would look identical to the user as a
  // payment recorded with no photo attached, no error shown.
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error((file.fieldname === 'cashPhoto' ? 'Cash' : 'Cheque') + ' photo must be an image file (got "' + (file.mimetype || 'unknown') + '")'));
  },
}).fields([{ name: 'chequePhoto', maxCount: 1 }, { name: 'cashPhoto', maxCount: 1 }]);

function withPhotos(req, res, next) {
  photoUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    next();
  });
}

// Cash a salesperson records waits for admin approval; everything else counts at once.
const needsApproval = (method, role) => method === 'cash' && role === 'sales';
const money2 = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const customerNameOf = contract => { try { return JSON.parse(contract.data || '{}').customer?.name || ''; } catch (e) { return ''; } };

// ── Record payment ────────────────────────────────────────────────────────────
router.post('/', withPhotos, async (req, res) => {
  // The uploads land in a temp folder before validation runs, so every early
  // exit has to throw them away.
  const chequeFile = req.files?.chequePhoto?.[0] || null;
  const cashFile   = req.files?.cashPhoto?.[0] || null;
  const discardUpload = () => { for (const f of [chequeFile, cashFile]) if (f) { try { fs.unlinkSync(f.path); } catch (e) { /* already gone */ } } };
  try {
    const { contractId, amount, method, chequeNumber, date, notes, idempotencyKey } = req.body;
    if (!contractId || !amount || !method) {
      discardUpload();
      return res.status(400).json({ error: 'contractId, amount and method are required' });
    }
    const pending = needsApproval(method, req.session.role);

    // Duplicate-submission fast path — a resubmit of the exact same attempt
    // (browser Back, double-click) returns the already-recorded payment
    // instead of validating/inserting again. Optional: omitted entirely by
    // older clients and the test suite, which behave exactly as before.
    if (idempotencyKey) {
      const dup = db.prepare('SELECT id FROM payments WHERE idempotency_key=?').get(idempotencyKey);
      // Only a true resend drops its photo (the first attempt already filed one).
      // Discarding before this check threw away every cheque photo sent with a key.
      if (dup) { discardUpload(); return res.json(existingPaymentResponse(dup.id)); }
    }

    let contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
    if (!contract) { discardUpload(); return res.status(404).json({ error: 'Contract not found' }); }
    if (req.session.role === 'sales' && contract.salesman_user_id !== req.session.userId) {
      discardUpload();
      return res.status(403).json({ error: 'Forbidden — not your contract' });
    }

    // Serializes everything below per contract, so the balance check and the
    // insert are atomic relative to any other concurrent request for the
    // SAME contract — closes the gap where two individually-under-balance
    // partial payments could otherwise both pass the check. See
    // utils/asyncLock.js.
    return await withLock('contract-payment:' + contractId, async () => {
    // Read again now that it's this request's turn: an edit saved while this
    // payment waited may have changed the Grand Total.
    contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
    if (!contract) { discardUpload(); return res.status(404).json({ error: 'Contract not found' }); }
    // Money kept or refunded on a cancellation is handled outside the portal.
    if (contract.status === 'cancelled') {
      discardUpload();
      return res.status(400).json({ error: `${contract.contract_number} is cancelled — payments can't be recorded on it.` });
    }

    // "1,500" / "$1,500" is 1500 (plain parseFloat would read 1); a comma in
    // the wrong place ("1,5000") is refused rather than guessed.
    const amt = parseFloat(String(amount ?? '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) {
      discardUpload();
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    if (!moneyOk(amount)) {
      discardUpload();
      return res.status(400).json({ error: `Amount looks wrong: ${String(amount).trim()} — use 1500 or 1,500` });
    }

    // Cash already waiting for approval is taken off too, so waiting payments
    // can never add up to more than what's owed.
    const totalPaidBefore = paidTotal(db, contractId);
    const waiting         = pendingTotal(db, contractId);
    const grandTotalCheck = parseFloat(JSON.parse(contract.data)?.costing?.grandTotal || 0);
    const balanceBefore   = Math.max(0, Math.round((grandTotalCheck - totalPaidBefore - waiting) * 100) / 100);
    if (amt > balanceBefore + 0.01) {
      discardUpload();
      return res.status(400).json({ error: `Amount exceeds remaining balance of $${balanceBefore.toFixed(2)}`
        + (waiting ? ` (after ${money2(waiting)} cash awaiting approval)` : '') });
    }
    if (pending && !cashFile) {
      discardUpload();
      return res.status(400).json({ error: 'Add a photo of the cash — cash payments need admin approval.' });
    }

    // Compress the photo up front, so an oversized/unreadable one is rejected
    // before the payment is recorded rather than after. A cheque photo sent
    // with another method (or a cash photo with no approval needed) is ignored.
    let chequeTmpPath = null, cashTmpPath = null;
    for (const [f, use, label] of [[chequeFile, method === 'cheque', 'cheque'], [cashFile, pending, 'cash']]) {
      if (!f) continue;
      if (!use) { try { fs.unlinkSync(f.path); } catch (e) { /* gone */ } continue; }
      const comp = await compressAndGate(f.path);
      if (comp.error || !comp.path) { discardUpload(); return res.status(400).json({ error: comp.error || `Could not process the ${label} photo` }); }
      if (label === 'cheque') chequeTmpPath = comp.path; else cashTmpPath = comp.path;
    }

    // Insert payment. A UNIQUE violation on idempotency_key means a
    // concurrent request with the same key won the race between this
    // request's fast-path check above and its own insert — return that
    // request's row instead of erroring.
    let ins;
    try {
      ins = db.prepare(`
        INSERT INTO payments (contract_id,amount,method,cheque_number,date,notes,recorded_by,idempotency_key,approval)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(contractId, amt, method, chequeNumber||null,
          date||phoenixToday(), notes||null, req.session.username, idempotencyKey||null, pending ? 'pending' : null);
    } catch (e) {
      if (idempotencyKey && /UNIQUE constraint failed/.test(e.message)) {
        discardUpload();
        const dup = db.prepare('SELECT id FROM payments WHERE idempotency_key=?').get(idempotencyKey);
        if (dup) return res.json(existingPaymentResponse(dup.id));
      }
      throw e;
    }

    // Cash waiting for approval: nothing counts yet — no balance / Sheet
    // change, no receipt. Its photo is filed (cash-<id>.jpg), admin is told.
    if (pending) {
      const paymentId = ins.lastInsertRowid;
      let photoPath = null;
      try {
        const dir = path.join(UPLOADS_DIR, 'contracts', contract.contract_number);
        fs.mkdirSync(dir, { recursive: true });
        photoPath = path.join(dir, `cash-${paymentId}.jpg`);
        fs.renameSync(cashTmpPath, photoPath);
        db.prepare('UPDATE payments SET cash_image_path=? WHERE id=?').run(photoPath, paymentId);
      } catch (e) { console.error('[Cash photo save failed]', e.message); photoPath = null; }
      try {
        await notifyCashPending({ contract, customerName: customerNameOf(contract), amount: amt, date: date || phoenixToday(),
          notes, recordedBy: salesName(req), photoPath });
      } catch (e) { console.error('[Email cash pending failed — non-fatal]', e.message); }
      logActivity(db, { contractId, contractNum: contract.contract_number, eventType: 'PAYMENT_PENDING', actor: req.session.username || 'system',
        detail: `${money2(amt)} cash recorded — awaiting admin approval` });
      const totalPaid = paidTotal(db, contractId);
      const newBalance = Math.max(0, Math.round((grandTotalCheck - totalPaid) * 100) / 100);
      return res.json({ success: true, paymentId, pending: true, totalPaid, newBalance, fullyPaid: false });
    }

    // Recalculate balance = grand_total - all payments recorded
    // Rounded to cents — plain float subtraction leaves e.g. 8767.09 - 8767 = 0.0900000000000145.
    const totalPaid  = paidTotal(db, contractId);
    const grandTotal = parseFloat(JSON.parse(contract.data)?.costing?.grandTotal || 0);
    const newBalance = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);

    db.prepare('UPDATE contracts SET paid_amount=?,due_prior=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(String(totalPaid), String(newBalance), contractId);

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
      receiptPath = (await buildReceipt(paymentId)).pdfPath;
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
      const _amt = '$' + Math.round(amt).toLocaleString();
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
    }); // end withLock
  } catch (err) {
    discardUpload();
    console.error('Payment error:', err);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ── List payments for a contract ──────────────────────────────────────────────
router.get('/contract/:contractId', (req, res) => {
  try {
    const contract = db.prepare('SELECT salesman_user_id FROM contracts WHERE id=?').get(req.params.contractId);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    if (req.session.role === 'sales' && contract.salesman_user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden — not your contract' });
    }

    const payments = db.prepare(
      'SELECT * FROM payments WHERE contract_id=? ORDER BY date,created_at'
    ).all(req.params.contractId);
    res.json({ payments, totalPaid: paidTotal(db, req.params.contractId) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ── Approve / reject cash a salesperson recorded (admin, Nov 2026) ───────────
// Approve: it counts from now — balance, Sheet, receipt, the photo into the
// gallery, the usual "payment recorded" email, and the salesperson is told.
// Reject (reason required): it stays on record, voided with the reason, and
// never counts; its photo is deleted; the salesperson is told.
async function decideCash(req, res, approve) {
  const reason = String(req.body?.reason ?? '').trim();
  if (!approve && !reason) return res.status(400).json({ error: 'A reason is required to reject a cash payment.' });
  try {
    const found = db.prepare('SELECT contract_id FROM payments WHERE id=?').get(req.params.id);
    if (!found) return res.status(404).json({ error: 'Payment not found' });
    const contractId = found.contract_id;
    return await withLock('contract-payment:' + contractId, async () => {
      const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
      if (payment.approval !== 'pending' || payment.voided_at) {
        return res.status(400).json({ error: payment.approval === 'approved' ? 'This cash payment was already approved.' : payment.approval === 'rejected' ? 'This cash payment was already rejected.' : 'This payment isn\'t waiting for approval.' });
      }
      const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
      const grandTotal = parseFloat(JSON.parse(contract.data || '{}')?.costing?.grandTotal || 0);
      const customerName = customerNameOf(contract);
      const by = req.session.username || 'admin';
      const amt = parseFloat(payment.amount);
      const takenBy = (db.prepare('SELECT name FROM users WHERE username=?').get(payment.recorded_by) || {}).name || payment.recorded_by || 'sales';

      if (!approve) {
        db.prepare("UPDATE payments SET approval='rejected', voided_at=datetime('now','-7 hours'), voided_by=?, void_reason=?, cash_image_path=NULL WHERE id=?")
          .run(by, 'Rejected: ' + reason, payment.id);
        if (payment.cash_image_path) { try { fs.unlinkSync(payment.cash_image_path); } catch (e) { /* already gone */ } }
        logActivity(db, { contractId, contractNum: contract.contract_number, eventType: 'CASH_REJECTED', actor: by,
          detail: `${money2(amt)} cash of ${payment.date || '—'} rejected — ${reason}` });
        addNotification(db, { contractId, contractNum: contract.contract_number, eventType: 'CASH_REJECTED', color: 'red',
          message: `${contract.contract_number} — Cash ${money2(amt)} from ${takenBy} rejected by ${by}: ${reason}` });
        try { await notifyCashDecision({ contract, customerName, amount: amt, approved: false, reason, by }); }
        catch (e) { console.error('[Email cash rejected failed — non-fatal]', e.message); }
        const totalPaid = paidTotal(db, contractId);
        return res.json({ success: true, rejected: true, totalPaid, newBalance: Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100) });
      }

      // The Grand Total may have been lowered by an edit since it was taken.
      const before = paidTotal(db, contractId);
      if (before + amt > grandTotal + 0.01) {
        return res.status(409).json({ error: `Approving ${money2(amt)} would take Total Paid past the Grand Total (${money2(grandTotal)}, ${money2(before)} already paid). Reject it, or correct the contract first.` });
      }
      db.prepare("UPDATE payments SET approval='approved', approved_by=?, approved_at=datetime('now','-7 hours') WHERE id=?").run(by, payment.id);
      const totalPaid  = paidTotal(db, contractId);
      const newBalance = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);
      db.prepare('UPDATE contracts SET paid_amount=?,due_prior=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(totalPaid), String(newBalance), contractId);
      try {
        const { updatePaymentInSheet } = require('../services/driveInventory');
        await updatePaymentInSheet(contract.contract_number, totalPaid, newBalance);
      } catch (e) { console.error('[Drive payment update failed — non-fatal]', e.message); }

      // The photo goes into the contract's gallery.
      if (payment.cash_image_path && fs.existsSync(payment.cash_image_path)) {
        const imgs = JSON.parse(db.prepare('SELECT extra_images FROM contracts WHERE id=?').get(contractId).extra_images || '[]');
        const day = new Date((payment.date || phoenixToday()) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
        imgs.push({ path: payment.cash_image_path, label: `Cash payment ${money2(amt)} — ${day}` });
        db.prepare('UPDATE contracts SET extra_images=? WHERE id=?').run(JSON.stringify(imgs), contractId);
      }

      let receiptPath = null;
      try { receiptPath = (await buildReceipt(payment.id)).pdfPath; } catch (e) { console.error('[Receipt save failed — non-fatal]', e.message); }
      try {
        await notifyPaymentRecorded({ contract, customerName, amount: amt, method: 'cash', totalPaid, balance: newBalance, receiptPath, chequeImagePath: payment.cash_image_path });
      } catch (e) { console.error('[Email notify PAYMENT_RECORDED failed — non-fatal]', e.message); }
      try { await notifyCashDecision({ contract, customerName, amount: amt, approved: true, by, totalPaid, balance: newBalance, receiptPath }); }
      catch (e) { console.error('[Email cash approved failed — non-fatal]', e.message); }
      logActivity(db, { contractId, contractNum: contract.contract_number, eventType: 'CASH_APPROVED', actor: by,
        detail: `${money2(amt)} cash of ${payment.date || '—'} (recorded by ${payment.recorded_by || '—'}) approved` });
      addNotification(db, { contractId, contractNum: contract.contract_number, eventType: 'CASH_APPROVED', color: 'green',
        message: `${contract.contract_number} — Cash ${money2(amt)} from ${takenBy} approved by ${by}` });
      res.json({ success: true, approved: true, totalPaid, newBalance, fullyPaid: newBalance <= 0 });
    });
  } catch (err) {
    console.error('Cash approval error:', err);
    res.status(500).json({ error: 'Failed to ' + (approve ? 'approve' : 'reject') + ' the payment' });
  }
}
router.post('/:id/approve', requireAdmin, (req, res) => decideCash(req, res, true));
router.post('/:id/reject',  requireAdmin, (req, res) => decideCash(req, res, false));

// ── Void a payment (admin) ────────────────────────────────────────────────────
// For a payment recorded by mistake (wrong amount, twice, wrong contract) or
// one that didn't go through (bounced cheque, reversed card). It stays on
// record, crossed out with the reason, but no longer counts toward Total Paid
// or the balance. To correct an amount: void it, then record the right one.
router.post('/:id/void', requireAdmin, async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void a payment.' });
  try {
    const found = db.prepare('SELECT contract_id FROM payments WHERE id=?').get(req.params.id);
    if (!found) return res.status(404).json({ error: 'Payment not found' });
    const contractId = found.contract_id;

    // Same lock as recording a payment, so a void and a new payment on the
    // same contract can't interleave their balance updates.
    return await withLock('contract-payment:' + contractId, async () => {
    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
    if (payment.voided_at) return res.status(400).json({ error: 'This payment is already voided.' });
    if (payment.approval === 'pending') return res.status(400).json({ error: 'This cash payment is waiting for approval — approve or reject it instead.' });
    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);

    // voided_at is Arizona time (MST), as shown on the page and the receipt.
    db.prepare("UPDATE payments SET voided_at=datetime('now','-7 hours'), voided_by=?, void_reason=? WHERE id=?")
      .run(req.session.username || 'admin', reason, payment.id);

    const totalPaid  = paidTotal(db, contractId);
    const grandTotal = parseFloat(JSON.parse(contract.data || '{}')?.costing?.grandTotal || 0);
    const newBalance = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);
    db.prepare('UPDATE contracts SET paid_amount=?,due_prior=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(totalPaid), String(newBalance), contractId);

    try {
      const { updatePaymentInSheet } = require('../services/driveInventory');
      await updatePaymentInSheet(contract.contract_number, totalPaid, newBalance);
    } catch(e) { console.error('[Drive payment update failed — non-fatal]', e.message); }

    // The saved receipt still shows it as a live payment — drop it; the next
    // download is generated fresh, stamped VOID.
    try { fs.unlinkSync(path.join(UPLOADS_DIR, 'contracts', contract.contract_number, `receipt-${payment.id}.pdf`)); } catch (e) { /* none saved */ }

    const _amt = '$' + parseFloat(payment.amount).toFixed(2);
    logActivity(db, {
      contractId, contractNum: contract.contract_number,
      eventType: 'PAYMENT_VOIDED', actor: req.session.username || 'system',
      detail: `${_amt} via ${payment.method} of ${payment.date || '—'} voided — ${reason}`
    });
    addNotification(db, {
      contractId, contractNum: contract.contract_number,
      eventType: 'PAYMENT_VOIDED', color: 'red',
      message: `${contract.contract_number} — Payment of ${_amt} voided (${reason})`
    });

    res.json({ success: true, totalPaid, newBalance });
    }); // end withLock
  } catch (err) {
    console.error('Payment void error:', err);
    res.status(500).json({ error: 'Failed to void payment' });
  }
});

// ── Receipt PDF ───────────────────────────────────────────────────────────────
router.get('/:id/receipt', async (req, res) => {
  try {
    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.approval === 'pending') return res.status(400).json({ error: 'No receipt yet — this cash payment is waiting for admin approval.' });
    const contract = db.prepare('SELECT contract_number, salesman_user_id FROM contracts WHERE id=?').get(payment.contract_id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    if (req.session.role === 'sales' && contract.salesman_user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden — not your contract' });
    }

    // Built fresh on every download (and the saved copy refreshed) — older
    // saved copies could be missing the customer name.
    const { buf } = await buildReceipt(payment.id);
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
