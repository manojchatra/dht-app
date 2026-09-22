/**
 * Read-only report to help identify test data (sales/warehouse users and
 * their contracts) before a client handover. Makes no changes — just prints
 * everything so you can pick out which usernames/contract numbers are real
 * test artifacts vs. anything that should stay.
 *
 * Run this ON THE SERVER where the app actually runs (this reads the same
 * db/database.js the app itself uses, so it needs to run from inside the
 * deployed app's own directory — same as any other scripts/*.js in here).
 *
 * Usage: node scripts/list-test-data.js
 */
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));

console.log('='.repeat(70));
console.log('SALES + WAREHOUSE USERS');
console.log('='.repeat(70));
const users = db.prepare(`
  SELECT id, username, name, email, role, active, created_at
  FROM users
  WHERE role IN ('sales','warehouse')
  ORDER BY created_at
`).all();

if (!users.length) {
  console.log('(none)');
} else {
  for (const u of users) {
    const contractCount = db.prepare(
      'SELECT COUNT(*) AS c FROM contracts WHERE salesman_user_id=?'
    ).get(u.id).c;
    console.log(
      `id=${u.id}  username=${u.username}  name=${u.name||'(none)'}  role=${u.role}  ` +
      `active=${u.active}  created=${u.created_at}  contracts=${contractCount}`
    );
  }
}

console.log('');
console.log('='.repeat(70));
console.log('ALL CONTRACTS (with salesperson attribution)');
console.log('='.repeat(70));
const contracts = db.prepare(`
  SELECT c.id, c.contract_number, c.store, c.date, c.status, c.created_at,
         c.salesman, c.salesman_user_id,
         u.username AS salesman_username,
         COALESCE(json_extract(c.data,'$.customer.name'), cu.name, '') AS customer_name
  FROM contracts c
  LEFT JOIN users u ON u.id = c.salesman_user_id
  LEFT JOIN customers cu ON cu.id = c.customer_id
  ORDER BY c.created_at
`).all();

if (!contracts.length) {
  console.log('(none)');
} else {
  for (const c of contracts) {
    console.log(
      `id=${c.id}  ${c.contract_number}  customer="${c.customer_name}"  status=${c.status}  ` +
      `salesman="${c.salesman||''}"${c.salesman_username ? ' (user: '+c.salesman_username+')' : ''}  ` +
      `store=${c.store}  created=${c.created_at}`
    );
  }
}

console.log('');
console.log('Next step: pick out the test usernames and/or contract numbers from');
console.log('above, then run:');
console.log('  node scripts/cleanup-test-data.js --users=<username1>,<username2> --contracts=<num1>,<num2> --dry-run');
console.log('to preview exactly what would be removed before anything actually runs.');
