// utils/money.js — is a typed amount written correctly? "20,300", "20300",
// "$20,300.50" and "" are fine; "20,0300" (a comma in the wrong place — it was
// read as $200,300 on DHT2610PH00066), "20.3.1" or "abc" are not.
// The same rule is in js/util.js (moneyLooksWrong) for the pages.
'use strict';

const MONEY_RE = /^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

// True when the value is blank or a correctly written amount.
function moneyOk(v) {
  const s = String(v ?? '').trim();
  return s === '' || MONEY_RE.test(s);
}

// The first wrongly written amount among [label, value] pairs, as an error
// message ("Spa price looks wrong: 20,0300"), or null.
function moneyError(pairs) {
  for (const [label, v] of pairs) {
    if (!moneyOk(v)) return `${label} looks wrong: ${String(v).trim()} — use 20300 or 20,300`;
  }
  return null;
}

// Every price on a contract form (details / service / costing / payment), labelled.
function contractMoneyFields(f = {}) {
  const de = f.details || {}, sv = f.service || {}, pm = f.payment || {}, mi = f.misc || {};
  return [
    ['Spa price', de.spaPrice], ['Cover price', de.cover?.price], ['Steps price', de.steps?.price],
    ['Subpanel price', de.subpanel?.price], ['Water care price', de.waterCareSystem?.price],
    ['Upgraded water care price', de.upgradedWaterCare?.price], ['Startup chemicals price', de.startupChemicals?.price],
    ['Cool Zone price', de.coolZone?.price], ['Accessories price', de.accessories?.price],
    ['Spa removal price', de.spaRemoval?.price], ['Fuel surcharge', de.fuelSurcharge?.price],
    ['Discount', de.discount?.amount], ['Crane fee', sv.craneFee], ['Out-of-town delivery fee', sv.outOfTownDeliveryFee],
    ['Out-of-town warranty fee', sv.outOfTownWarrantyFee], ['Monthly cleaning price', mi.cleaningPrice],
    ['Cheque amount', pm.cheque?.amount], ['Cash amount', pm.cash?.amount], ['Card amount', pm.creditCard?.amount],
    ['Finance amount', pm.finance?.amount], ['Deposit amount', pm.depositAmount],
  ];
}

module.exports = { MONEY_RE, moneyOk, moneyError, contractMoneyFields };
