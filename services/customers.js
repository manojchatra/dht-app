/**
 * customers.js — the customer record is the source of truth for a customer's
 * name / phone / email. Each contract keeps its own snapshot in contracts.data
 * (the signed document) plus its own delivery address.
 *
 * - Phone numbers: always stored and shown as 602-112-2111 (10 digits).
 * - Customer number: DHT-C00001, from settings.customer_sequence, never reused.
 * - Matching: used by the "Existing customer?" popup on the contract form.
 * - Customer Record Sheet tab: one row per contract, kept in sync from here.
 */
const db = require('../db/database');
const { upsertCustomerRecordRow, deleteCustomerRecordRow } = require('./driveInventory');

// ── Phone numbers ─────────────────────────────────────────────────────────────
function phoneDigits(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1); // drop US country code
  return d;
}

// Returns { value, valid }. Empty input is valid (value ''); anything that
// isn't exactly 10 digits is invalid.
function formatPhone(raw) {
  const d = phoneDigits(raw);
  if (!d) return { value: '', valid: true };
  if (d.length !== 10) return { value: String(raw || '').trim(), valid: false };
  return { value: `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`, valid: true };
}

// Validates/format the contract form's { cell, home, work }. At least one is
// required. Returns { phone, error }.
const PHONE_LABELS = { cell: 'Cell', home: 'Home', work: 'Work' };
function normalizeContractPhones(phone = {}) {
  const out = {};
  for (const key of Object.keys(PHONE_LABELS)) {
    const { value, valid } = formatPhone(phone[key]);
    if (!valid) return { phone: null, error: `${PHONE_LABELS[key]} phone must be a 10-digit number (e.g. 602-112-2111)` };
    out[key] = value;
  }
  if (!out.cell && !out.home && !out.work) {
    return { phone: null, error: 'At least one phone number (Cell, Home or Work) is required' };
  }
  return { phone: out, error: null };
}

function primaryPhone(c) {
  return (c && (c.phone_cell || c.phone_home || c.phone_work)) || '';
}

// ── Customer number ───────────────────────────────────────────────────────────
function nextCustomerNumber() {
  db.prepare("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'customer_sequence'").run();
  const seq = parseInt(db.prepare("SELECT value FROM settings WHERE key='customer_sequence'").get().value, 10);
  return 'DHT-C' + String(seq).padStart(5, '0');
}

// Numbers any customer that doesn't have one yet, oldest first. Idempotent —
// runs at every startup, so it also covers customers created by the split in
// scripts/migrate-customers.js.
function assignMissingCustomerNumbers() {
  const missing = db.prepare('SELECT id FROM customers WHERE customer_number IS NULL ORDER BY created_at, id').all();
  if (!missing.length) return 0;
  const set = db.prepare('UPDATE customers SET customer_number=? WHERE id=?');
  db.transaction(() => missing.forEach(c => set.run(nextCustomerNumber(), c.id)))();
  console.log('[Customers] Customer numbers assigned:', missing.length);
  return missing.length;
}

// ── Matching (for the "Existing customer?" popup) ─────────────────────────────
// Only phone or email finds a customer — a name alone is too weak (two people
// can share one), so the name is only used to confirm a phone/email match.
// Capped so the popup stays short however many customers are on file.
const MAX_MATCHES = 5;
const SQL_DIGITS = col => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${col},''),'-',''),' ',''),'(',''),')',''),'.','')`;

function findMatches({ phones = [], email = '', name = '' } = {}) {
  const digits = [...new Set(phones.map(phoneDigits).filter(d => d.length === 10))];
  const mail   = String(email || '').trim().toLowerCase();
  const nm     = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const byId = new Map();
  function add(rows, reason) {
    for (const r of rows) {
      const m = byId.get(r.id) || { ...r, reasons: [] };
      if (!m.reasons.includes(reason)) m.reasons.push(reason);
      byId.set(r.id, m);
    }
  }
  if (digits.length) {
    const marks = digits.map(() => '?').join(',');
    add(db.prepare(`SELECT * FROM customers WHERE ${SQL_DIGITS('phone_cell')} IN (${marks})
      OR ${SQL_DIGITS('phone_home')} IN (${marks}) OR ${SQL_DIGITS('phone_work')} IN (${marks})`)
      .all(...digits, ...digits, ...digits), 'phone');
  }
  if (mail) add(db.prepare(`SELECT * FROM customers WHERE LOWER(TRIM(email)) = ? AND email != ''`).all(mail), 'email');
  if (nm) {
    for (const m of byId.values()) {
      if (String(m.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === nm) m.reasons.push('name');
    }
  }

  const lastContract = db.prepare('SELECT date, store FROM contracts WHERE customer_id=? ORDER BY date DESC, id DESC LIMIT 1');
  const countContracts = db.prepare('SELECT COUNT(*) AS n FROM contracts WHERE customer_id=?');
  return [...byId.values()]
    .map(c => ({
      id: c.id,
      customerNumber: c.customer_number,
      name: c.name,
      email: c.email || '',
      phone: { cell: c.phone_cell || '', home: c.phone_home || '', work: c.phone_work || '' },
      address: c.address || '', city: c.city || '', state: c.state || '', zip: c.zip || '',
      gated: !!c.gated, gateCode: c.gate_code || '', heardAbout: c.heard_about || '',
      matchedOn: c.reasons,
      contractCount: countContracts.get(c.id).n,
      lastContract: lastContract.get(c.id) || null,
    }))
    // Most signals first (phone + email + name), then most contracts.
    .sort((a, b) => (b.matchedOn.length - a.matchedOn.length) || (b.contractCount - a.contractCount))
    .slice(0, MAX_MATCHES);
}

// ── Customer Record Sheet tab ─────────────────────────────────────────────────
const STATUS_LABEL = {
  assigned: 'Assigned', tbo: 'To Be Ordered', order_placed: 'Order Placed', received: 'Received',
  scheduled: 'Scheduled', delivered: 'Delivered', cancelled: 'Cancelled',
};

// Name/phone from the customer record; address/city from the contract's own
// delivery address. Delivery Date only once actually delivered.
async function syncCustomerRecord(contractId) {
  try {
    const c = db.prepare(`SELECT c.*, cu.customer_number, cu.name AS cu_name,
        cu.phone_cell, cu.phone_home, cu.phone_work, cu.address AS cu_address, cu.city AS cu_city
      FROM contracts c LEFT JOIN customers cu ON c.customer_id = cu.id WHERE c.id=?`).get(contractId);
    if (!c) return;
    const snap = JSON.parse(c.data || '{}').customer || {};
    await upsertCustomerRecordRow({
      customerNumber: c.customer_number || '',
      contractNumber: c.contract_number,
      name:    c.cu_name || snap.name || '',
      phone:   primaryPhone(c),
      address: snap.address || c.cu_address || '',
      city:    snap.city || c.cu_city || '',
      brand:   c.make || '', model: c.model || '',
      serialNumber: c.serial_number || '',
      deliveryDate: c.status === 'delivered' ? (c.delivery_date || '') : '',
      salesman: c.salesman || '',
      status:  STATUS_LABEL[c.status] || c.status || '',
    });
  } catch (e) {
    console.error('[Customer Record sync failed — non-fatal]', e.message);
  }
}

async function syncCustomerRecordsForCustomer(customerId) {
  const ids = db.prepare('SELECT id FROM contracts WHERE customer_id=?').all(customerId).map(r => r.id);
  for (const id of ids) await syncCustomerRecord(id);
}

async function removeCustomerRecord(contractNumber) {
  try { await deleteCustomerRecordRow(contractNumber); }
  catch (e) { console.error('[Customer Record delete failed — non-fatal]', e.message); }
}

// A customer whose last contract was deleted is removed too (deleting a
// contract is for mistakes/test entries). Cancelled contracts still count as
// contracts, so real customers who backed out are kept.
function deleteCustomerIfOrphan(customerId) {
  if (!customerId) return false;
  const n = db.prepare('SELECT COUNT(*) AS n FROM contracts WHERE customer_id=?').get(customerId).n;
  if (n > 0) return false;
  db.prepare('DELETE FROM customers WHERE id=?').run(customerId);
  return true;
}

module.exports = {
  phoneDigits, formatPhone, normalizeContractPhones, primaryPhone,
  nextCustomerNumber, assignMissingCustomerNumbers,
  findMatches,
  syncCustomerRecord, syncCustomerRecordsForCustomer, removeCustomerRecord,
  deleteCustomerIfOrphan,
};
