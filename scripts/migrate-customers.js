/**
 * One-time customer clean-up for the "customer record is the source of truth"
 * change. Run ON THE SERVER from the deployed app's directory.
 *
 *   node scripts/migrate-customers.js               report only (no changes)
 *   node scripts/migrate-customers.js --apply       make the changes
 *   node scripts/migrate-customers.js --sync-sheet  (re)write every contract's
 *                                                   row in the Customer Record
 *                                                   Sheet tab (can combine
 *                                                   with --apply)
 *   node scripts/migrate-customers.js --fix-phone DHT-C00006 cell 6021122111
 *                                                   correct one number listed
 *                                                   in section 3 of the report
 *
 * What --apply does, in one transaction:
 *   1. Splits customers that were wrongly merged. The old contract-save code
 *      matched customers by email (or name + zip) and overwrote the record,
 *      so different people sharing an email ended up as ONE customer. Each
 *      contract still has the name as signed; contracts under one customer
 *      with different names are split into separate customers. The group with
 *      the earliest contract keeps the original customer record.
 *   2. Creates a customer for any contract that has none.
 *   3. Formats every customer phone as 602-112-2111. Numbers that aren't 10
 *      digits are left as-is and listed for someone to fix by hand.
 *   4. Deletes customers with no contracts (left behind by deleted contracts).
 *   5. Gives every customer without one a DHT-C number (oldest first).
 *
 * Back up first:  node scripts/backup-db.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require(path.join(__dirname, '../db/database'));
const {
  formatPhone, assignMissingCustomerNumbers, syncCustomerRecord,
} = require(path.join(__dirname, '../services/customers'));

const APPLY      = process.argv.includes('--apply');
const SYNC_SHEET = process.argv.includes('--sync-sheet');

const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const line = () => console.log('-'.repeat(78));

function snapshotOf(contract) {
  try { return JSON.parse(contract.data || '{}').customer || {}; } catch (e) { return {}; }
}

// Customer fields from a contract's signed snapshot (phones formatted if valid).
function fieldsFromSnapshot(s) {
  const p = s.phone || {};
  const fmt = v => formatPhone(v).value;
  return {
    name: s.name || '', email: s.email || '',
    phone_cell: fmt(p.cell), phone_home: fmt(p.home), phone_work: fmt(p.work),
    address: s.address || '', city: s.city || '', state: s.state || 'AZ', zip: s.zip || '',
    gated: s.gated ? 1 : 0, gate_code: s.gateCode || '', heard_about: s.heardAbout || '',
  };
}

function plan() {
  const contracts = db.prepare('SELECT id, contract_number, customer_id, data, created_at FROM contracts ORDER BY created_at, id').all();
  const customers = new Map(db.prepare('SELECT * FROM customers').all().map(c => [c.id, c]));

  const splits = [];      // { customer, keep: [contracts], moves: [[contracts], ...] }
  const unlinked = [];    // contracts with no (existing) customer
  const byCustomer = new Map();
  for (const c of contracts) {
    if (!c.customer_id || !customers.has(c.customer_id)) { unlinked.push(c); continue; }
    if (!byCustomer.has(c.customer_id)) byCustomer.set(c.customer_id, []);
    byCustomer.get(c.customer_id).push(c);
  }
  for (const [custId, list] of byCustomer) {
    const groups = new Map();
    for (const c of list) {
      const key = normName(snapshotOf(c).name) || normName(customers.get(custId).name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    if (groups.size > 1) {
      const [keep, ...moves] = [...groups.values()]; // insertion order = earliest contract first
      splits.push({ customer: customers.get(custId), keep, moves });
    }
  }

  const withContracts = new Set(contracts.map(c => c.customer_id));
  const orphans = [...customers.values()].filter(c => !withContracts.has(c.id));

  // Phones as they'll be AFTER the migration: split/new customers take their
  // details from their latest contract, everyone else keeps their own.
  const phoneIssues = [];
  const checkPhones = (who, f) => ['phone_cell', 'phone_home', 'phone_work'].forEach(col => {
    if (!formatPhone(f[col]).valid) phoneIssues.push({ who, col, value: f[col] });
  });
  const splitIds = new Set(splits.map(s => s.customer.id));
  for (const c of customers.values()) {
    if (!orphans.includes(c) && !splitIds.has(c.id)) checkPhones(`${c.customer_number || '#' + c.id} ${c.name}`, c);
  }
  const rawSnapshotPhones = group => {
    const latest = group[group.length - 1], s = snapshotOf(latest), p = s.phone || {};
    checkPhones(`${latest.contract_number} "${s.name}"`, { phone_cell: p.cell, phone_home: p.home, phone_work: p.work });
  };
  splits.forEach(s => [s.keep, ...s.moves].forEach(rawSnapshotPhones));
  unlinked.forEach(c => rawSnapshotPhones([c]));
  return { splits, unlinked, orphans, phoneIssues };
}

function report({ splits, unlinked, orphans, phoneIssues }) {
  console.log(APPLY ? '\nAPPLYING customer migration\n' : '\nREPORT ONLY — no changes made (add --apply to make them)\n');

  line(); console.log(`1. WRONGLY MERGED CUSTOMERS TO SPLIT: ${splits.length}`); line();
  for (const s of splits) {
    const label = c => `${c.contract_number} "${snapshotOf(c).name}"`;
    console.log(`Customer #${s.customer.id} ${s.customer.customer_number || ''} (currently named "${s.customer.name}")`);
    console.log(`   keeps:     ${s.keep.map(label).join(', ')}`);
    s.moves.forEach(g => console.log(`   new cust.: ${g.map(label).join(', ')}`));
  }

  line(); console.log(`2. CONTRACTS WITH NO CUSTOMER (a customer will be created): ${unlinked.length}`); line();
  unlinked.forEach(c => console.log(`   ${c.contract_number} "${snapshotOf(c).name}"`));

  line(); console.log(`3. PHONE NUMBERS THAT AREN'T 10 DIGITS (fix by hand, left unchanged): ${phoneIssues.length}`); line();
  phoneIssues.forEach(p => console.log(`   ${p.who}: ${p.col} = "${p.value}"`));

  line(); console.log(`4. CUSTOMERS WITH NO CONTRACTS (will be deleted): ${orphans.length}`); line();
  orphans.forEach(c => console.log(`   ${c.customer_number || '#' + c.id} ${c.name} <${c.email || ''}>`));
  console.log('');
}

function apply({ splits, unlinked, orphans }) {
  // New customers are dated from their first contract and numbered at the
  // end (step 5), so DHT-C numbers follow the real order customers arrived in.
  const insert = db.prepare(`INSERT INTO customers
    (created_at,name,email,phone_cell,phone_home,phone_work,address,city,state,zip,gated,gate_code,heard_about)
    VALUES (@created_at,@name,@email,@phone_cell,@phone_home,@phone_work,@address,@city,@state,@zip,@gated,@gate_code,@heard_about)`);
  const update = db.prepare(`UPDATE customers SET name=@name,email=@email,phone_cell=@phone_cell,phone_home=@phone_home,
    phone_work=@phone_work,address=@address,city=@city,state=@state,zip=@zip,gated=@gated,gate_code=@gate_code,
    heard_about=@heard_about WHERE id=@id`);
  const relink = db.prepare('UPDATE contracts SET customer_id=? WHERE id=?');
  const newCustomerFrom = group => {
    const latest = group[group.length - 1];
    const id = insert.run({ created_at: group[0].created_at, ...fieldsFromSnapshot(snapshotOf(latest)) }).lastInsertRowid;
    group.forEach(c => relink.run(id, c.id));
    return id;
  };

  db.transaction(() => {
    // 1. Split — the kept record takes the details of its own latest contract.
    for (const s of splits) {
      const latest = s.keep[s.keep.length - 1];
      update.run({ id: s.customer.id, ...fieldsFromSnapshot(snapshotOf(latest)) });
      s.moves.forEach(newCustomerFrom);
    }
    // 2. Contracts with no customer.
    unlinked.forEach(c => newCustomerFrom([c]));
    // 3. Phone formatting (valid numbers only).
    const setPhone = { phone_cell: db.prepare('UPDATE customers SET phone_cell=? WHERE id=?'),
                       phone_home: db.prepare('UPDATE customers SET phone_home=? WHERE id=?'),
                       phone_work: db.prepare('UPDATE customers SET phone_work=? WHERE id=?') };
    for (const c of db.prepare('SELECT * FROM customers').all()) {
      for (const col of Object.keys(setPhone)) {
        const { value, valid } = formatPhone(c[col]);
        if (valid && value !== (c[col] || '')) setPhone[col].run(value, c.id);
      }
    }
    // 4. Customers with no contracts.
    orphans.forEach(c => db.prepare('DELETE FROM customers WHERE id=? AND NOT EXISTS (SELECT 1 FROM contracts WHERE customer_id=?)').run(c.id, c.id));
  })();
  // 5. Numbers for anyone still missing one.
  assignMissingCustomerNumbers();
  console.log('Migration applied.');
}

async function syncSheet() {
  const ids = db.prepare('SELECT id FROM contracts ORDER BY created_at, id').all().map(r => r.id);
  console.log(`Writing ${ids.length} rows to the Customer Record Sheet tab…`);
  for (const id of ids) await syncCustomerRecord(id);
  console.log('Customer Record tab synced.');
}

// --fix-phone DHT-C00006 cell 602-112-2111 — corrects one reported number
// (there's no customer edit screen yet).
async function fixPhone([custNumber, which, number]) {
  const col = { cell: 'phone_cell', home: 'phone_home', work: 'phone_work' }[which];
  const { value, valid } = formatPhone(number);
  if (!custNumber || !col || !valid) {
    throw new Error('Usage: --fix-phone DHT-C00006 <cell|home|work> <10-digit number, or "" to clear>');
  }
  const cust = db.prepare('SELECT id, name FROM customers WHERE customer_number=?').get(custNumber);
  if (!cust) throw new Error('No customer ' + custNumber);
  db.prepare(`UPDATE customers SET ${col}=? WHERE id=?`).run(value, cust.id);
  console.log(`${custNumber} ${cust.name}: ${which} = "${value}"`);
  const ids = db.prepare('SELECT id FROM contracts WHERE customer_id=?').all(cust.id).map(r => r.id);
  for (const id of ids) await syncCustomerRecord(id);
}

(async () => {
  const fixAt = process.argv.indexOf('--fix-phone');
  if (fixAt !== -1) return fixPhone(process.argv.slice(fixAt + 1));
  const p = plan();
  report(p);
  if (APPLY) apply(p);
  if (SYNC_SHEET) await syncSheet();
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
