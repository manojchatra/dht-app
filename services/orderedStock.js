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
const { markInventoryItemReceivedInSheet, updateInventoryItemField } = require('./driveInventory');

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

// Unreserved Ordered units of the same make and model — offered to admin when
// moving a To Be Ordered contract to Order Placed.
function findOrderedMatches(db, make, model) {
  return db.prepare("SELECT * FROM inventory WHERE availability='Ordered' AND contract_id IS NULL ORDER BY created_at")
    .all().filter(u => norm(u.make) === norm(make) && norm(u.model) === norm(model));
}

// Error message if receiving the contract's reserved unit under this serial
// would clash with a different unit, else null.
function receiveSerialConflict(db, contractId, serial) {
  const unit = reservedUnitFor(db, contractId);
  if (!unit) return null;
  const other = db.prepare('SELECT id FROM inventory WHERE serial_number=? AND id<>?').get(serial, unit.id);
  return other ? `Serial ${serial} is already on another inventory unit.` : null;
}

// Fills in the contract's reserved unit on receipt (serial, photos, Sold).
// Returns false when the contract has no reserved unit (normal flow applies).
async function receiveReservedUnit(db, contractId, { serial, sku = '', skuPhotoPath = null, serialPhotoPath = null }) {
  const unit = reservedUnitFor(db, contractId);
  if (!unit) return false;
  db.prepare(`UPDATE inventory SET serial_number=?, availability='Sold',
      sku_number=COALESCE(NULLIF(?,''), sku_number),
      sku_photo_path=COALESCE(?, sku_photo_path), serial_photo_path=COALESCE(?, serial_photo_path),
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(serial, sku, skuPhotoPath, serialPhotoPath, unit.id);
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

module.exports = { convertToOnOrder, relinkOrdered, getUnreservedOrdered, reserveOrdered, reservedUnitFor, findOrderedMatches, receiveSerialConflict, receiveReservedUnit };
