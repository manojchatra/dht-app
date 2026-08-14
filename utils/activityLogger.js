// utils/activityLogger.js — activity logging to SQLite + text file
'use strict';
const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../data/activity.log');

// MST formatter (America/Phoenix — no DST)
function mstNow() {
  return new Date().toLocaleString('en-US', {
    timeZone:    'America/Phoenix',
    year:        'numeric', month:  '2-digit', day:    '2-digit',
    hour:        '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).replace(',','');
}

function writeFile(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) { /* non-fatal */ }
}

/**
 * logActivity(db, { contractId, contractNum, eventType, actor, detail })
 * eventType: CONTRACT_CREATED | CONTRACT_UPDATED | CONTRACT_DELETED |
 *            STATUS_CHANGED   | PAYMENT_RECORDED | SERIAL_ASSIGNED  |
 *            SCHEDULED        | ACK_SUBMITTED    | EMAIL_SENT       |
 *            MARK_RECEIVED    | FAILED_DELIVERY
 */
function logActivity(db, { contractId, contractNum, eventType, actor, detail }) {
  const ts  = mstNow();
  const line = `[${ts} MST] [${actor||'system'}] ${eventType} ${contractNum||''} — ${detail||''}`;
  writeFile(line);
  try {
    db.prepare(
      'INSERT INTO activity_log (contract_id,contract_num,event_type,actor,detail) VALUES (?,?,?,?,?)'
    ).run(contractId||null, contractNum||null, eventType, actor||'system', detail||null);
  } catch(e) { console.error('[ActivityLog] DB error:', e.message); }
}

/**
 * addNotification(db, { contractId, contractNum, eventType, message, color })
 * color: 'green' | 'red'
 * Rolling window of 10 — drops oldest when 11th arrives.
 */
function addNotification(db, { contractId, contractNum, eventType, message, color }) {
  try {
    db.prepare(
      'INSERT INTO notifications (contract_id,contract_num,event_type,message,color) VALUES (?,?,?,?,?)'
    ).run(contractId||null, contractNum||null, eventType, message||null, color||'green');
    // Rolling window: delete oldest beyond 10
    const ids = db.prepare(
      'SELECT id FROM notifications WHERE dismissed=0 ORDER BY id DESC LIMIT -1 OFFSET 10'
    ).all();
    if (ids.length) {
      db.prepare(`DELETE FROM notifications WHERE id IN (${ids.map(()=>'?').join(',')})`).run(ids.map(r=>r.id));
    }
  } catch(e) { console.error('[Notification] DB error:', e.message); }
}

module.exports = { logActivity, addNotification, mstNow };
