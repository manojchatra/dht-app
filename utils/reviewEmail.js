/**
 * reviewEmail.js — delayed Google-review request email to the customer.
 *
 * Delivery calls queueReviewEmail(), which only stamps a due time; a small
 * poller (startReviewEmailScheduler, started from server.js) sends whatever
 * has come due. Contracts that were never queued — including everything
 * auto-delivered at creation (historical entries) — are never emailed.
 */
const db = require('../db/database');
const { sendReviewRequestEmail, getStoreReviewUrl } = require('./emailSender');
const { logActivity } = require('./activityLogger');

const REVIEW_EMAIL_DELAY_HOURS = 24;
const RETRY_BACKOFF_HOURS = 6;
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// Stamp a contract to be emailed REVIEW_EMAIL_DELAY_HOURS from now. No-op if it
// was already queued or sent, so re-submitting an acknowledgement can't queue
// a second email.
function queueReviewEmail(contractId) {
  db.prepare(`
    UPDATE contracts
    SET review_email_due_at = datetime('now', '+${REVIEW_EMAIL_DELAY_HOURS} hours')
    WHERE id = ? AND review_email_due_at IS NULL AND review_email_sent_at IS NULL
  `).run(contractId);
}

function customerContact(contract) {
  let data = {};
  try { data = JSON.parse(contract.data || '{}'); } catch (e) { /* fall through to the customers row */ }
  const cust = db.prepare('SELECT name, email FROM customers WHERE id = ?').get(contract.customer_id) || {};
  return {
    email: (data.customer?.email || cust.email || '').trim(),
    name:  data.customer?.name || cust.name || '',
  };
}

function recordFailure(contract, reason) {
  db.prepare(`
    UPDATE contracts
    SET review_email_attempts = COALESCE(review_email_attempts, 0) + 1,
        review_email_due_at = datetime('now', '+${RETRY_BACKOFF_HOURS} hours')
    WHERE id = ?
  `).run(contract.id);
  console.error(`[Review email] ${contract.contract_number}: ${reason} — will retry`);
}

let processing = false;

async function processDueReviewEmails() {
  if (processing) return;
  processing = true;
  try {
    const due = db.prepare(`
      SELECT * FROM contracts
      WHERE review_email_sent_at IS NULL
        AND review_email_due_at IS NOT NULL
        AND review_email_due_at <= datetime('now')
        AND COALESCE(review_email_attempts, 0) < ${MAX_ATTEMPTS}
    `).all();

    for (const contract of due) {
      const { email, name } = customerContact(contract);
      if (!email) {
        // Nothing to retry — no address on file.
        db.prepare('UPDATE contracts SET review_email_attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, contract.id);
        console.log(`[Review email] ${contract.contract_number}: customer has no email — skipped`);
        continue;
      }
      const reviewUrl = getStoreReviewUrl(contract.store);
      if (!reviewUrl) { recordFailure(contract, `no Google review link set for store "${contract.store}"`); continue; }

      try {
        await sendReviewRequestEmail({ customerEmail: email, customerName: name, reviewUrl });
        db.prepare("UPDATE contracts SET review_email_sent_at = datetime('now') WHERE id = ?").run(contract.id);
        logActivity(db, {
          contractId: contract.id, contractNum: contract.contract_number,
          eventType: 'REVIEW_EMAIL_SENT', actor: 'system', detail: `Google review request sent to ${email}`,
        });
      } catch (e) {
        recordFailure(contract, e.message);
      }
    }
  } catch (e) {
    console.error('[Review email] poll failed:', e.message);
  } finally {
    processing = false;
  }
}

function startReviewEmailScheduler() {
  const timer = setInterval(processDueReviewEmails, POLL_INTERVAL_MS);
  timer.unref(); // never keep the process alive just for this
  return timer;
}

module.exports = { queueReviewEmail, processDueReviewEmails, startReviewEmailScheduler };
