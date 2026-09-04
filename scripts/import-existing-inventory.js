/**
 * One-time import of the existing "Inventory" Google Sheet tab (physical
 * stock the business already has on hand) into the new DB-backed inventory
 * table added in Stage 3 — this is the same spreadsheet/tab already read by
 * services/driveInventory.js's getInventory()/searchInventory() for the
 * read-only in-stock lookup during contract creation; that tab keeps working
 * exactly as it does today, this just copies its data once into the new
 * system.
 *
 * Column mapping (see the Stage 3 addendum in the phase plan for why):
 *   Make, Series, Model, Shell, Cabinet, Serial Number, Cover, Steps -> same-named columns
 *   Availability -> location (this column is actually a location signal in
 *                   the source sheet, not a Sold/Hold/In-stock status —
 *                   confirmed against searchInventory()'s STORE_MAP)
 *   (new) availability -> defaulted to 'In-stock' for every imported row
 *   (new) sku_number, finance -> left blank, not present in the source data
 *
 * Rows with no Serial Number are skipped (nothing to key off of). Rows whose
 * Serial Number already exists in the inventory table are skipped too, so
 * this script is safe to re-run (e.g. after adding more rows to the source
 * sheet) without creating duplicates.
 *
 * Usage: node scripts/import-existing-inventory.js [--dry-run]
 * Run on the server, where real Google Sheets credentials exist — this will
 * fail on GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY locally, same as every
 * other Sheets call in this app.
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const { getInventory, appendInventoryItem } = require(path.join(__dirname, '../services/driveInventory'));

const DRY_RUN = process.argv.includes('--dry-run');

// Best-effort mapping of the source sheet's free-text "Availability" (really
// location) values onto the new table's fixed location dropdown options.
// Falls back to the raw trimmed value if nothing matches, so no data is lost
// — it just may not exactly match a dropdown option until someone fixes it
// up in View Inventory (this script reports how many rows that affects).
const LOCATION_MAP = [
  { match: 'emp',      value: 'EMP Room' },
  { match: 'phoenix',  value: 'Phoenix Floor' },
  { match: 'tolleson', value: 'Tolleson Floor' },
  { match: 'chandler', value: 'Chandler Floor' },
  { match: 'surprise', value: 'Surprise Floor' },
  { match: 'goodyear', value: 'Goodyear Floor' },
];
function mapLocation(raw) {
  const norm = (raw || '').trim().toLowerCase();
  if (!norm) return { value: '', matched: true }; // empty is fine, nothing to map
  const hit = LOCATION_MAP.find(m => norm.includes(m.match));
  return hit ? { value: hit.value, matched: true } : { value: (raw || '').trim(), matched: false };
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no rows will be written.\n' : 'Importing...\n');

  const rows = await getInventory(true); // force-refresh, don't trust a stale cache for this
  console.log(`Read ${rows.length} rows from the existing "Inventory" sheet tab.\n`);

  let imported = 0, skippedNoSerial = 0, skippedDuplicate = 0, unmappedLocation = 0;
  const unmappedSamples = [];

  for (const row of rows) {
    const serialNumber = (row['Serial Number'] || '').trim();
    if (!serialNumber) { skippedNoSerial++; continue; }

    const existing = db.prepare('SELECT id FROM inventory WHERE serial_number = ?').get(serialNumber);
    if (existing) { skippedDuplicate++; continue; }

    const loc = mapLocation(row['Availability']);
    if (!loc.matched) {
      unmappedLocation++;
      if (unmappedSamples.length < 10) unmappedSamples.push(`"${row['Availability']}" (serial ${serialNumber})`);
    }

    const data = {
      make:         (row['Make']   || '').trim(),
      series:       (row['Series'] || '').trim(),
      model:        (row['Model']  || '').trim(),
      shellColor:   (row['Shell']   || '').trim(),
      cabinetColor: (row['Cabinet'] || '').trim(),
      serialNumber,
      skuNumber:    '',
      location:     loc.value,
      steps:        (row['Steps'] || '').trim(),
      cover:        (row['Cover'] || '').trim(),
      finance:      '',
      availability: 'In-stock',
    };

    if (DRY_RUN) {
      imported++;
      continue;
    }

    db.prepare(`
      INSERT INTO inventory
        (make, series, model, shell_color, cabinet_color, serial_number, sku_number,
         availability, location, steps, cover, finance, added_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      data.make, data.series, data.model, data.shellColor, data.cabinetColor,
      data.serialNumber, data.skuNumber, data.availability, data.location,
      data.steps, data.cover, data.finance, 'import-script'
    );

    try {
      await appendInventoryItem(data);
    } catch (e) {
      console.error(`[Sheets write failed — non-fatal, DB row was still saved] ${serialNumber}:`, e.message);
    }

    imported++;
  }

  console.log('--- Summary ---');
  console.log(`Imported:            ${imported}`);
  console.log(`Skipped (no serial): ${skippedNoSerial}`);
  console.log(`Skipped (duplicate): ${skippedDuplicate}`);
  console.log(`Unmapped location:   ${unmappedLocation}${unmappedSamples.length ? ' — e.g. ' + unmappedSamples.join(', ') : ''}`);
  if (DRY_RUN) console.log('\nThis was a dry run — nothing was written. Re-run without --dry-run to actually import.');
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
