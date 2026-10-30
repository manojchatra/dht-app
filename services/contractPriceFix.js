/**
 * contractPriceFix.js — correct a mistyped spa price on a saved contract (e.g.
 * DHT2610PH00066: "20,0300" was read as $200,300). The portal can't edit a
 * contract's prices, so scripts/fix-contract-price.js uses this.
 *
 * Only the spa price changes; everything else on the contract stays as signed.
 * The subtotal moves by the difference, tax is recalculated at the contract's
 * own tax %, and Grand Total = product total + services − discount, as New
 * Contract works it out. The balance is Grand Total less the payments recorded
 * (voided ones excluded). The serial is also written in capitals.
 */
'use strict';
const { totalPaid } = require('../utils/paymentTotals');

const money = v => parseFloat(String(v ?? '').replace(/[$,\s]/g, '')) || 0;
const cents = v => Math.round(v * 100) / 100;
const show  = v => (v % 1 ? v.toFixed(2) : String(v)); // as New Contract stores amounts

function planPriceFix(db, contractNumber, newSpaPrice) {
  const c = db.prepare('SELECT * FROM contracts WHERE contract_number=?').get(contractNumber);
  if (!c) throw new Error(`Contract ${contractNumber} not found`);
  if (!(newSpaPrice > 0)) throw new Error('The new spa price must be a number above 0');
  const data = JSON.parse(c.data || '{}');
  const de = data.details || {}, co = data.costing || {};

  const oldSpa = money(de.spaPrice);
  const subtotal = cents(money(co.subtotal) - oldSpa + newSpaPrice);
  if (subtotal < newSpaPrice) throw new Error(`Subtotal ${co.subtotal} doesn't include the old spa price ${de.spaPrice} — check this contract by hand`);
  const taxPct = money(co.taxPercent);
  const tax = cents(subtotal * taxPct / 100);
  const productTotal = cents(subtotal + tax);
  const grandTotal = cents(Math.max(0, productTotal + money(co.serviceTotal) - money(co.discountAmount)));
  const paid = totalPaid(db, c.id);
  const balance = cents(Math.max(0, grandTotal - paid));
  const serial = String(c.serial_number || '').trim().toUpperCase();

  return {
    contract: c, data, paid, serial,
    before: { spaPrice: de.spaPrice, subtotal: co.subtotal, taxPercent: co.taxPercent, taxAmount: co.taxAmount,
      productTotal: co.productTotal, grandTotal: co.grandTotal, balance: c.due_prior, serial: c.serial_number },
    after: { spaPrice: show(newSpaPrice), subtotal: show(subtotal), taxPercent: co.taxPercent, taxAmount: show(tax),
      productTotal: show(productTotal), grandTotal: show(grandTotal), balance: show(balance), serial },
  };
}

// Writes the plan in one transaction. Returns the new { grandTotal, balance, paid }.
function applyPriceFix(db, plan) {
  const { contract: c, data, after } = plan;
  data.details = { ...(data.details || {}), spaPrice: after.spaPrice };
  data.costing = { ...(data.costing || {}), subtotal: after.subtotal, taxAmount: after.taxAmount,
    productTotal: after.productTotal, grandTotal: after.grandTotal };
  if (data.payment) data.payment.duePriorToDelivery = after.balance;
  if (data.product && after.serial) data.product.serialNumber = after.serial;
  db.prepare(`UPDATE contracts SET data=?, grand_total=?, due_prior=?, paid_amount=?, serial_number=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(JSON.stringify(data), after.grandTotal, after.balance, String(plan.paid), after.serial || c.serial_number, c.id);
  return { grandTotal: Number(after.grandTotal), balance: Number(after.balance), paid: plan.paid };
}

module.exports = { planPriceFix, applyPriceFix };
