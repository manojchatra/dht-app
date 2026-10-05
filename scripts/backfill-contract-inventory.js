/**
 * Create the missing inventory unit for delivered contracts whose serial
 * number isn't in inventory (e.g. back-entered contracts saved before the app
 * started creating the unit itself). Units are added as Sold and linked to
 * their contract, so DHT Owned / Bank Owned can then be set on the Inventory page.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/backfill-contract-inventory.js           # report only
 *   node scripts/backfill-contract-inventory.js --apply   # create the units
 *
 * Take a backup first: bash scripts/nightly-backup.sh
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const { appendInventoryItem } = require(path.join(__dirname, '../services/driveInventory'));
const { planContractBackfill, applyContractBackfill } = require(path.join(__dirname, '../services/inventorySync'));

const APPLY = process.argv.includes('--apply');

async function main() {
  const items = planContractBackfill(db);
  console.log(`Delivered contracts with a serial number that has no inventory unit: ${items.length}`);
  items.forEach(u => console.log(`  ${u.contractNumber}  ${u.serialNumber}  ${u.make} ${u.model}`));
  if (!APPLY) {
    console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to create these units (as Sold).');
    return;
  }
  const result = await applyContractBackfill(db, items, { appendInventoryItem });
  console.log(`\nCreated ${result.created} inventory unit(s).`);
  if (result.sheetErrors.length) {
    console.log(`Sheet mirror errors (the units ARE in the app): ${result.sheetErrors.length}`);
    result.sheetErrors.slice(0, 20).forEach(e => console.log('  ' + e));
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
