/**
 * Rename an inventory location on every unit that has it (e.g. "EMP Room" → "Back Room").
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/rename-location.js "EMP Room" "Back Room"            # report only
 *   node scripts/rename-location.js "EMP Room" "Back Room" --apply    # backup, rename, rewrite the Inventory Items Sheet tab
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const [from, to] = args.filter(a => a !== '--apply').map(s => String(s).trim());
if (!from || !to) { console.log('Usage: node scripts/rename-location.js "<old name>" "<new name>" [--apply]'); process.exit(1); }

const units = db.prepare("SELECT id, serial_number, make, model, availability, location FROM inventory WHERE lower(trim(COALESCE(location,''))) = lower(?)").all(from);
console.log(`Units at "${from}": ${units.length}`);
units.forEach(u => console.log(`  ${u.serial_number || 'id ' + u.id}  ${u.make} ${u.model}  [${u.availability}]`));
if (!units.length) process.exit(0);
if (!APPLY) { console.log(`\nREPORT ONLY — nothing was changed. Re-run with --apply to move them to "${to}".`); process.exit(0); }

console.log('\nBacking up the database first…');
execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
const n = db.prepare("UPDATE inventory SET location=?, updated_at=CURRENT_TIMESTAMP WHERE lower(trim(COALESCE(location,''))) = lower(?)").run(to, from).changes;
console.log(`Renamed ${n} unit(s) to "${to}". Rewriting the Google Sheet "Inventory Items" tab…`);
execFileSync(process.execPath, [path.join(__dirname, 'replace-inventory.js'), '--sheet-only'], { stdio: 'inherit' });
