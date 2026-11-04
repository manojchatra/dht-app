// utils/contractTotals.js — a contract's totals from its line items, worked out
// exactly as New Contract does in the browser (create-contract.html recalcAll):
//   subtotal  = spa + every line item not ticked Included (+ Cool Zone, which
//               has no Included option)
//   tax       = subtotal × tax %
//   services  = crane fee + out-of-town delivery fee + spa removal + fuel
//               surcharge (the out-of-town WARRANTY fee is a note, not charged)
//   Grand Total = subtotal + tax + services − discount (never below 0)
// Every amount is kept to the cent. Used by the contract edit (Pricing).
'use strict';

const num = v => parseFloat(String(v ?? '').replace(/[$,\s]/g, '')) || 0;
const cents = v => Math.round(v * 100) / 100;
// As New Contract stores amounts: whole numbers as typed ("5000"), cents with 2 decimals.
const show = v => (v % 1 ? v.toFixed(2) : String(v));

function computeTotals(details = {}, service = {}, taxPercent = 0) {
  const de = details || {}, sv = service || {};
  const item = x => (x && !x.included ? num(x.price) : 0);
  const uw = de.upgradedWaterCare || {};
  const product =
      num(de.spaPrice)
    + item(de.cover) + item(de.steps) + item(de.subpanel) + item(de.waterCareSystem)
    + ((uw.autoDosing || uw.fwssIq) ? item(uw) : 0)
    + item(de.startupChemicals)
    + (de.coolZone && de.coolZone.yes ? num(de.coolZone.price) : 0)
    + item(de.accessories);
  const subtotal = cents(product);
  const tax = cents(subtotal * num(taxPercent) / 100);
  const productTotal = cents(subtotal + tax);
  const serviceTotal = cents(
      (sv.crane ? num(sv.craneFee) : 0)
    + (sv.outOfTownDelivery ? num(sv.outOfTownDeliveryFee) : 0)
    + (de.spaRemoval && de.spaRemoval.yes ? num(de.spaRemoval.price) : 0)
    + (de.fuelSurcharge && de.fuelSurcharge.yes ? num(de.fuelSurcharge.price) : 0));
  const discount = de.discount && de.discount.yes ? cents(num(de.discount.amount)) : 0;
  const grandTotal = cents(Math.max(0, productTotal + serviceTotal - discount));
  return { subtotal, tax, productTotal, serviceTotal, discount, grandTotal };
}

// The costing block saved on the contract, from computeTotals.
function costingFrom(t, taxPercent) {
  const blankIfZero = v => (v > 0 ? show(v) : '');
  return {
    subtotal: blankIfZero(t.subtotal), taxPercent: String(taxPercent ?? ''), taxAmount: blankIfZero(t.tax),
    productTotal: blankIfZero(t.productTotal), serviceTotal: blankIfZero(t.serviceTotal),
    discountAmount: blankIfZero(t.discount), grandTotal: blankIfZero(t.grandTotal),
  };
}

module.exports = { computeTotals, costingFrom, show, cents, num };
