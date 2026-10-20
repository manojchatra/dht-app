/**
 * Add a sheet's units to the app's inventory WITHOUT removing or changing anything
 * already there (unlike replace-inventory.js). Rows whose serial is already in the
 * inventory, or on a contract, are skipped. Blank serial = In-stock, serial added later.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/add-inventory.js <file.xlsx>              # report only — changes nothing
 *   node scripts/add-inventory.js <file.xlsx> --apply      # backup, add, rewrite the Sheet tab
 *
 * Same headers as replace-inventory.js: Serial Number, SKU Number, Make, Series, Model,
 * Year, Shell Color, Cabinet Color, Location, Steps, Cover, Finance, Speaker,
 * Truck Number, Weborder, Line, Bay.
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const db = require(path.join(__dirname, '../db/database'));
const { rewriteInventoryItemsTab } = require(path.join(__dirname, '../services/driveInventory'));
const { parseSheetRows, planAdd, applyAdd } = require(path.join(__dirname, '../services/inventoryReplace'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const file = args.find(a => !a.startsWith('--'));

function list(title, items, fmt, max = 60) {
  console.log(`\n${title}: ${items.length}`);
  items.slice(0, max).forEach(i => console.log('  ' + fmt(i)));
  if (items.length > max) console.log(`  … and ${items.length - max} more`);
}

async function main() {
  if (!file) { console.log('Usage: node scripts/add-inventory.js <file.xlsx> [--apply]'); process.exit(1); }

  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const items = parseSheetRows(rows);
  const plan = planAdd(db, items);
  const before = db.prepare('SELECT COUNT(*) c FROM inventory').get().c;

  console.log(`File: ${path.basename(file)} (tab "${wb.SheetNames[0]}") — ${items.length} rows. Inventory now: ${before} units.`);
  list('TO ADD', plan.add,
    i => `row ${i.rowNumber}  ${i.serial || '(no serial)'}  ${i.make} ${i.model} ${i.year}  [${i.availability}] @ ${i.location || '—'}${i.sku ? '  SKU ' + i.sku : ''}`, 200);
  list('SKIPPED — serial already in the inventory', plan.skipExisting,
    i => `row ${i.rowNumber}  ${i.serial}  ${i.make} ${i.model}`);
  list('SKIPPED — serial is on a contract', plan.skipSold,
    s => `row ${s.item.rowNumber}  ${s.item.serial}  ${s.item.make} ${s.item.model}  → ${s.contract.contract_number} (${s.contract.status})`);
  if (plan.warnings.length) list('Warnings', plan.warnings, w => w);

  if (plan.blocking.length) {
    list('BLOCKING — fix the sheet and re-run', plan.blocking, b => b);
    console.log('\nNothing was changed.');
    process.exit(2);
  }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to add these units.'); return; }

  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { stdio: 'inherit' });
  const result = applyAdd(db, plan);
  console.log(`Added ${result.added} units. Inventory now: ${db.prepare('SELECT COUNT(*) c FROM inventory').get().c} units.`);

  const all = db.prepare("SELECT * FROM inventory ORDER BY (availability='Sold'), make, model, serial_number").all();
  try { await rewriteInventoryItemsTab(all); console.log(`Google Sheet "Inventory Items" rewritten: ${all.length} units.`); }
  catch (e) { console.log(`Google Sheet NOT updated (${e.message}). The app's inventory is correct; run: node scripts/replace-inventory.js --sheet-only`); }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
