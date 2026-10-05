/**
 * post-delivery.js — Post Delivery Checklist (Sales follow-up + Admin tracking)
 * GET  /api/post-delivery/contracts               — sales+admin: delivered contracts list
 * GET  /api/post-delivery/contract/:id             — sales+admin: read-only header for feedback form
 * POST /api/post-delivery/feedback/:contractId     — sales+admin: submit feedback
 * GET  /api/post-delivery/contract-feedback/:id    — sales+admin: feedback for contract-detail page
 * GET  /api/post-delivery/admin/list               — admin: delivered contracts + status
 * GET  /api/post-delivery/admin/feedback/:id       — admin: feedback for eye-icon modal
 * POST /api/post-delivery/admin/complete/:id       — admin: mark feedback completed manually
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { logActivity, addNotification } = require('../utils/activityLogger');
const { reviewEmailEligibility, sendReviewEmailNow } = require('../utils/reviewEmail');

const BACK_ENTERED_MSG = 'No follow-up is needed for back-entered contracts';

function requireSalesOrAdmin(req, res, next) {
  if (!req.session?.username) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.session.username);
  if (!user || !['admin','sales'].includes(user.role))
    return res.status(403).json({ error: 'Access denied' });
  req.currentUser = user;
  next();
}

// scoped=true adds a salesman_user_id filter (one bound param, the caller's
// user id) — used for the sales-facing /contracts route below. /admin/list
// stays unscoped, same as before.
function buildListSql(scoped) {
  return `
    SELECT
      c.id, c.contract_number, c.make, c.model, c.serial_number,
      c.delivery_date, c.scheduled_datetime, c.salesman_user_id,
      COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name,
      COALESCE(NULLIF(cu.phone_cell,''), NULLIF(cu.phone_home,''), NULLIF(cu.phone_work,''), json_extract(c.data,'$.customer.phone.cell'), '') AS phone,
      COALESCE(cu.email, json_extract(c.data,'$.customer.email'), '') AS email,
      COALESCE(json_extract(c.data,'$.customer.address'), cu.address, '') AS address,
      COALESCE(json_extract(c.data,'$.customer.city'), cu.city) AS city,
      c.store,
      COALESCE(NULLIF(u.name,''), c.salesman, '') AS salesman_name,
      pdf.status AS feedback_status
    FROM contracts c
    LEFT JOIN customers cu ON c.customer_id = cu.id
    LEFT JOIN users u ON u.id = c.salesman_user_id
    LEFT JOIN post_delivery_feedback pdf ON pdf.contract_id = c.id
    WHERE c.status = 'delivered'
      AND COALESCE(c.back_entered, 0) = 0  -- back-entered (old) sales need no follow-up
    ${scoped ? 'AND c.salesman_user_id = ?' : ''}
    ORDER BY c.delivery_date DESC, c.id DESC
  `;
}

function mapListRow(r) {
  return {
    ...r,
    address: r.city ? [r.address, r.city].filter(Boolean).join(', ') : r.address,
    feedback_status: r.feedback_status || 'pending',
  };
}

// ── GET /contracts — sales+admin delivered list ─────────────────────────────
// Sales only sees their own contracts (via salesman_user_id) — admin sees all.
router.get('/contracts', requireSalesOrAdmin, (req, res) => {
  try {
    const scoped = req.currentUser.role === 'sales';
    const rows = db.prepare(buildListSql(scoped))
      .all(...(scoped ? [req.currentUser.id] : []))
      .map(mapListRow);
    res.json(rows);
  } catch(e) {
    console.error('[PostDelivery contracts]', e.message);
    res.status(500).json({ error: 'Failed to load delivered contracts' });
  }
});

// ── GET /contract/:id — read-only header for feedback form ─────────────────
router.get('/contract/:id', requireSalesOrAdmin, (req, res) => {
  try {
    const contract = db.prepare(`
      SELECT c.*, cu.name AS cu_name, cu.email AS cu_email, cu.phone_cell, cu.phone_home, cu.phone_work, cu.address AS cu_address, cu.city AS cu_city
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.id=?
    `).get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Not found' });
    if (contract.status !== 'delivered') return res.status(404).json({ error: 'Contract is not delivered' });
    if (contract.back_entered) return res.status(400).json({ error: BACK_ENTERED_MSG });
    if (req.currentUser.role === 'sales' && contract.salesman_user_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'Not your contract' });
    }

    const existing = db.prepare('SELECT status FROM post_delivery_feedback WHERE contract_id=?').get(contract.id);
    if (existing && existing.status !== 'pending')
      return res.status(409).json({ error: 'Feedback already recorded for this contract' });

    const data = JSON.parse(contract.data || '{}');
    const cu = data.customer || {};
    const review = reviewEmailEligibility(contract);

    res.json({
      id: contract.id,
      contract_number: contract.contract_number,
      customer_name: contract.cu_name || cu.name || '',
      address: [cu.address || contract.cu_address || '', cu.city || contract.cu_city || ''].filter(Boolean).join(', '),
      phone: contract.phone_cell || contract.phone_home || contract.phone_work || cu.phone?.cell || cu.phone?.home || '',
      email: contract.cu_email || cu.email || '',
      make: contract.make || '',
      model: contract.model || '',
      delivery_date: contract.delivery_date || '',
      scheduled_datetime: contract.scheduled_datetime || '',
      // Drives the "Send Google review email" question — Yes is disabled when false.
      review_email_available: review.ok,
      review_email_unavailable_reason: review.reason,
    });
  } catch(e) {
    console.error('[PostDelivery contract GET]', e.message);
    res.status(500).json({ error: 'Failed to load contract' });
  }
});

// ── POST /feedback/:contractId — sales+admin submit feedback ───────────────
router.post('/feedback/:contractId', requireSalesOrAdmin, async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.contractId);
    if (!contract) return res.status(404).json({ error: 'Not found' });
    if (contract.status !== 'delivered') return res.status(400).json({ error: 'Contract is not delivered' });
    if (contract.back_entered) return res.status(400).json({ error: BACK_ENTERED_MSG });
    if (req.currentUser.role === 'sales' && contract.salesman_user_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'Not your contract' });
    }

    const existing = db.prepare('SELECT status FROM post_delivery_feedback WHERE contract_id=?').get(contract.id);
    if (existing && existing.status !== 'pending')
      return res.status(409).json({ error: 'Feedback already recorded for this contract' });

    const {
      contacted, send_review_email, rating_delivery, rating_installation,
      rating_explanation, rating_confidence, rating_overall, concerns_text
    } = req.body;

    const ratings = [rating_delivery, rating_installation, rating_explanation, rating_confidence, rating_overall];
    if (contacted === undefined || contacted === null)
      return res.status(400).json({ error: 'Contacted answer is required' });
    if (send_review_email === undefined || send_review_email === null)
      return res.status(400).json({ error: 'Please answer whether to send the Google review email' });
    if (ratings.some(r => !Number.isInteger(r) || r < 1 || r > 5))
      return res.status(400).json({ error: 'All ratings must be between 1 and 5' });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO post_delivery_feedback
        (contract_id, status, contacted, send_review_email, rating_delivery, rating_installation, rating_explanation,
         rating_confidence, rating_overall, concerns_text, submitted_by, submitted_at, updated_at)
      VALUES (?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contract.id, contacted ? 1 : 0, send_review_email ? 1 : 0, rating_delivery, rating_installation, rating_explanation,
      rating_confidence, rating_overall, (concerns_text||'').trim() || null,
      req.session.username, now, now
    );

    logActivity(db, { contractId: contract.id, contractNum: contract.contract_number, eventType: 'PDF_SUBMITTED', actor: req.session.username, detail: 'Post-delivery feedback submitted' });
    addNotification(db, { contractId: contract.id, contractNum: contract.contract_number, eventType: 'PDF_SUBMITTED', color: 'green', message: contract.contract_number+' — post-delivery feedback submitted' });

    // Google review email — only when asked for. The feedback is already saved,
    // so a missing link/email or a send failure is reported, never an error.
    let reviewEmail = null;
    if (send_review_email) {
      try { reviewEmail = await sendReviewEmailNow(contract.id, req.session.username); }
      catch (e) { console.error('[Review email send failed — non-fatal]', e.message); reviewEmail = { sent: false, reason: 'The email could not be sent.' }; }
    }

    res.json({ success: true, reviewEmail });
  } catch(e) {
    console.error('[PostDelivery feedback POST]', e.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ── GET /contract-feedback/:contractId — for contract-detail collapsible ───
router.get('/contract-feedback/:contractId', requireSalesOrAdmin, (req, res) => {
  try {
    if (req.currentUser.role === 'sales') {
      const contract = db.prepare('SELECT salesman_user_id FROM contracts WHERE id=?').get(req.params.contractId);
      if (contract && contract.salesman_user_id !== req.currentUser.id) {
        return res.status(403).json({ error: 'Not your contract' });
      }
    }
    const row = db.prepare('SELECT pdf.*, c.review_email_sent_at FROM post_delivery_feedback pdf JOIN contracts c ON c.id = pdf.contract_id WHERE pdf.contract_id=?').get(req.params.contractId);
    if (!row) return res.json({ status: 'pending' });
    res.json({ ...row, noData: row.status === 'admin_completed' });
  } catch(e) {
    console.error('[PostDelivery contract-feedback]', e.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// ── GET /admin/list — admin delivered list with status ─────────────────────
router.get('/admin/list', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(buildListSql(false)).all().map(mapListRow);
    res.json(rows);
  } catch(e) {
    console.error('[PostDelivery admin list]', e.message);
    res.status(500).json({ error: 'Failed to load delivered contracts' });
  }
});

// ── GET /admin/feedback/:contractId — for eye-icon modal ───────────────────
router.get('/admin/feedback/:contractId', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT pdf.*, c.review_email_sent_at FROM post_delivery_feedback pdf JOIN contracts c ON c.id = pdf.contract_id WHERE pdf.contract_id=?').get(req.params.contractId);
    if (!row || row.status === 'pending') return res.status(404).json({ error: 'No feedback recorded' });
    res.json({ ...row, noData: row.status === 'admin_completed' });
  } catch(e) {
    console.error('[PostDelivery admin feedback]', e.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// ── POST /admin/complete/:contractId — mark feedback completed manually ────
router.post('/admin/complete/:contractId', requireAdmin, (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.contractId);
    if (!contract) return res.status(404).json({ error: 'Not found' });

    const existing = db.prepare('SELECT * FROM post_delivery_feedback WHERE contract_id=?').get(contract.id);
    if (existing && existing.status !== 'pending')
      return res.status(409).json({ error: 'Feedback already recorded for this contract' });

    const now = new Date().toISOString();
    if (existing) {
      db.prepare(`UPDATE post_delivery_feedback SET status='admin_completed', completed_by=?, completed_at=?, updated_at=? WHERE id=?`)
        .run(req.session.username, now, now, existing.id);
    } else {
      db.prepare(`INSERT INTO post_delivery_feedback (contract_id, status, completed_by, completed_at, updated_at) VALUES (?, 'admin_completed', ?, ?, ?)`)
        .run(contract.id, req.session.username, now, now);
    }

    logActivity(db, { contractId: contract.id, contractNum: contract.contract_number, eventType: 'PDF_ADMIN_COMPLETED', actor: req.session.username, detail: 'Post-delivery feedback marked completed by admin' });
    addNotification(db, { contractId: contract.id, contractNum: contract.contract_number, eventType: 'PDF_ADMIN_COMPLETED', color: 'green', message: contract.contract_number+' — feedback marked completed' });

    res.json({ success: true });
  } catch(e) {
    console.error('[PostDelivery admin complete]', e.message);
    res.status(500).json({ error: 'Failed to mark completed' });
  }
});

module.exports = router;
