/**
 * Bring inventory shell / cabinet colours to the SKU List's names (utils/colours.js):
 *   - other spellings → standard ("Tuscan Sun" → "Tuscan", "Nickel" → "Brushed Nickel",
 *     HotSpring "Diamond" → "Diamond Weave", Caldera shell "Taupe" → "Natural Taupe" …)
 *   - shell and cabinet swapped (each is the other part's colour for that brand) → swapped back
 *   - cold plunges (Vigor / Emerge) with the colour in Shell and Cabinet empty → moved to Cabinet
 * Anything else not on its brand's list is reported, not changed. Contracts are never changed.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/normalize-colours.js            # report only
 *   node scripts/normalize-colours.js --apply    # backup, fix, rewrite the Inventory Items Sheet tab
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { buildColourLists, planColourFix: planUnit } = require(path.join(__dirname, '../utils/colours'));

const APPLY = process.argv.includes('--apply');

async function main() {
  let rows = [];
  try { rows = await require(path.join(__dirname, '../services/driveInventory')).getSkuList(true); }
  catch (e) { console.log(`(SKU List not readable — using the built-in snapshot: ${e.message})`); }
  const lists = buildColourLists(rows);

  const units = db.prepare('SELECT id, serial_number, make, model, shell_color, cabinet_color, truck_number FROM inventory ORDER BY make, model, id').all();
  const changes = [], off = [];
  for (const u of units) {
    const p = planUnit(u, lists);
    const label = `${u.serial_number || `id ${u.id} (on order${u.truck_number ? ', Truck ' + u.truck_number : ''})`}  ${u.make} ${u.model}`;
    if (p.changed) changes.push({ u, p, label });
    if (p.offList.length) off.push(`${label}: ${p.offList.join(', ')}`);
  }

  console.log(`To change: ${changes.length} unit(s)`);
  changes.forEach(({ u, p, label }) => console.log(`  ${label}:  "${u.shell_color || ''}" / "${u.cabinet_color || ''}"  →  "${p.shell}" / "${p.cabinet}"   (${p.why.join(', ')})`));
  console.log(`\nNot on the brand's colour list — left as is: ${off.length}`);
  off.forEach(s => console.log('  ' + s));

  if (!changes.length) return;
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to fix.'); return; }
  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
  db.transaction(() => {
    for (const { u, p } of changes) db.prepare('UPDATE inventory SET shell_color=?, cabinet_color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.shell, p.cabinet, u.id);
  })();
  console.log(`Fixed ${changes.length} unit(s). Rewriting the Google Sheet "Inventory Items" tab…`);
  execFileSync(process.execPath, [path.join(__dirname, 'replace-inventory.js'), '--sheet-only'], { stdio: 'inherit' });
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
