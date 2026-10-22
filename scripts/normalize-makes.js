/**
 * Make brand spellings consistent ("Hotspring" / "Hot Spring" → "HotSpring")
 * across inventory and contracts, so brand filters and on-order matching see
 * one brand, not several. Spellings that differ only in capitals or spaces are
 * merged: into the app's standard name when there is one (utils/makes.js, which
 * also maps known aliases like "Endless Pool" → "Endless Pools"), else into the
 * most common spelling. Anything else is only listed.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/normalize-makes.js            # report only
 *   node scripts/normalize-makes.js --apply    # backup, fix, rewrite the Inventory Items Sheet tab
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { STANDARD_MAKES: STANDARD, ALIASES, makeKey: key } = require(path.join(__dirname, '../utils/makes'));

const APPLY = process.argv.includes('--apply');
const standardFor = k => STANDARD.find(s => key(s) === k) || ALIASES[k];

const inv = db.prepare("SELECT id, make FROM inventory WHERE TRIM(COALESCE(make,'')) <> ''").all();
const con = db.prepare("SELECT id, make, data FROM contracts").all().map(c => {
  let d = {}; try { d = JSON.parse(c.data || '{}'); } catch (e) { /* leave */ }
  return { id: c.id, make: c.make || d.product?.make || '', data: d };
}).filter(c => String(c.make).trim());

// spelling -> counts, grouped by key
const groups = new Map();
for (const [src, rows] of [['inventory', inv], ['contracts', con]]) {
  for (const r of rows) {
    const k = key(r.make);
    if (!groups.has(k)) groups.set(k, new Map());
    const g = groups.get(k);
    const s = String(r.make).trim();
    g.set(s, g.get(s) || { inventory: 0, contracts: 0 });
    g.get(s)[src]++;
  }
}

const fix = new Map(); // exact spelling -> standard spelling
console.log('Brands found (inventory / contracts):');
for (const [k, g] of [...groups].sort()) {
  const spellings = [...g.keys()];
  const std = standardFor(k) ||
    spellings.sort((a, b) => (g.get(b).inventory + g.get(b).contracts) - (g.get(a).inventory + g.get(a).contracts))[0];
  for (const s of spellings) {
    const n = g.get(s);
    const change = s !== std;
    if (change) fix.set(s, std);
    console.log(`  ${s.padEnd(22)} ${String(n.inventory).padStart(4)} / ${String(n.contracts).padStart(3)}${change ? `   → "${std}"` : ''}`);
  }
}
const unknown = [...groups.keys()].filter(k => !standardFor(k));
if (unknown.length) console.log(`\nNot a standard brand name (left as is — tell Claude if any should be merged): ${unknown.map(k => [...groups.get(k).keys()][0]).join(', ')}`);

const invFix = inv.filter(r => fix.has(String(r.make).trim()));
const conFix = con.filter(r => fix.has(String(r.make).trim()));
console.log(`\nTo change: ${invFix.length} inventory unit(s), ${conFix.length} contract(s).`);
if (!invFix.length && !conFix.length) process.exit(0);
if (!APPLY) { console.log('REPORT ONLY — nothing was changed. Re-run with --apply to fix.'); process.exit(0); }

console.log('Backing up the database first…');
execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { stdio: 'inherit' });
db.transaction(() => {
  for (const r of invFix) db.prepare('UPDATE inventory SET make=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(fix.get(String(r.make).trim()), r.id);
  for (const r of conFix) {
    const std = fix.get(String(r.make).trim());
    if (r.data.product) r.data.product.make = std;
    db.prepare('UPDATE contracts SET make=?, data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(std, JSON.stringify(r.data), r.id);
  }
})();
console.log(`Fixed ${invFix.length} inventory unit(s) and ${conFix.length} contract(s). Rewriting the Google Sheet "Inventory Items" tab…`);
execFileSync(process.execPath, [path.join(__dirname, 'replace-inventory.js'), '--sheet-only'], { stdio: 'inherit' });
