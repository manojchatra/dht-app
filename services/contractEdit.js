/**
 * contractEdit.js — editing a saved contract on the "Edit contract" page (New
 * Contract's form opened in edit mode: create-contract.html + js/contract-edit.js;
 * route POST /api/contracts/:id/edit). Agreed with the owner, Nov 2026. The
 * handwritten contract stays the legal one, so an edit just corrects what was
 * typed in; each save is logged field by field with a reason.
 *
 *  - Who: an admin, or the salesperson whose contract it is.
 *  - Until Delivered: everything below. Delivered or Cancelled: contact details
 *    only (phones, email, gate).
 *  - Editable: customer & delivery address, requested delivery date, Sold at,
 *    spa colours / speaker / year / series (make & model only if no spa is
 *    linked), warranty, electrical, misc notes, monthly cleanings, every line
 *    item and price, services, discount, tax %. Images can be removed.
 *    Images can be added (with a label) and removed.
 *  - The spa, serial and In Stock / To Be Ordered: admin only, in
 *    services/contractSpa.js (Nov 2026 — replaces Assign SI. No).
 *  - Never: contract #, store, sale date, salesperson, payments (Record /
 *    Void), the signature.
 * The server takes only those fields from the form; anything else is ignored.
 */
'use strict';
const { computeTotals, costingFrom, show, cents, num } = require('../utils/contractTotals');
const { moneyError } = require('../utils/money');
const { totalPaid } = require('../utils/paymentTotals');
const { normalizeContractPhones } = require('./customers');
const { normalizeMake } = require('../utils/makes');
const { normalizeColour } = require('../utils/colours');
const { cleanSaleChannel } = require('../utils/saleChannel');

const CLOSED = ['delivered', 'cancelled'];

// Why this user can't edit this contract at all, or null.
function editBlockReason(session, contract) {
  const owner = session.role === 'sales' && contract.salesman_user_id === session.userId;
  if (session.role !== 'admin' && !owner) return 'Only an admin or this contract\'s salesperson can edit it.';
  const d = JSON.parse(contract.data || '{}');
  if (!(d.customer || d.product || d.costing)) return `${contract.contract_number} was saved in the original (old) format and can't be edited here.`;
  return null;
}

// ── Change list for the activity log ─────────────────────────────────────────
const blank = v => v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && !v.length);
const shown = v => (blank(v) ? '—' : v === true ? 'yes' : Array.isArray(v) ? v.join('/') : String(v));
const same = (a, b) => (blank(a) && blank(b)) || shown(a) === shown(b);
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const diff = (before, after, fields) => fields.filter(([p]) => !same(get(before, p), get(after, p)))
  .map(([p, label]) => ({ label, from: shown(get(before, p)), to: shown(get(after, p)) }));
const changeText = changes => changes.map(c => `${c.label} ${c.from} → ${c.to}`).join(' · ');

// ── Field cleaning ────────────────────────────────────────────────────────────
const B = 'bool', S = 'str', A = 'arr';
const clean = (type, v, max = 200) => type === B ? !!v
  : type === A ? (Array.isArray(v) ? v.map(x => String(x).trim().slice(0, 50)).filter(Boolean) : [])
  : String(v ?? '').trim().slice(0, max);
function pickInto(target, from, fields) {
  const out = { ...(target || {}) };
  for (const [f, type] of Object.entries(fields)) out[f] = clean(type, (from || {})[f], type === S && /notes/i.test(f) ? 500 : 200);
  return out;
}

// Line items: item → field → type.
const PRICING_FIELDS = {
  cover:             { coverType: A, brand: S, lift: S, otherLift: S, price: S, included: B },
  steps:             { type: S, price: S, included: B },
  subpanel:          { provided: B, amperage: S, price: S, included: B },
  waterCareSystem:   { type: S, price: S, included: B },
  upgradedWaterCare: { autoDosing: B, fwssIq: B, price: S, included: B },
  startupChemicals:  { yes: B, price: S, included: B },
  coolZone:          { yes: B, extWarranty: B, price: S },
  accessories:       { items: A, other: S, price: S, included: B },
  spaRemoval:        { yes: B, price: S },
  fuelSurcharge:     { yes: B, price: S },
  discount:          { yes: B, amount: S, reason: S },
};
const SERVICE_FIELDS = { inTownDelivery: B, crane: B, craneFee: S, outOfTownDelivery: B, outOfTownDeliveryFee: S,
  outOfTownWarranty: B, outOfTownWarrantyFee: S };
const WARRANTY_FIELDS = { brands: A, componentYrs: S, shellYrs: S, cabinetYrs: S };
const ELECTRICAL_FIELDS = { pamphletProvided: B, ownElectrician: B, notes: S };
const MISC_FIELDS = { notes: S, monthlyCleanings: B, cleaningPrice: S, cleaningMonths: S, cleaningIncluded: B };

// ── Labels for the log ────────────────────────────────────────────────────────
const ITEM_LABEL = { cover: 'Cover', steps: 'Steps', subpanel: 'Subpanel', waterCareSystem: 'Water care',
  upgradedWaterCare: 'Upgraded water care', startupChemicals: 'Startup chemicals', coolZone: 'Cool Zone',
  accessories: 'Accessories', spaRemoval: 'Spa removal', fuelSurcharge: 'Fuel surcharge', discount: 'Discount' };
const FIELD_LABEL = { coverType: 'type', brand: 'brand', lift: 'lift', otherLift: 'other lift', price: 'price',
  included: 'Included', type: '', provided: 'provided', amperage: 'amps', autoDosing: 'auto dosing', fwssIq: 'FWSS/IQ',
  yes: '', extWarranty: 'ext. warranty', items: '', other: 'other', amount: 'amount', reason: 'reason' };
const SERVICE_LABEL = { inTownDelivery: 'In-town delivery', crane: 'Crane', craneFee: 'Crane fee',
  outOfTownDelivery: 'Out-of-town delivery', outOfTownDeliveryFee: 'Out-of-town delivery fee',
  outOfTownWarranty: 'Out-of-town warranty', outOfTownWarrantyFee: 'Out-of-town warranty fee' };
const CUSTOMER_FIELDS = [['name', 'Name'], ['phone.cell', 'Cell'], ['phone.home', 'Home phone'], ['phone.work', 'Work phone'],
  ['email', 'Email'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'],
  ['gated', 'Gated'], ['gateCode', 'Gate code'], ['heardAbout', 'How heard']];
const DIFF_FIELDS = [
  ...CUSTOMER_FIELDS.map(([p, l]) => ['customer.' + p, l]),
  ['deliveryDate', 'Delivery date'], ['saleChannel.channel', 'Sold at'], ['saleChannel.location', 'Booth location'],
  ['product.make', 'Make'], ['product.series', 'Series'], ['product.model', 'Model'], ['product.year', 'Year'],
  ['product.shellColor', 'Shell colour'], ['product.cabinetColor', 'Cabinet colour'], ['product.coverColor', 'Cover colour'],
  ['product.included.speaker', 'Speaker'],
  ...['manufacturer', 'dealership'].flatMap(w => Object.keys(WARRANTY_FIELDS).map(f =>
    [`warranty.${w}.${f}`, `${w === 'manufacturer' ? 'Manufacturer' : 'Dealership'} warranty ${{ brands: 'brands', componentYrs: 'components yrs', shellYrs: 'shell yrs', cabinetYrs: 'cabinet yrs' }[f]}`])),
  ['electrical.pamphletProvided', 'Pamphlet provided'], ['electrical.ownElectrician', 'Own electrician'], ['electrical.notes', 'Electrical notes'],
  ['misc.notes', 'Notes'], ['misc.monthlyCleanings', 'Monthly cleanings'], ['misc.cleaningPrice', 'Cleaning price/mo'],
  ['misc.cleaningMonths', 'Cleaning months'], ['misc.cleaningIncluded', 'Cleanings included'],
  ['details.spaPrice', 'Spa price'],
  ...Object.entries(PRICING_FIELDS).flatMap(([item, fields]) =>
    Object.keys(fields).map(f => [`details.${item}.${f}`, [ITEM_LABEL[item], FIELD_LABEL[f]].filter(Boolean).join(' ')])),
  ...Object.keys(SERVICE_FIELDS).map(f => [`service.${f}`, SERVICE_LABEL[f]]),
  ['costing.taxPercent', 'Tax %'],
];
// The fields the totals come from.
const PRICE_DIFF_FIELDS = DIFF_FIELDS.filter(([p]) => /^(details|service|costing)\./.test(p));
const TOTALS_MISMATCH = 'The totals don\'t add up — refresh the page and try again.';

// The new customer block (only contact fields when closed) — or { error }.
function editCustomer(before = {}, input = {}, closed) {
  const pick = k => (!closed || ['phone', 'email', 'gated', 'gateCode'].includes(k));
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  const next = { ...before };
  if (pick('name')) next.name = s(input.name, 100);
  if (pick('email')) next.email = s(input.email, 100);
  if (pick('address')) next.address = s(input.address, 150);
  if (pick('city')) next.city = s(input.city, 60);
  if (pick('state')) next.state = s(input.state, 2).toUpperCase() || 'AZ';
  if (pick('zip')) next.zip = s(input.zip, 10);
  if (pick('gated')) next.gated = !!input.gated;
  if (pick('gateCode')) next.gateCode = next.gated ? s(input.gateCode, 20) : '';
  if (pick('heardAbout')) next.heardAbout = s(input.heardAbout, 100);
  const { phone, error } = normalizeContractPhones(input.phone || {});
  if (error) return { error };
  next.phone = phone;
  if (!next.name) return { error: 'Customer name is required' };
  if (!closed && !next.city) return { error: 'City is required' };
  if (!closed && !/^\d{5}$/.test(next.zip || '')) return { error: 'Zip is required (5 digits)' };
  if (next.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email)) return { error: 'Email looks wrong: ' + next.email };
  return { customer: next };
}

/**
 * The edited contract data from the Edit page's form (collectData() shape),
 * its totals, the balance and the change list — or { error }.
 * opts.linkedUnit: the inventory unit linked to the contract (make / model then
 * come from it and can't be changed here).
 */
function planContractEdit(db, contract, form = {}, opts = {}) {
  const data = JSON.parse(contract.data || '{}');
  const closed = CLOSED.includes(contract.status);
  const next = { ...data };

  const cu = editCustomer(data.customer, form.customer, closed);
  if (cu.error) return { error: cu.error };
  next.customer = cu.customer;

  let totals = null, paid = totalPaid(db, contract.id), balance = Number(contract.due_prior) || 0;
  if (!closed) {
    // Requested delivery date and Sold at
    const dd = String(form.deliveryDate ?? '').trim();
    if (dd && !/^\d{4}-\d{2}-\d{2}$/.test(dd)) return { error: 'Delivery date looks wrong: ' + dd };
    next.deliveryDate = dd;
    next.saleChannel = cleanSaleChannel(form.saleChannel);

    // Spa details — make / model only while no spa is linked.
    const fp = form.product || {}, pr = { ...(data.product || {}) };
    const make = normalizeMake(clean(S, fp.make, 50)), model = clean(S, fp.model, 50);
    if (opts.linkedUnit) {
      const differs = (a, b) => String(a || '').trim().toLowerCase() !== String(b || '').trim().toLowerCase();
      if (differs(make, pr.make) || differs(model, pr.model)) {
        return { error: `Make and model come from the linked spa (${opts.linkedUnit.serial_number || 'on order'}) — an admin changes the spa with Inventory Search.` };
      }
    } else {
      if (!make || !model) return { error: 'Spa Make and Model are required' };
      pr.make = make; pr.model = model;
    }
    pr.series = clean(S, fp.series, 50);
    pr.year = clean(S, fp.year, 4);
    pr.shellColor = normalizeColour(pr.make, 'shell', clean(S, fp.shellColor, 50));
    pr.cabinetColor = normalizeColour(pr.make, 'cabinet', clean(S, fp.cabinetColor, 50));
    pr.coverColor = clean(S, fp.coverColor, 50);
    pr.included = { ...(pr.included || {}), speaker: !!(fp.included && fp.included.speaker) };
    next.product = pr;

    // Warranty, electrical, misc (+ monthly cleanings)
    const w = data.warranty || {}, fw = form.warranty || {};
    next.warranty = { ...w, manufacturer: pickInto(w.manufacturer, fw.manufacturer, WARRANTY_FIELDS),
      dealership: pickInto(w.dealership, fw.dealership, WARRANTY_FIELDS) };
    next.electrical = pickInto(data.electrical, form.electrical, ELECTRICAL_FIELDS);
    next.misc = pickInto(data.misc, form.misc, MISC_FIELDS);
    const m = next.misc.cleaningMonths;
    if (m && !(/^\d+$/.test(m) && +m >= 1 && +m <= 60)) return { error: 'Monthly cleanings: months must be a whole number from 1 to 60' };

    // Line items, services, discount, tax %
    const details = { ...(data.details || {}), spaPrice: clean(S, form.details?.spaPrice) };
    for (const [item, fields] of Object.entries(PRICING_FIELDS)) details[item] = pickInto(details[item], form.details?.[item], fields);
    const service = pickInto(data.service, form.service, SERVICE_FIELDS);
    const taxPercent = clean(S, form.costing?.taxPercent);
    // Totals are worked out again only when a price, line item, fee, discount
    // or tax % changed — a contact or colour fix never moves the Grand Total
    // (an older contract's saved total may not match the formula exactly).
    const priced = { details, service, costing: { ...(data.costing || {}), taxPercent } };
    if (!diff(data, priced, PRICE_DIFF_FIELDS).length) {
      return finish(db, contract, data, next, closed, null, paid, balance);
    }
    const bad = moneyError([['Spa price', details.spaPrice],
      ...Object.entries(PRICING_FIELDS).flatMap(([item, f]) => ('price' in f ? [[`${ITEM_LABEL[item]} price`, details[item].price]] : [])),
      ['Discount amount', details.discount.amount], ['Crane fee', service.craneFee],
      ['Out-of-town delivery fee', service.outOfTownDeliveryFee], ['Out-of-town warranty fee', service.outOfTownWarrantyFee],
      ['Monthly cleaning price', next.misc.cleaningPrice]]);
    if (bad) return { error: bad };
    if (!/^\d+(\.\d+)?$/.test(taxPercent || '0') || Number(taxPercent) > 20) return { error: 'Tax % looks wrong: ' + taxPercent };
    if (!(Number(String(details.spaPrice).replace(/[$,]/g, '')) > 0)) return { error: 'Spa price is required' };
    totals = computeTotals(details, service, taxPercent);
    // The Grand Total the page showed must be the one saved.
    const pageTotal = form.costing?.grandTotal;
    if (pageTotal !== undefined && String(pageTotal).trim() !== '' && Math.abs(num(pageTotal) - totals.grandTotal) > 0.01) {
      console.warn(`[Contract edit] ${contract.contract_number}: page total ${pageTotal} ≠ server total ${totals.grandTotal}`);
      return { error: TOTALS_MISMATCH };
    }
    if (totals.grandTotal + 0.005 < paid) {
      return { error: `Payments ($${show(paid)}) are more than the new total ($${show(totals.grandTotal)}) — void the extra payment first.` };
    }
    balance = cents(Math.max(0, totals.grandTotal - paid));
    next.details = details;
    next.service = service;
    next.costing = { ...(data.costing || {}), ...costingFrom(totals, taxPercent) };
    if (next.payment) next.payment = { ...next.payment, duePriorToDelivery: show(balance) };
  }

  return finish(db, contract, data, next, closed, totals, paid, balance);
}

function finish(db, contract, data, next, closed, totals, paid, balance) {
  return {
    data: next, closed, totals, paid, balance,
    changes: diff(data, next, DIFF_FIELDS),
    before: { grandTotal: Number(String(data.costing?.grandTotal ?? contract.grand_total ?? 0).replace(/[$,]/g, '')) || 0,
              balance: Number(contract.due_prior) || 0 },
  };
}

// Images that can be removed on the Edit page: the contract scan, the cheque
// photo and extra images — not the customer's signature, the serial / SKU
// photos from receiving or delivery photos (records of what happened).
function removableImage(path, label) {
  const p = String(path || ''), l = String(label || '');
  if (/sig-contract-customer/i.test(p) || /signature/i.test(l)) return false;
  if (/^(serial number photo|sku barcode photo|delivery photo)/i.test(l) || /(serial-photo|sku-photo|delivery-photo)/i.test(p)) return false;
  return true;
}

module.exports = { editBlockReason, planContractEdit, changeText, removableImage, CLOSED, TOTALS_MISMATCH };
