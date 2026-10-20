/**
 * Report-only: lists contracts with no spa price, or where the payments
 * recorded add up to more than the Grand Total. Changes nothing (opens the
 * database read-only).
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/find-price-mismatches.js
 */
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/dht-app.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const money = v => parseFloat(String(v ?? '').replace(/[$,]/g, '')) || 0;

const rows = db.prepare(`SELECT c.id, c.contract_number, c.status, c.date, c.created_at, c.data,
    COALESCE((SELECT SUM(amount) FROM payments p WHERE p.contract_id = c.id), 0) AS paid
  FROM contracts c ORDER BY c.id`).all();

const hits = [];
for (const c of rows) {
  let d = {};
  try { d = JSON.parse(c.data || '{}'); } catch (e) { /* treat as empty */ }
  const spa = money(d.details?.spaPrice);
  const total = money(d.costing?.grandTotal);
  const problems = [];
  if (!(spa > 0)) problems.push('no spa price');
  if (c.paid - total > 0.01) problems.push(`paid $${c.paid.toFixed(2)} > Grand Total $${total.toFixed(2)}`);
  if (problems.length) hits.push({ c, d, spa, total, problems });
}

console.log(`Checked ${rows.length} contracts (database: ${DB_PATH}). Problems: ${hits.length}\n`);
for (const { c, d, total, problems } of hits) {
  console.log(`${c.contract_number}  [${c.status}]  created ${c.created_at || c.date || '?'}  ${d.customer?.name || ''}`);
  console.log(`   ${problems.join('; ')}  (Grand Total $${total.toFixed(2)}, paid $${c.paid.toFixed(2)})`);
}
