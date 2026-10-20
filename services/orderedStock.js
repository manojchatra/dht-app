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
    if (await markInventoryItemReceivedInSheet(unit.web_order_number, serial)) {
      await updateInventoryItemField(serial, 'availability', 'Sold');
    }
  } catch (e) { console.error('[Drive receive reserved unit failed — non-fatal]', e.message); }
  return true;
}

module.exports = { getUnreservedOrdered, reserveOrdered, reservedUnitFor, findOrderedMatches, receiveSerialConflict, receiveReservedUnit };
