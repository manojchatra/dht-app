/**
 * One-off repair: the physical-stock import (scripts/import-existing-
 * inventory.js) ran before the "Warehouse" location option existed, so any
 * row whose source "Availability" value was "Stock" (unmapped at the time)
 * got the raw literal string "Stock" stored in inventory.location — not a
 * real dropdown value, so it renders blank in View Inventory's Location
 * select today. This corrects those rows to the new "Warehouse" option,
 * both in the DB and in the "Inventory Items" Sheets mirror.
 *
 * Safe to re-run — only touches rows where location is exactly 'Stock'
 * (case-sensitive), so running it twice is a no-op the second time.
 *
 * Usage: node scripts/fix-stock-location.js [--dry-run]
 * Run on the server, where real Google Sheets credentials exist.
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const { updateInventoryItemField } = require(path.join(__dirname, '../services/driveInventory'));

const DRY_RUN = process.argv.includes('--dry-run');
const SHEETS_WRITE_DELAY_MS = 1100;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function updateWithRetry(serialNumber, field, value, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const ok = await updateInventoryItemField(serialNumber, field, value);
      return ok;
    } catch (e) {
      const isQuota = /quota exceeded/i.test(e.message || '');
      if (!isQuota || i === attempts - 1) {
        console.error(`[Sheets update failed — non-fatal, DB row was still fixed] ${serialNumber}:`, e.message);
        return false;
      }
      console.warn(`[Sheets quota hit, waiting 65s before retry ${i + 1}/${attempts - 1}] ${serialNumber}`);
      await sleep(65000);
    }
  }
  return false;
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no rows will be changed.\n' : 'Fixing...\n');

  const rows = db.prepare(`SELECT id, serial_number FROM inventory WHERE location = 'Stock'`).all();
  console.log(`Found ${rows.length} rows with location='Stock'.\n`);

  let fixed = 0, sheetsSynced = 0;

  for (const row of rows) {
    if (DRY_RUN) { fixed++; continue; }

    db.prepare(`UPDATE inventory SET location='Warehouse', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
    fixed++;

    const ok = await updateWithRetry(row.serial_number, 'location', 'Warehouse');
    if (ok) sheetsSynced++;
    await sleep(SHEETS_WRITE_DELAY_MS);
  }

  console.log('--- Summary ---');
  console.log(`Fixed in DB:      ${fixed}`);
  console.log(`Synced to Sheets: ${sheetsSynced}`);
  if (DRY_RUN) console.log('\nThis was a dry run — nothing was changed. Re-run without --dry-run to actually fix.');
}

main().catch(err => {
  console.error('Fix failed:', err);
  process.exit(1);
});
