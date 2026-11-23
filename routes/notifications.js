// routes/notifications.js
'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { logActivity, addNotification } = require('../utils/activityLogger');

function requireAdmin(req,res,next){if(req.session.role==='admin')return next();res.status(403).json({error:'Admin only'});}

// Payment notifications live in the Dashboard's bell (Nov 2026), not in the
// notification cards: payments recorded / voided, cash approved / rejected.
const PAYMENT_TYPES = ['PAYMENT', 'PAYMENT_VOIDED', 'CASH_APPROVED', 'CASH_REJECTED'];
const PAYMENT_IN = `(${PAYMENT_TYPES.map(t => `'${t}'`).join(',')})`;

// GET /api/notifications — fetch active notifications for admin
router.get('/', requireAdmin, (req, res) => {
  try {
    // Auto-detect failed deliveries (scheduled + past datetime)
    // scheduled_datetime is stored as a naive Phoenix-local (UTC-7, no DST) string,
    // so "now" must be expressed the same way for the comparison below to be meaningful.
    const now = new Date(Date.now() - 7 * 3600000).toISOString().slice(0,16); // 'YYYY-MM-DDTHH:MM' Phoenix-local
    const overdue = db.prepare(
      "SELECT id,contract_number,data,scheduled_datetime FROM contracts WHERE status='scheduled' AND scheduled_datetime < ?"
    ).all(now);

    for (const c of overdue) {
      // One alert per missed slot. No "AND dismissed=0" on purpose — a
      // dismissed alert must count too, or dismissing would do nothing (the
      // next load would recreate it). A rescheduled delivery that's missed
      // again is a new slot, so it gets a new alert.
      const alreadyNotified = db.prepare(
        "SELECT id FROM notifications WHERE contract_id=? AND event_type='FAILED_DELIVERY' AND ref=?"
      ).get(c.id, c.scheduled_datetime);
      if (!alreadyNotified) {
        const cuName = (() => { try { return JSON.parse(c.data||'{}').customer?.name||''; } catch(e){ return ''; } })();
        const slot   = new Date(c.scheduled_datetime + '-07:00').toLocaleString('en-US',{timeZone:'America/Phoenix',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
        addNotification(db, {
          contractId: c.id, contractNum: c.contract_number,
          eventType: 'FAILED_DELIVERY', color: 'red', ref: c.scheduled_datetime,
          message: `${c.contract_number} — ${cuName} scheduled for ${slot} — not delivered`
        });
      }
    }

    // "Not delivered" alerts first, outside the 10: shown while the contract
    // is still Scheduled for that same slot (delivered / rescheduled /
    // cancelled → they go away) and until dismissed. Then the 10 newest others.
    const failed = db.prepare(`
      SELECT n.* FROM notifications n JOIN contracts c ON c.id = n.contract_id
      WHERE n.event_type='FAILED_DELIVERY' AND n.dismissed=0
        AND c.status='scheduled' AND c.scheduled_datetime = n.ref
      ORDER BY n.id DESC`).all();
    const others = db.prepare(
      `SELECT * FROM notifications WHERE dismissed=0 AND event_type<>'FAILED_DELIVERY' AND event_type NOT IN ${PAYMENT_IN} ORDER BY id DESC LIMIT 10`
    ).all();
    res.json([...failed, ...others]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/payments — the bell: cash awaiting approval (always
// listed until approved or rejected — it can't be dismissed), then the 30
// newest payment notifications not cleared.
router.get('/payments', requireAdmin, (req, res) => {
  try {
    const toUrl = p => {
      if (!p) return null;
      const rel = require('path').relative(process.env.UPLOADS_DIR || require('path').join(__dirname, '../uploads'), p);
      return rel.startsWith('..') ? null : '/uploads/' + rel.replace(/\\/g, '/');
    };
    const pending = db.prepare(`
      SELECT p.id, p.contract_id, p.amount, p.date, p.notes, p.recorded_by, p.cash_image_path, c.contract_number,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name,
        COALESCE(u.name, p.recorded_by) AS recorded_by_name
      FROM payments p JOIN contracts c ON c.id = p.contract_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      LEFT JOIN users u ON u.username = p.recorded_by
      WHERE p.approval = 'pending' AND p.voided_at IS NULL
      ORDER BY p.id`).all()
      .map(({ cash_image_path, ...r }) => ({ ...r, photo_url: toUrl(cash_image_path) }));
    const items = db.prepare(`SELECT * FROM notifications WHERE dismissed=0 AND event_type IN ${PAYMENT_IN} ORDER BY id DESC LIMIT 30`).all();
    res.json({ pending, items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/payments/clear — "Clear all" in the bell (cash
// awaiting approval isn't a notification, so it stays).
router.post('/payments/clear', requireAdmin, (req, res) => {
  try {
    const n = db.prepare(`UPDATE notifications SET dismissed=1 WHERE dismissed=0 AND event_type IN ${PAYMENT_IN}`).run().changes;
    res.json({ success: true, cleared: n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/:id/dismiss
router.post('/:id/dismiss', requireAdmin, (req, res) => {
  try {
    db.prepare('UPDATE notifications SET dismissed=1 WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
