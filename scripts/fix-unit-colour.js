/**
 * Correct wrong colours on inventory units (there's no colour editing in the
 * app). Each fix finds the unit by serial and replaces the colour in whichever
 * column holds it (Shell or Cabinet). A contract linked to a unit is shown but
 * NOT changed — its colours are the signed paperwork. Several fixes per run,
 * one database backup.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/fix-unit-colour.js <serial> "<wrong>" "<right>" [<serial> "<wrong>" "<right>" …]           # report only
 *   node scripts/fix-unit-colour.js <serial> "<wrong>" "<right>" [<serial> "<wrong>" "<right>" …] --apply   # backup, save, rewrite the Sheet tab
 * An on-order spa has no serial yet — use its inventory id instead: id:455 "Alpine White" "Arctic White"
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const vals = args.filter(a => a !== '--apply').map(s => String(s).trim());
if (!vals.length || vals.length % 3) {
  console.log('Usage: node scripts/fix-unit-colour.js <serial> "<wrong colour>" "<right colour>" [more triples…] [--apply]');
  process.exit(1);
}

const plan = [];
let problems = 0;
for (let i = 0; i < vals.length; i += 3) {
  const [ref, from, to] = vals.slice(i, i + 3);
  // "id:455" for on-order spas, which have no serial yet; otherwise a serial.
  const byId = /^id:\d+$/i.test(ref);
  const u = byId ? db.prepare('SELECT * FROM inventory WHERE id=?').get(parseInt(ref.slice(3), 10))
                 : db.prepare('SELECT * FROM inventory WHERE serial_number=?').get(ref);
  if (!u) { console.log(`${ref}: no inventory unit with this ${byId ? 'id' : 'serial'} — skipped`); problems++; continue; }
  const serial = u.serial_number || `id ${u.id} (on order, Truck ${u.truck_number || '—'})`;
  const same = v => String(v || '').trim().toLowerCase() === from.toLowerCase();
  const cols = ['shell_color', 'cabinet_color'].filter(k => same(u[k]));
  const head = `${serial}  ${u.make} ${u.model}  shell "${u.shell_color || ''}"  cabinet "${u.cabinet_color || ''}"  [${u.availability}]`;
  if (cols.length !== 1) {
    console.log(`${head}\n  ${cols.length ? `"${from}" is in both Shell and Cabinet` : `neither colour is "${from}"`} — skipped`);
    problems++; continue;
  }
  const label = cols[0] === 'shell_color' ? 'Shell' : 'Cabinet';
  console.log(`${head}\n  ${label}: "${u[cols[0]]}" → "${to}"`);
  if (u.contract_id) {
    const c = db.prepare('SELECT contract_number, data FROM contracts WHERE id=?').get(u.contract_id);
    const pr = (() => { try { return JSON.parse(c.data || '{}').product || {}; } catch (e) { return {}; } })();
    console.log(`  Note: linked to ${c.contract_number} (contract says ${pr.shellColor || '—'} / ${pr.cabinetColor || '—'}) — the contract is not changed.`);
  }
  plan.push({ id: u.id, col: cols[0], to });
}

console.log(`\n${plan.length} fix(es) ready${problems ? `, ${problems} skipped` : ''}.`);
if (!APPLY || !plan.length) { console.log(APPLY ? 'Nothing to save.' : 'REPORT ONLY — nothing was changed. Re-run with --apply to save.'); process.exit(0); }

console.log('Backing up the database first…');
execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
db.transaction(() => {
  for (const f of plan) db.prepare(`UPDATE inventory SET ${f.col}=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(f.to, f.id);
})();
console.log(`Saved ${plan.length} fix(es). Rewriting the Google Sheet "Inventory Items" tab…`);
execFileSync(process.execPath, [path.join(__dirname, 'replace-inventory.js'), '--sheet-only'], { stdio: 'inherit' });
