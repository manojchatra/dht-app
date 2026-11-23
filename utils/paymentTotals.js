// utils/paymentTotals.js — what a contract has been paid. A voided payment
// (voided_at set — a wrong amount, a duplicate, a bounced cheque, or rejected
// cash) stays in the payments table for the record but never counts toward
// Total Paid or the balance. Neither does cash awaiting admin approval
// (approval = 'pending', Nov 2026) until it's approved.
'use strict';

const COUNTED = "voided_at IS NULL AND COALESCE(approval,'') <> 'pending'";

function totalPaid(db, contractId) {
  const t = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=? AND ${COUNTED}`).get(contractId).t;
  return Math.round(t * 100) / 100; // cents — float sums leave long fractions
}

// Paid as of a given payment — that payment and the ones recorded before it
// (ids are in recording order). A receipt shows these totals, not today's.
function paidThrough(db, contractId, paymentId) {
  const t = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=? AND id<=? AND ${COUNTED}`).get(contractId, paymentId).t;
  return Math.round(t * 100) / 100;
}

// Cash recorded by a salesperson, still waiting for admin approval.
function pendingTotal(db, contractId) {
  const t = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=? AND approval='pending' AND voided_at IS NULL").get(contractId).t;
  return Math.round(t * 100) / 100;
}

module.exports = { totalPaid, paidThrough, pendingTotal };
