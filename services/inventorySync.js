/**
 * inventorySync.js — bring the app's inventory up to date from the stock
 * Google Sheet ("Inventory" tab: Make, Series, Model, Shell, Cabinet,
 * Serial Number, Cover, Steps, Availability = location).
 *
 * The app's database stays the source of truth. A sync only:
 *   - adds units whose serial isn't in the app (In-stock, location from the sheet)
 *   - updates the location of unsold, unlinked units that have moved
 *   - REPORTS units the app shows In-stock that the sheet no longer lists
 *     (sold elsewhere? damaged?) — someone decides Sold/Hold on the Inventory page
 * Units that are Sold or linked to a contract are never touched.
 *
 * Used by scripts/sync-inventory-from-sheet.js (report by default, --apply to write).
 */

// The sheet's free-text "Availability" column is really the location.
const LOCATION_MAP = [
  { match: 'emp',      value: 'EMP Room' },
  { match: 'phoenix',  value: 'Phoenix Floor' },
  { match: 'tolleson', value: 'Tolleson Floor' },
  { match: 'chandler', value: 'Chandler Floor' },
  { match: 'surprise', value: 'Surprise Floor' },
  { match: 'goodyear', value: 'Goodyear Floor' },
  { match: 'stock',    value: 'Warehouse' },
  { match: 'warehouse', value: 'Warehouse' },
];
function mapLocation(raw) {
  const norm = (raw || '').trim().toLowerCase();
  if (!norm) return { value: '', matched: true };
  const hit = LOCATION_MAP.find(m => norm.includes(m.match));
  return hit ? { value: hit.value, matched: true } : { value: (raw || '').trim(), matched: false };
}

const cell = (row, key) => String(row[key] ?? '').trim();

// Pure comparison — no writes. sheetRows: objects keyed by sheet header;
// dbRows: rows of the inventory table.
function planInventorySync(sheetRows, dbRows) {
  const plan = { add: [], move: [], notInSheet: [], untouched: 0, noSerial: 0, duplicateInSheet: [], unmappedLocations: [] };
  const bySerial = new Map(dbRows.filter(r => r.serial_number).map(r => [r.serial_number.trim().toLowerCase(), r]));
  const seen = new Set();

  for (const row of sheetRows) {
    const serial = cell(row, 'Serial Number');
    if (!serial) { plan.noSerial++; continue; }
    const key = serial.toLowerCase();
    if (seen.has(key)) { plan.duplicateInSheet.push(serial); continue; }
    seen.add(key);

    const loc = mapLocation(row['Availability']);
    if (!loc.matched) plan.unmappedLocations.push({ serial, raw: cell(row, 'Availability') });

    const unit = bySerial.get(key);
    if (!unit) {
      plan.add.push({
        serialNumber: serial,
        make: cell(row, 'Make'), series: cell(row, 'Series'), model: cell(row, 'Model'),
        shellColor: cell(row, 'Shell'), cabinetColor: cell(row, 'Cabinet'),
        steps: cell(row, 'Steps'), cover: cell(row, 'Cover'),
        location: loc.value, availability: 'In-stock',
      });
      continue;
    }
    const free = !unit.contract_id && (unit.availability === 'In-stock' || unit.availability === 'Hold');
    if (free && loc.value && loc.value !== (unit.location || '')) {
      plan.move.push({ id: unit.id, serialNumber: unit.serial_number, from: unit.location || '', to: loc.value });
    } else {
      plan.untouched++;
    }
  }

  for (const unit of dbRows) {
    if (!unit.serial_number || unit.contract_id || unit.availability !== 'In-stock') continue;
    if (!seen.has(unit.serial_number.trim().toLowerCase())) {
      plan.notInSheet.push({ id: unit.id, serialNumber: unit.serial_number, make: unit.make, model: unit.model, location: unit.location || '' });
    }
  }
  return plan;
}

// Writes the plan: DB first (always), then the "Inventory Items" mirror tab
// (best effort, paced to stay under the Sheets API quota).
async function applyInventorySync(db, plan, { appendInventoryItem, updateInventoryItemField, delayMs = 1100, actor = 'inventory-sync' } = {}) {
  const sleep = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
  const result = { added: 0, moved: 0, sheetErrors: [] };

  for (const u of plan.add) {
    db.prepare(`INSERT INTO inventory
      (make, series, model, shell_color, cabinet_color, serial_number, availability, location, steps, cover, added_by)
      VALUES (?,?,?,?,?,?,'In-stock',?,?,?,?)`
    ).run(u.make, u.series, u.model, u.shellColor, u.cabinetColor, u.serialNumber, u.location, u.steps, u.cover, actor);
    result.added++;
    try { await appendInventoryItem(u); } catch (e) { result.sheetErrors.push(`${u.serialNumber}: ${e.message}`); }
    await sleep(delayMs);
  }
  for (const m of plan.move) {
    db.prepare('UPDATE inventory SET location=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(m.to, m.id);
    result.moved++;
    try { await updateInventoryItemField(m.serialNumber, 'location', m.to); } catch (e) { result.sheetErrors.push(`${m.serialNumber}: ${e.message}`); }
    await sleep(delayMs);
  }
  return result;
}

// ── Backfill: delivered contracts whose serial has no inventory unit ─────────
// (contracts entered before new contracts started creating their unit), so
// DHT/Bank Owned can be set on them. Created units are Sold, linked, and
// tagged with the contract like the ones contract-save creates.
function planContractBackfill(db) {
  const rows = db.prepare(`
    SELECT c.id, c.contract_number, c.make, c.model, c.serial_number, c.data
    FROM contracts c
    WHERE c.status = 'delivered' AND TRIM(COALESCE(c.serial_number,'')) <> ''
      AND NOT EXISTS (SELECT 1 FROM inventory i WHERE LOWER(TRIM(i.serial_number)) = LOWER(TRIM(c.serial_number)))
    ORDER BY c.id`).all();
  const seen = new Set();
  return rows.filter(r => {               // one unit per serial, even if two contracts share it
    const k = r.serial_number.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).map(r => {
    let pr = {};
    try { pr = JSON.parse(r.data || '{}').product || {}; } catch (e) { /* summary columns are enough */ }
    return {
      contractId: r.id, contractNumber: r.contract_number,
      serialNumber: r.serial_number.trim(), make: r.make || pr.make || '', series: pr.series || '',
      model: r.model || pr.model || '', shellColor: pr.shellColor || '', cabinetColor: pr.cabinetColor || '',
      availability: 'Sold',
    };
  });
}

async function applyContractBackfill(db, items, { appendInventoryItem, delayMs = 1100 } = {}) {
  const sleep = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
  const result = { created: 0, sheetErrors: [] };
  for (const u of items) {
    db.prepare(`INSERT INTO inventory
      (make, series, model, shell_color, cabinet_color, serial_number, availability, contract_id, created_by_contract_id, added_by)
      VALUES (?,?,?,?,?,?,'Sold',?,?,'contract-backfill')`
    ).run(u.make, u.series, u.model, u.shellColor, u.cabinetColor, u.serialNumber, u.contractId, u.contractId);
    result.created++;
    try { await appendInventoryItem(u); } catch (e) { result.sheetErrors.push(`${u.serialNumber}: ${e.message}`); }
    await sleep(delayMs);
  }
  return result;
}

module.exports = { planInventorySync, applyInventorySync, mapLocation, planContractBackfill, applyContractBackfill };
