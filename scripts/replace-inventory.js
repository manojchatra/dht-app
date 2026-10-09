/**
 * Replace the app's inventory with a new stock sheet, keeping every unit that
 * belongs to a contract (see services/inventoryReplace.js for the rules).
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/replace-inventory.js <file.xlsx>              # report only — changes nothing
 *   node scripts/replace-inventory.js <file.xlsx> --apply      # backup, replace, rewrite the Sheet tab
 *   node scripts/replace-inventory.js --sheet-only             # just rewrite the "Inventory Items" tab from the app
 *
 * The sheet's first tab is read; expected headers: Serial Number, SKU Number, Make,
 * Series, Model, Year, Shell Color, Cabinet Color, Location, Steps, Cover,
 * Finance, Speaker, Truck Number, Weborder, Line, Bay.
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const db = require(path.join(__dirname, '../db/database'));
const { rewriteInventoryItemsTab } = require(path.join(__dirname, '../services/driveInventory'));
const { parseSheetRows, planReplace, applyReplace } = require(path.join(__dirname, '../services/inventoryReplace'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHEET_ONLY = args.includes('--sheet-only');
const file = args.find(a => !a.startsWith('--'));

function list(title, items, fmt, max = 60) {
  console.log(`\n${title}: ${items.length}`);
  items.slice(0, max).forEach(i => console.log('  ' + fmt(i)));
  if (items.length > max) console.log(`  … and ${items.length - max} more`);
}

async function rewriteSheet() {
  const all = db.prepare("SELECT * FROM inventory ORDER BY (availability='Sold'), make, model, serial_number").all();
  try { await rewriteInventoryItemsTab(all); console.log(`Google Sheet "Inventory Items" rewritten: ${all.length} units.`); }
  catch (e) { console.log(`Google Sheet NOT updated (${e.message}). The app's inventory is correct; re-run with --sheet-only later.`); }
}

async function main() {
  if (SHEET_ONLY) return rewriteSheet();
  if (!file) { console.log('Usage: node scripts/replace-inventory.js <file.xlsx> [--apply]'); process.exit(1); }

  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const items = parseSheetRows(rows);
  const plan = planReplace(db, items);

  console.log(`File: ${path.basename(file)} (tab "${wb.SheetNames[0]}") — ${items.length} rows`);
  list('KEPT — units belonging to contracts (never changed)', plan.keep,
    k => `${k.unit.serial_number || '(no serial)'}  ${k.unit.make} ${k.unit.model}  [${k.unit.availability}]  → ${k.contract ? k.contract.contract_number + ' (' + k.contract.status + ')' : 'linked contract'}`);
  list('REMOVED — current units not on any contract', plan.remove,
    u => `${u.serial_number || '(no serial)'}  ${u.make} ${u.model}  [${u.availability}] @ ${u.location || '—'}`, 25);
  const ordered = plan.add.filter(i => i.availability === 'Ordered');
  const noSerial = plan.add.filter(i => !i.serial && i.availability !== 'Ordered');
  console.log(`\nADDED: ${plan.add.length}  (In-stock with serial: ${plan.add.length - ordered.length - noSerial.length}, Ordered on a truck: ${ordered.length}, In-stock without serial: ${noSerial.length})`);
  ordered.forEach(i => console.log(`  Ordered: row ${i.rowNumber}  ${i.make} ${i.model} ${i.year}  truck ${i.truckNumber}`));
  noSerial.forEach(i => console.log(`  No serial: row ${i.rowNumber}  ${i.make} ${i.model} ${i.year} @ ${i.location}`));
  list('SKIPPED — sheet rows for spas already sold on a contract', plan.skipSold,
    s => `row ${s.item.rowNumber}  ${s.item.serial}  ${s.item.make} ${s.item.model}  → ${s.contract ? s.contract.contract_number : 'contract'}`);
  list('LINKED — sold spas with no inventory unit (added as Sold, linked to the contract)', plan.link,
    l => `${l.item.serial}  ${l.item.make} ${l.item.model}  → ${l.contract.contract_number} (${l.contract.status})  [details from ${l.fromSheet ? 'the sheet' : 'the contract'}]`);
  const addSerials = new Set(plan.add.concat(plan.link.map(l => l.item)).map(i => (i.serial || '').toLowerCase()).filter(Boolean));
  const photoUnits = plan.remove.filter(u => u.sku_photo_path || u.serial_photo_path);
  list('Removed units with photos', photoUnits, u => `${u.serial_number}  → ${addSerials.has((u.serial_number || '').toLowerCase()) ? 'photos carried to the new unit' : 'not on the new list (photo files stay on disk)'}`);
  if (plan.warnings.length) list('Warnings', plan.warnings, w => w);

  if (plan.blocking.length) {
    list('BLOCKING — fix the sheet and re-run', plan.blocking, b => b);
    console.log('\nNothing was changed.');
    process.exit(2);
  }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to replace the inventory.'); return; }

  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { stdio: 'inherit' });
  const result = applyReplace(db, plan);
  console.log(`Inventory replaced: removed ${result.removed}, added ${result.added}, linked ${result.linked}, kept ${plan.keep.length}; photos carried over: ${result.photosKept}.`);
  await rewriteSheet();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
