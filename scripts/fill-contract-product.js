/**
 * Fill in spa details a salesperson left blank on a contract (Make, Series,
 * Model). Only BLANK fields are filled — anything already on the contract is
 * never overwritten. Each change is written to the contract's activity log.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/fill-contract-product.js <contract#> --make HotSpring --series Highlife [--model Prodigy]           # report only
 *   node scripts/fill-contract-product.js <contract#> --make HotSpring --series Highlife [--model Prodigy] --apply   # backup, then save
 *
 * The contract's Google Sheet row picks the new values up on its next status
 * move (e.g. Move to Order Placed rebuilds the row from the contract).
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contractNumber = args[0] && !args[0].startsWith('--') ? args[0].trim() : '';
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? String(args[i + 1] || '').trim() : ''; };
const wanted = { make: opt('make'), series: opt('series'), model: opt('model') };

if (!contractNumber || !Object.values(wanted).some(Boolean)) {
  console.log('Usage: node scripts/fill-contract-product.js <contract#> --make X [--series Y] [--model Z] [--apply]');
  process.exit(1);
}

const c = db.prepare('SELECT * FROM contracts WHERE contract_number=?').get(contractNumber);
if (!c) { console.log(`Contract ${contractNumber} not found.`); process.exit(1); }
const data = JSON.parse(c.data || '{}');
const p = data.product || (data.product = {});

console.log(`${c.contract_number}  [${c.status}]  ${data.customer?.name || ''}`);
console.log(`  now:  make "${p.make || c.make || ''}"  series "${p.series || ''}"  model "${p.model || c.model || ''}"`);

const changes = [];
for (const field of ['make', 'series', 'model']) {
  if (!wanted[field]) continue;
  const current = String(p[field] || (field !== 'series' ? c[field] : '') || '').trim();
  if (current && current.toLowerCase() !== wanted[field].toLowerCase()) {
    console.log(`  ${field}: already "${current}" — NOT changed (only blank fields are filled)`);
  } else if (!current) {
    changes.push({ field, value: wanted[field] });
  }
}
if (!changes.length) { console.log('  Nothing to fill in.'); process.exit(0); }
changes.forEach(ch => console.log(`  fill: ${ch.field} → "${ch.value}"`));
if (c.status !== 'tbo') console.log(`  Note: contract is "${c.status}", not To Be Ordered — the on-order suggestion appears only in Move to Order Placed.`);

if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to save.'); process.exit(0); }

console.log('\nBacking up the database first…');
execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { stdio: 'inherit' });
for (const ch of changes) p[ch.field] = ch.value;
db.prepare('UPDATE contracts SET make=?, model=?, data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
  .run(p.make || c.make || '', p.model || c.model || '', JSON.stringify(data), c.id);
logActivity(db, { contractId: c.id, contractNum: c.contract_number, eventType: 'CONTRACT_UPDATED', actor: 'admin-script',
  detail: 'Filled in blank spa details: ' + changes.map(ch => `${ch.field} "${ch.value}"`).join(', ') });
console.log(`Saved: ${changes.map(ch => `${ch.field} "${ch.value}"`).join(', ')}.`);
