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
 * Serial Number already exists in the inventory table are skipped for the DB
 * insert (so this script is safe to re-run, e.g. after adding more rows to
 * the source sheet, without creating duplicates) — but each duplicate is
 * still checked against the "Inventory Items" Sheets tab and backfilled
 * there if missing, so re-running this script after a partial failure (e.g.
 * hitting the Sheets API's write-rate quota partway through a large import)
 * repairs the Sheets mirror for whatever didn't make it the first time,
 * without touching the DB (which is always correct — it's the source of
 * truth and the DB insert never depends on the Sheets write succeeding).
 *
 * Sheets writes are paced (~1.1s apart) to stay under the API's per-minute
 * write-request quota, and retry once with a 65s wait if that quota is hit
 * anyway, rather than just giving up on the first rate-limit error.
 *
 * Usage: node scripts/import-existing-inventory.js [--dry-run]
 * Run on the server, where real Google Sheets credentials exist — this will
 * fail on GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY locally, same as every
 * other Sheets call in this app.
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const { getInventory, appendInventoryItem, inventoryItemExistsInSheet } = require(path.join(__dirname, '../services/driveInventory'));

const DRY_RUN = process.argv.includes('--dry-run');

// Paced well under the Google Sheets API's per-minute quotas — a tight loop
// with no delay will hit them partway through any nontrivial import
// (observed in practice for both writes AND reads: "Quota exceeded for
// quota metric 'Write requests'..." / "'Read requests'..."). The DB always
// succeeds regardless (that's the source of truth); this only affects how
// reliably the Sheets mirror keeps up. Applied after EVERY Sheets API call
// in the loop below, not just the ones that end up writing something.
const SHEETS_API_DELAY_MS = 1100;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retries specifically on a quota error (waits out a full quota window),
// rather than giving up on the first transient rate-limit hit.
async function appendWithRetry(data, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await appendInventoryItem(data);
      return true;
    } catch (e) {
      const isQuota = /quota exceeded/i.test(e.message || '');
      if (!isQuota || i === attempts - 1) {
        console.error(`[Sheets write failed — non-fatal, DB row was still saved] ${data.serialNumber}:`, e.message);
        return false;
      }
      console.warn(`[Sheets quota hit, waiting 65s before retry ${i + 1}/${attempts - 1}] ${data.serialNumber}`);
      await sleep(65000); // Sheets API quota resets on a per-minute window
    }
  }
  return false;
}

// Same quota-retry treatment for the read-side existence check used by the
// backfill path below — returns true/false when known, or null if the check
// itself couldn't be confirmed even after retries (in which case the caller
// must NOT attempt a backfill, to avoid risking a duplicate append for a row
// that might actually already be in the Sheet).
async function existsWithRetry(serialNumber, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await inventoryItemExistsInSheet(serialNumber);
    } catch (e) {
      const isQuota = /quota exceeded/i.test(e.message || '');
      if (!isQuota || i === attempts - 1) {
        console.error(`[Backfill check failed — non-fatal, skipping backfill for this row] ${serialNumber}:`, e.message);
        return null;
      }
      console.warn(`[Sheets quota hit, waiting 65s before retry ${i + 1}/${attempts - 1}] ${serialNumber}`);
      await sleep(65000);
    }
  }
  return null;
}

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
  { match: 'stock',    value: 'Warehouse' },
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

  let imported = 0, skippedNoSerial = 0, skippedDuplicate = 0, unmappedLocation = 0, backfilled = 0;
  const unmappedSamples = [];

  for (const row of rows) {
    const serialNumber = (row['Serial Number'] || '').trim();
    if (!serialNumber) { skippedNoSerial++; continue; }

    const existing = db.prepare('SELECT id FROM inventory WHERE serial_number = ?').get(serialNumber);
    if (existing) {
      skippedDuplicate++;
      // Already in the DB (from this run or an earlier one) — but if an
      // earlier run hit the Sheets write quota partway through, this row
      // may never have made it into the Sheet. Check and backfill it.
      // Paced the same as a write, since this read-side check hits its own
      // separate Sheets API quota just as easily across hundreds of rows.
      if (!DRY_RUN) {
        const inSheet = await existsWithRetry(serialNumber);
        if (inSheet === false) {
          const full = db.prepare('SELECT * FROM inventory WHERE serial_number = ?').get(serialNumber);
          const ok = await appendWithRetry({
            make: full.make, series: full.series, model: full.model,
            shellColor: full.shell_color, cabinetColor: full.cabinet_color,
            serialNumber: full.serial_number, skuNumber: full.sku_number || '',
            location: full.location || '', steps: full.steps || '', cover: full.cover || '',
            finance: full.finance || '', availability: full.availability,
          });
          if (ok) backfilled++;
        }
        await sleep(SHEETS_API_DELAY_MS);
      }
      continue;
    }

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

    await appendWithRetry(data);
    await sleep(SHEETS_API_DELAY_MS);

    imported++;
  }

  console.log('--- Summary ---');
  console.log(`Imported:                ${imported}`);
  console.log(`Skipped (no serial):     ${skippedNoSerial}`);
  console.log(`Skipped (duplicate):     ${skippedDuplicate}`);
  console.log(`Backfilled into Sheets:  ${backfilled} (duplicate rows that were missing from the Sheets mirror, now added)`);
  console.log(`Unmapped location:       ${unmappedLocation}${unmappedSamples.length ? ' — e.g. ' + unmappedSamples.join(', ') : ''}`);
  if (DRY_RUN) console.log('\nThis was a dry run — nothing was written. Re-run without --dry-run to actually import.');
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
