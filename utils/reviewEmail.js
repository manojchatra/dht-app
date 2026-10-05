/**
 * reviewEmail.js — Google-review request email to the customer.
 *
 * Sent only when the salesperson answers "Yes" to "Send Google review email to
 * the customer?" on the post-delivery feedback form (routes/post-delivery.js).
 * Nothing is sent automatically on delivery any more.
 *
 * sendReviewEmailNow() sends immediately; if that fails, the contract is left
 * due for a retry, which the small poller (startReviewEmailScheduler, started
 * from server.js) picks up — up to MAX_ATTEMPTS tries, RETRY_BACKOFF_HOURS apart.
 */
const db = require('../db/database');
const { sendReviewRequestEmail, getStoreReviewUrl } = require('./emailSender');
const { logActivity } = require('./activityLogger');

const RETRY_BACKOFF_HOURS = 6;
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 15 * 60 * 1000;

function customerContact(contract) {
  let data = {};
  try { data = JSON.parse(contract.data || '{}'); } catch (e) { /* fall through to the customers row */ }
  const cust = db.prepare('SELECT name, email FROM customers WHERE id = ?').get(contract.customer_id) || {};
  return {
    email: (cust.email || data.customer?.email || '').trim(),
    name:  cust.name || data.customer?.name || '',
  };
}

// Whether a review email can be sent for this contract, and why not if it
// can't. Used by the feedback form (to grey out "Yes") and again on submit.
function reviewEmailEligibility(contract) {
  const { email, name } = customerContact(contract);
  const reviewUrl = getStoreReviewUrl(contract.store);
  let reason = null;
  if (contract.review_email_sent_at) reason = 'A review email was already sent to this customer.';
  else if (!reviewUrl) reason = `No Google review link is set for ${contract.store || 'this showroom'} — ask an admin to add it in Settings.`;
  else if (!email) reason = 'This customer has no email address on file.';
  return { ok: !reason, reason, email, name, reviewUrl };
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

// Sends one contract's review email. Returns { sent, reason }.
async function deliver(contract, actor) {
  const elig = reviewEmailEligibility(contract);
  if (!elig.ok) {
    // Nothing to retry for a missing link/email — stop the poller trying.
    db.prepare('UPDATE contracts SET review_email_due_at = NULL WHERE id = ?').run(contract.id);
    console.log(`[Review email] ${contract.contract_number}: not sent — ${elig.reason}`);
    return { sent: false, reason: elig.reason };
  }
  try {
    await sendReviewRequestEmail({ customerEmail: elig.email, customerName: elig.name, reviewUrl: elig.reviewUrl });
    db.prepare("UPDATE contracts SET review_email_sent_at = datetime('now'), review_email_due_at = NULL WHERE id = ?").run(contract.id);
    logActivity(db, {
      contractId: contract.id, contractNum: contract.contract_number,
      eventType: 'REVIEW_EMAIL_SENT', actor: actor || 'system', detail: `Google review request sent to ${elig.email}`,
    });
    return { sent: true };
  } catch (e) {
    recordFailure(contract, e.message);
    return { sent: false, reason: 'The email could not be sent right now; it will be retried automatically.' };
  }
}

// Called from the feedback form when "Send Google review email" is Yes.
async function sendReviewEmailNow(contractId, actor) {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  if (!contract) return { sent: false, reason: 'Contract not found' };
  return deliver(contract, actor);
}

let processing = false;

// Retries — contracts whose first send failed are left with a due time.
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
    for (const contract of due) await deliver(contract, 'system');
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

module.exports = { reviewEmailEligibility, sendReviewEmailNow, processDueReviewEmails, startReviewEmailScheduler };
