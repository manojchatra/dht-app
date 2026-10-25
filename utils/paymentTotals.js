// utils/paymentTotals.js — what a contract has been paid. A voided payment
// (voided_at set — a wrong amount, a duplicate, a bounced cheque) stays in the
// payments table for the record but never counts toward Total Paid or the balance.
'use strict';

function totalPaid(db, contractId) {
  const t = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=? AND voided_at IS NULL').get(contractId).t;
  return Math.round(t * 100) / 100; // cents — float sums leave long fractions
}

// Paid as of a given payment — that payment and the ones recorded before it
// (ids are in recording order). A receipt shows these totals, not today's.
function paidThrough(db, contractId, paymentId) {
  const t = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=? AND id<=? AND voided_at IS NULL').get(contractId, paymentId).t;
  return Math.round(t * 100) / 100;
}

module.exports = { totalPaid, paidThrough };
