// routes/notifications.js
'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { logActivity, addNotification } = require('../utils/activityLogger');

function requireAdmin(req,res,next){if(req.session.role==='admin')return next();res.status(403).json({error:'Admin only'});}

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
      // No "AND dismissed=0" here on purpose — this must count a dismissed
      // notification too, or dismissing does nothing: the very next load
      // would see the contract is still overdue, find no *undismissed*
      // notification, and immediately recreate one. Once notified about a
      // given overdue contract, stay quiet — dismiss is meant to be final.
      const alreadyNotified = db.prepare(
        "SELECT id FROM notifications WHERE contract_id=? AND event_type='FAILED_DELIVERY'"
      ).get(c.id);
      if (!alreadyNotified) {
        const cuName = (() => { try { return JSON.parse(c.data||'{}').customer?.name||''; } catch(e){ return ''; } })();
        const slot   = new Date(c.scheduled_datetime + '-07:00').toLocaleString('en-US',{timeZone:'America/Phoenix',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
        addNotification(db, {
          contractId: c.id, contractNum: c.contract_number,
          eventType: 'FAILED_DELIVERY', color: 'red',
          message: `${c.contract_number} — ${cuName} scheduled for ${slot} — not delivered`
        });
      }
    }

    const notifications = db.prepare(
      "SELECT * FROM notifications WHERE dismissed=0 ORDER BY id DESC LIMIT 10"
    ).all();
    res.json(notifications);
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
