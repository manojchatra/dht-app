/**
 * Bring the app's inventory up to date from the stock Google Sheet's
 * "Inventory" tab (see services/inventorySync.js for exactly what changes).
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/sync-inventory-from-sheet.js           # report only — changes nothing
 *   node scripts/sync-inventory-from-sheet.js --apply   # add new units, update moved locations
 *
 * Take a backup first: bash scripts/nightly-backup.sh
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const { getInventory, appendInventoryItem, updateInventoryItemField } = require(path.join(__dirname, '../services/driveInventory'));
const { planInventorySync, applyInventorySync } = require(path.join(__dirname, '../services/inventorySync'));

const APPLY = process.argv.includes('--apply');

function list(title, items, fmt, max = 50) {
  console.log(`\n${title}: ${items.length}`);
  items.slice(0, max).forEach(i => console.log('  ' + fmt(i)));
  if (items.length > max) console.log(`  … and ${items.length - max} more`);
}

async function main() {
  const sheetRows = await getInventory(true); // force a fresh read, not the 5-minute cache
  const dbRows = db.prepare('SELECT * FROM inventory').all();
  const plan = planInventorySync(sheetRows, dbRows);

  console.log(`Sheet rows read: ${sheetRows.length}  |  Units in the app: ${dbRows.length}`);
  list('New units to add (In-stock)', plan.add, u => `${u.serialNumber}  ${u.make} ${u.model}  @ ${u.location || '(no location)'}`);
  list('Location changes', plan.move, m => `${m.serialNumber}  ${m.from || '(none)'} → ${m.to}`);
  list('In-stock in the app but NOT in the sheet (not changed — review on the Inventory page)', plan.notInSheet,
    u => `${u.serialNumber}  ${u.make || ''} ${u.model || ''}  @ ${u.location || '(no location)'}`);
  list('Locations not recognised (kept as typed)', plan.unmappedLocations, u => `${u.serial}: "${u.raw}"`, 20);
  if (plan.duplicateInSheet.length) list('Serials listed twice in the sheet (first one used)', plan.duplicateInSheet, s => s, 20);
  console.log(`\nAlready up to date / sold / linked to a contract (untouched): ${plan.untouched}`);
  console.log(`Sheet rows without a serial number (skipped): ${plan.noSerial}`);

  if (!APPLY) {
    console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to make these changes.');
    return;
  }
  console.log('\nApplying…');
  const result = await applyInventorySync(db, plan, { appendInventoryItem, updateInventoryItemField });
  console.log(`Added ${result.added}, moved ${result.moved}.`);
  if (result.sheetErrors.length) {
    console.log(`Sheet mirror errors (the app's inventory IS updated): ${result.sheetErrors.length}`);
    result.sheetErrors.slice(0, 20).forEach(e => console.log('  ' + e));
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
