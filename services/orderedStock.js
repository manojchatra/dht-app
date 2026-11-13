/**
 * orderedStock.js — "Ordered" general stock (on a truck, no serial yet) that a
 * contract reserves instead of placing a second factory order.
 *
 * Reserved = availability 'Ordered' + contract_id set. The contract runs as
 * Order Placed with the unit's Web Order # / Truck #. Receiving the contract
 * fills in that unit's serial (no second unit is created); cancelling or
 * deleting the contract hands it back as unreserved Ordered stock (see
 * releaseInventoryForContract in routes/contracts.js).
 */
const { markInventoryItemReceivedInSheet, updateInventoryItemField, inventoryItemExistsInSheet, appendInventoryItem } = require('./driveInventory');
const { normalizeMake } = require('../utils/makes');
const { phoenixToday } = require('../utils/arizona');

const norm = s => String(s ?? '').trim().toLowerCase();

// An Ordered unit nobody has reserved yet, or null.
function getUnreservedOrdered(db, unitId) {
  const id = parseInt(unitId, 10);
  if (!id) return null;
  return db.prepare("SELECT * FROM inventory WHERE id=? AND availability='Ordered' AND contract_id IS NULL").get(id) || null;
}

// Reserves the unit for the contract. False if it was taken (or received) meanwhile.
function reserveOrdered(db, unitId, contractId) {
  return db.prepare(`UPDATE inventory SET contract_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND availability='Ordered' AND contract_id IS NULL`).run(contractId, unitId).changes === 1;
}

function reservedUnitFor(db, contractId) {
  return db.prepare("SELECT * FROM inventory WHERE contract_id=? AND availability='Ordered'").get(contractId) || null;
}

// Order Placed contracts still waiting for their spa to be added to Inventory:
// same Web Order #, make and model, and no on-order spa reserved for them yet.
// Add Inventory → On Order offers to reserve the new spa for one of them, so
// the spa isn't listed twice (the contract, plus "free" on-order stock).
function contractsAwaitingSpa(db, webOrderNumber, make, model) {
  if (!norm(webOrderNumber)) return [];
  return db.prepare(`SELECT c.id, c.contract_number, c.make, c.model, c.web_order_number, c.truck_number,
      COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name
    FROM contracts c LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.status = 'order_placed' AND lower(trim(c.web_order_number)) = ?
      AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.contract_id = c.id)
    ORDER BY c.created_at`).all(norm(webOrderNumber))
    .filter(c => norm(normalizeMake(c.make)) === norm(normalizeMake(make)) && norm(c.model) === norm(model));
}

// Unreserved Ordered units of the same make and model — offered to admin when
// moving a To Be Ordered contract to Order Placed.
function findOrderedMatches(db, make, model) {
  return db.prepare("SELECT * FROM inventory WHERE availability='Ordered' AND contract_id IS NULL ORDER BY created_at")
    .all().filter(u => norm(u.make) === norm(make) && norm(u.model) === norm(model));
}

// Error message if this serial can't be received for the contract, else null.
//  - Contract with reserved on-order stock: the serial goes on that unit, so it
//    mustn't already be on a different unit.
//  - Otherwise a spa already in inventory under this serial is linked to the
//    contract — only if it isn't sold to another contract and is free stock
//    (In-stock or Ordered). Receiving used to take it from its other contract.
function receiveSerialConflict(db, contractId, serial) {
  const unit = reservedUnitFor(db, contractId);
  if (unit) {
    const other = db.prepare('SELECT id FROM inventory WHERE upper(trim(serial_number))=upper(trim(?)) AND id<>?').get(serial, unit.id);
    return other ? `Serial ${serial} is already on another inventory unit.` : null;
  }
  const found = db.prepare(`SELECT i.*, c.contract_number AS linked_contract FROM inventory i
    LEFT JOIN contracts c ON c.id = i.contract_id WHERE upper(trim(i.serial_number))=upper(trim(?))`).get(serial);
  if (!found || found.contract_id === Number(contractId)) return null;
  if (found.contract_id) return `Serial ${found.serial_number} is already sold to ${found.linked_contract || 'another contract'}.`;
  if (!['In-stock', 'Ordered'].includes(found.availability)) {
    return `Spa ${found.serial_number} is "${found.availability}" in inventory — it can't be received for this contract.`;
  }
  return null;
}

// For the Mark Received log: what the contract's serial box held before (a
// salesperson's remark on a To Be Ordered sale, or an old serial) — kept here
// because receiving replaces it. '' when it was empty or the same.
function serialWas(contract, serial) {
  const was = String(contract.serial_number || '').trim();
  return was && was.toUpperCase() !== String(serial).trim().toUpperCase() ? ` | Serial was: ${was}` : '';
}

// Links the received spa to the contract in inventory (Sold), after
// receiveSerialConflict has passed: the contract's reserved on-order unit gets
// the serial; else an inventory spa with this serial is linked; else a new
// unit is added. Sheet updates are non-fatal. Used by both Mark Received
// routes (admin: routes/contracts.js, warehouse: routes/warehouse.js).
async function linkReceivedUnit(db, contract, { serial, sku = '', skuPhotoPath = null, serialPhotoPath = null, addedBy = 'system', addedDate = '' }) {
  const receivedAt = addedDate || phoenixToday(); // the Warehouse page's Received tab
  if (await receiveReservedUnit(db, contract.id, { serial, sku, skuPhotoPath, serialPhotoPath, receivedAt })) return 'reserved';
  const product = (() => { try { return JSON.parse(contract.data || '{}').product || {}; } catch (e) { return {}; } })();
  const existing = db.prepare('SELECT id FROM inventory WHERE upper(trim(serial_number))=upper(trim(?))').get(serial);
  if (existing) {
    db.prepare(`UPDATE inventory SET contract_id=?, availability='Sold', sku_number=COALESCE(NULLIF(?,''), sku_number),
        sku_photo_path=COALESCE(?, sku_photo_path), serial_photo_path=COALESCE(?, serial_photo_path),
        web_order_number=?, truck_number=?, received_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(contract.id, sku, skuPhotoPath, serialPhotoPath, contract.web_order_number || '', contract.truck_number || '', receivedAt, existing.id);
  } else {
    db.prepare(`INSERT INTO inventory (make, model, shell_color, cabinet_color, serial_number, sku_number,
        availability, sku_photo_path, serial_photo_path, contract_id, added_by, web_order_number, truck_number, received_at)
      VALUES (?,?,?,?,?,?,'Sold',?,?,?,?,?,?,?)`).run(
      contract.make || product.make || '', contract.model || product.model || '', product.shellColor || '', product.cabinetColor || '',
      serial, sku, skuPhotoPath, serialPhotoPath, contract.id, addedBy, contract.web_order_number || '', contract.truck_number || '', receivedAt);
  }
  try {
    if (await inventoryItemExistsInSheet(serial)) await updateInventoryItemField(serial, 'availability', 'Sold');
    else await appendInventoryItem({
      serialNumber: serial, skuNumber: sku, make: contract.make || product.make || '', model: contract.model || product.model || '',
      shellColor: product.shellColor || '', cabinetColor: product.cabinetColor || '', availability: 'Sold', addedDate,
      webOrderNumber: contract.web_order_number || '', truckNumber: contract.truck_number || '',
    });
  } catch (e) { console.error('[Drive received unit failed — non-fatal]', e.message); }
  return existing ? 'linked' : 'created';
}

// Fills in the contract's reserved unit on receipt (serial, photos, Sold).
// Returns false when the contract has no reserved unit (normal flow applies).
async function receiveReservedUnit(db, contractId, { serial, sku = '', skuPhotoPath = null, serialPhotoPath = null, receivedAt = phoenixToday() }) {
  const unit = reservedUnitFor(db, contractId);
  if (!unit) return false;
  db.prepare(`UPDATE inventory SET serial_number=?, availability='Sold',
      sku_number=COALESCE(NULLIF(?,''), sku_number),
      sku_photo_path=COALESCE(?, sku_photo_path), serial_photo_path=COALESCE(?, serial_photo_path),
      received_at=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(serial, sku, skuPhotoPath, serialPhotoPath, receivedAt, unit.id);
  try {
    if (await markInventoryItemReceivedInSheet(unit, serial)) {
      await updateInventoryItemField(serial, 'availability', 'Sold');
    }
  } catch (e) { console.error('[Drive receive reserved unit failed — non-fatal]', e.message); }
  return true;
}

// Moves an Order Placed contract from the on-order unit it reserved to another
// unreserved on-order unit (e.g. linked to the wrong truck). The old unit goes
// back to unreserved Ordered stock; the contract takes the new unit's Web Order #
// / Truck #. One transaction. Returns { from, to } (from may be null).
function relinkOrdered(db, contractId, newUnitId) {
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
  if (!c) throw new Error('Contract not found');
  if (c.status !== 'order_placed') throw new Error(`Contract is "${c.status}" — only an Order Placed contract (not yet received) can be re-linked`);
  const to = getUnreservedOrdered(db, newUnitId);
  if (!to) throw new Error(`Unit ${newUnitId} is not unreserved on-order stock`);
  const from = reservedUnitFor(db, contractId);
  db.transaction(() => {
    if (from) db.prepare('UPDATE inventory SET contract_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(from.id);
    if (!reserveOrdered(db, to.id, contractId)) throw new Error(`Unit ${to.id} was just taken`);
    const data = JSON.parse(c.data || '{}');
    if (data.product) data.product.orderedUnitId = to.id;
    db.prepare('UPDATE contracts SET web_order_number=?, truck_number=?, data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(to.web_order_number || '', to.truck_number || '', JSON.stringify(data), contractId);
  })();
  return { from, to };
}

// Turns a not-yet-ordered contract (Assigned or To Be Ordered — e.g. the
// salesperson typed "Truck 20" as the serial) into one sold from on-order
// stock: reserves the unit, contract → Order Placed (paperwork To Be Ordered)
// with the unit's Web Order # / Truck #, serial cleared. Units the contract had:
// a placeholder it created itself (hand-typed serial) is deleted; any other unit
// is released (In-stock, or Ordered if still on order). One transaction.
function convertToOnOrder(db, contractId, unitId) {
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
  if (!c) throw new Error('Contract not found');
  if (!['assigned', 'tbo'].includes(c.status)) throw new Error(`Contract is "${c.status}" — only Assigned or To Be Ordered can be converted`);
  const to = getUnreservedOrdered(db, unitId);
  if (!to) throw new Error(`Unit ${unitId} is not unreserved on-order stock`);
  const linked = db.prepare('SELECT * FROM inventory WHERE contract_id=?').all(contractId);
  const removed = linked.filter(u => u.created_by_contract_id === contractId);
  const released = linked.filter(u => u.created_by_contract_id !== contractId);
  db.transaction(() => {
    for (const u of removed) db.prepare('DELETE FROM inventory WHERE id=?').run(u.id);
    for (const u of released) db.prepare(`UPDATE inventory SET contract_id=NULL,
      availability=CASE WHEN availability='Ordered' THEN 'Ordered' ELSE 'In-stock' END, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(u.id);
    if (!reserveOrdered(db, to.id, contractId)) throw new Error(`Unit ${to.id} was just taken`);
    const data = JSON.parse(c.data || '{}');
    data.product = Object.assign(data.product || {}, { status: 'tbo', serialNumber: '', orderedUnitId: to.id });
    db.prepare(`UPDATE contracts SET status='order_placed', product_status='tbo', serial_number=NULL,
      web_order_number=?, truck_number=?, data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(to.web_order_number || '', to.truck_number || '', JSON.stringify(data), contractId);
  })();
  return { removed, released, to };
}

// An Order Placed contract that's cancelled or deleted: its spa is still on
// the truck. When the contract had no inventory unit (Web Order # and Truck #
// typed, no on-order stock picked), the spa is added as unreserved Ordered
// stock — the warehouse then receives it as general stock. A contract that
// reserved a unit gets it released by releaseInventoryForContract instead, so
// call this first. Returns the label for the log, or null when nothing was added.
async function keepOrderedSpa(db, contract, addedBy = 'system') {
  const webOrder = String(contract.web_order_number || '').trim();
  const truck    = String(contract.truck_number || '').trim();
  if (contract.status !== 'order_placed' || !webOrder || !truck) return null;
  if (db.prepare('SELECT 1 FROM inventory WHERE contract_id=?').get(contract.id)) return null;
  const product = (() => { try { return JSON.parse(contract.data || '{}').product || {}; } catch (e) { return {}; } })();
  const unit = {
    make: contract.make || product.make || '', series: product.series || '', model: contract.model || product.model || '',
    shellColor: product.shellColor || '', cabinetColor: product.cabinetColor || '',
    speaker: product.included?.speaker ? 'Yes' : '', year: String(product.year || ''),
  };
  db.prepare(`INSERT INTO inventory (make, series, model, shell_color, cabinet_color, availability,
      added_by, speaker, web_order_number, truck_number, year)
    VALUES (?,?,?,?,?,'Ordered',?,?,?,?,?)`).run(
    unit.make, unit.series, unit.model, unit.shellColor, unit.cabinetColor, addedBy, unit.speaker, webOrder, truck, unit.year);
  try {
    await appendInventoryItem({ ...unit, skuNumber: '', availability: 'Ordered', webOrderNumber: webOrder, truckNumber: truck });
  } catch (e) { console.error('[Drive keep on-order spa failed — non-fatal]', e.message); }
  return `on-order stock (Web Order # ${webOrder})`;
}

module.exports = { convertToOnOrder, relinkOrdered, getUnreservedOrdered, reserveOrdered, reservedUnitFor, findOrderedMatches, contractsAwaitingSpa, receiveSerialConflict, receiveReservedUnit, linkReceivedUnit, serialWas, keepOrderedSpa };
