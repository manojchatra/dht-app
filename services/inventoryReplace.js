/**
 * inventoryReplace.js — replace the app's inventory with a new stock sheet,
 * keeping every unit that belongs to a contract.
 *
 * Kept (never deleted or changed):
 *   - units linked to a contract (inventory.contract_id), and
 *   - units whose serial is on any contract that isn't cancelled.
 * Removed: every other unit (the old In-stock / Hold / Ordered list).
 * Added:   the sheet's rows. A row whose serial is kept or on an active contract
 *          is skipped (it's sold). No serial + a Truck Number = Ordered (arrives
 *          via the Warehouse queue); no serial and no truck = In-stock, serial later.
 *
 * Linked:  a spa on a contract that has a serial but no inventory unit (assigned or
 *          later — not To Be Ordered / Order Placed) gets a Sold unit linked to that
 *          contract, from the sheet row if the sheet lists it, else from the contract.
 * Photos:  a removed unit's serial/SKU photos are carried to the new unit with the same serial.
 *
 * Blocking problems (nothing is applied): a serial listed twice, missing Make/Model.
 * Used by scripts/replace-inventory.js (report by default, --apply to write).
 */

const LOCATIONS = ['Warehouse', 'EMP Room', 'Phoenix Floor', 'Goodyear Floor', 'Chandler Floor', 'Surprise Floor', 'Tolleson Floor'];
const FINANCE = ['DHT Owned', 'Bank Owned'];

const text = v => String(v ?? '').trim();
const key = s => text(s).toLowerCase();

function mapLocation(raw) {
  const v = text(raw);
  if (!v) return { value: '', known: true };
  if (/^emp\b/i.test(v)) return { value: 'EMP Room', known: true };
  const hit = LOCATIONS.find(l => l.toLowerCase() === v.toLowerCase());
  return hit ? { value: hit, known: true } : { value: v, known: false };
}

// Sheet rows (objects keyed by the header row, as xlsx sheet_to_json gives them)
// -> normalised units. rowNumber is the spreadsheet row (header = row 1).
function parseSheetRows(rows) {
  return rows
    .map((r, i) => ({ r, rowNumber: i + 2 }))
    .filter(({ r }) => Object.values(r).some(v => text(v) !== ''))
    .map(({ r, rowNumber }) => {
      const serial = text(r['Serial Number']);
      const truck = text(r['Truck Number']);
      const loc = mapLocation(r['Location']);
      const finance = text(r['Finance']);
      return {
        rowNumber, serial,
        make: text(r['Make']), series: text(r['Series']), model: text(r['Model']), year: text(r['Year']),
        shellColor: text(r['Shell Color']), cabinetColor: text(r['Cabinet Color']),
        sku: text(r['SKU Number']), steps: text(r['Steps']), cover: text(r['Cover']), speaker: text(r['Speaker']),
        finance: FINANCE.includes(finance) ? finance : '', financeRaw: finance,
        location: loc.value, locationKnown: loc.known,
        truckNumber: truck, webOrderNumber: text(r['Weborder'] ?? r['Web Order Number']),
        line: text(r['Line']), bay: text(r['Bay']),
        availability: !serial && truck ? 'Ordered' : 'In-stock',
      };
    });
}

function planReplace(db, items) {
  const units = db.prepare('SELECT * FROM inventory').all();
  const activeContracts = db.prepare(`SELECT id, contract_number, status, serial_number, data FROM contracts
    WHERE status <> 'cancelled' AND TRIM(COALESCE(serial_number,'')) <> ''`).all();
  const contractBySerial = new Map(activeContracts.map(c => [key(c.serial_number), c]));
  const contractById = new Map(db.prepare('SELECT id, contract_number, status FROM contracts').all().map(c => [c.id, c]));

  const keep = [], remove = [];
  for (const u of units) {
    const linked = u.contract_id ? contractById.get(u.contract_id) : null;
    const bySerial = u.serial_number ? contractBySerial.get(key(u.serial_number)) : null;
    if (u.contract_id || bySerial) keep.push({ unit: u, contract: linked || bySerial });
    else remove.push(u);
  }
  const keptSerials = new Set(keep.map(k => key(k.unit.serial_number)).filter(Boolean));

  const plan = { keep, remove, add: [], skipSold: [], link: [], blocking: [], warnings: [] };
  const seen = new Map();
  for (const it of items) {
    if (!it.make || !it.model) plan.blocking.push(`Row ${it.rowNumber}: Make and Model are required`);
    if (it.serial) {
      const k = key(it.serial);
      if (seen.has(k)) plan.blocking.push(`Serial ${it.serial} is listed more than once (rows ${seen.get(k)} and ${it.rowNumber})`);
      else seen.set(k, it.rowNumber);
      const c = contractBySerial.get(k);
      if (keptSerials.has(k) || c) { plan.skipSold.push({ item: it, contract: c || keep.find(x => key(x.unit.serial_number) === k)?.contract }); continue; }
    }
    if (!it.locationKnown) plan.warnings.push(`Row ${it.rowNumber}: location "${it.location}" is not one of the app's locations (kept as typed)`);
    if (it.financeRaw && !it.finance) plan.warnings.push(`Row ${it.rowNumber}: finance "${it.financeRaw}" ignored (must be DHT Owned or Bank Owned)`);
    plan.add.push(it);
  }

  // Sold spas with no inventory unit at all -> a Sold unit linked to the contract.
  // Only once the spa physically exists (not To Be Ordered / Order Placed, whose
  // "serial" may be a placeholder such as "Special Order").
  const unitSerials = new Set(units.map(u => key(u.serial_number)).filter(Boolean));
  const skippedBySerial = new Map(plan.skipSold.map(x => [key(x.item.serial), x.item]));
  const linked = new Set();
  for (const c of activeContracts) {
    const k = key(c.serial_number);
    if (['tbo', 'order_placed'].includes(c.status) || unitSerials.has(k) || linked.has(k)) continue;
    linked.add(k);
    let pr = {};
    try { pr = JSON.parse(c.data || '{}').product || {}; } catch (e) { /* use the sheet row / blanks */ }
    const row = skippedBySerial.get(k);
    plan.link.push({
      contract: c, fromSheet: !!row,
      item: row ? { ...row, availability: 'Sold' } : {
        serial: text(c.serial_number), make: text(pr.make), series: text(pr.series), model: text(pr.model), year: text(pr.year),
        shellColor: text(pr.shellColor), cabinetColor: text(pr.cabinetColor), sku: '', steps: '', cover: '',
        speaker: pr.included?.speaker ? 'Yes' : '', finance: FINANCE.includes(pr.finance) ? pr.finance : '',
        location: '', webOrderNumber: '', truckNumber: '', line: '', bay: '', availability: 'Sold',
      },
    });
  }
  return plan;
}

// One transaction: if anything fails, nothing changes.
function applyReplace(db, plan, actor = 'inventory-import') {
  if (plan.blocking.length) throw new Error('Blocking problems — fix the sheet first');
  const del = db.prepare('DELETE FROM inventory WHERE id = ? AND contract_id IS NULL');
  const ins = db.prepare(`INSERT INTO inventory
    (make, series, model, year, shell_color, cabinet_color, serial_number, sku_number, availability,
     location, steps, cover, finance, speaker, web_order_number, truck_number, line, bay,
     sku_photo_path, serial_photo_path, contract_id, created_by_contract_id, added_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Photos of removed units, by serial — carried over to the new unit with that serial.
  const photos = new Map(plan.remove.filter(u => u.serial_number && (u.sku_photo_path || u.serial_photo_path))
    .map(u => [key(u.serial_number), u]));
  const insert = (it, contractId) => {
    const p = it.serial ? photos.get(key(it.serial)) : null;
    ins.run(it.make, it.series, it.model, it.year, it.shellColor, it.cabinetColor, it.serial || null, it.sku,
      it.availability, it.location, it.steps, it.cover, it.finance || null, it.speaker,
      it.webOrderNumber, it.truckNumber, it.line, it.bay,
      p ? p.sku_photo_path : null, p ? p.serial_photo_path : null, contractId || null, contractId || null, actor);
    return !!p;
  };
  const run = db.transaction(() => {
    let removed = 0, added = 0, linked = 0, photosKept = 0;
    for (const u of plan.remove) removed += del.run(u.id).changes;
    for (const it of plan.add) { if (insert(it)) photosKept++; added++; }
    for (const l of plan.link) { if (insert(l.item, l.contract.id)) photosKept++; linked++; }
    return { removed, added, linked, photosKept };
  });
  return run();
}

module.exports = { parseSheetRows, planReplace, applyReplace, mapLocation };
