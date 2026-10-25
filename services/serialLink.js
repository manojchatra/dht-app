/**
 * serialLink.js — contracts whose serial is a spa already in inventory but not
 * linked to them (e.g. saved as To Be Ordered with an in-stock serial typed in,
 * or a serial set later by Assign SI. No). That spa still shows In-stock and
 * could be sold twice.
 *
 * linkInStockSerial: marks the spa Sold and links it to the contract; a contract
 * still waiting on an order (To Be Ordered / Order Placed) moves to Received,
 * since its spa is in hand. The spa's serial / SKU photos are added to the
 * contract's gallery.
 */
'use strict';

const OPEN = ['assigned', 'tbo', 'order_placed', 'received', 'scheduled'];
const WAITING = ['tbo', 'order_placed'];

// Every open contract whose serial matches an inventory unit not linked to it.
function findUnlinkedSerials(db) {
  return db.prepare(`SELECT c.id AS contract_id, c.contract_number, c.status, c.serial_number,
      i.id AS unit_id, i.make, i.model, i.shell_color, i.cabinet_color, i.availability, i.contract_id AS unit_contract_id
    FROM contracts c JOIN inventory i ON lower(trim(i.serial_number)) = lower(trim(c.serial_number))
    WHERE c.status IN (${OPEN.map(() => '?').join(',')}) AND TRIM(COALESCE(c.serial_number,'')) <> ''
      AND COALESCE(i.contract_id, 0) <> c.id
    ORDER BY c.contract_number`).all(...OPEN);
}

function linkInStockSerial(db, contractId) {
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
  if (!c) throw new Error('Contract not found');
  if (!OPEN.includes(c.status)) throw new Error(`Contract is "${c.status}"`);
  const unit = db.prepare('SELECT * FROM inventory WHERE lower(trim(serial_number))=lower(trim(?))').get(c.serial_number || '');
  if (!unit) throw new Error(`No inventory unit with serial ${c.serial_number}`);
  if (unit.contract_id === c.id) throw new Error('Already linked');
  if (unit.contract_id) throw new Error(`Serial ${unit.serial_number} is linked to another contract`);
  if (unit.availability !== 'In-stock') throw new Error(`Spa ${unit.serial_number} is "${unit.availability}", not In-stock`);
  const toReceived = WAITING.includes(c.status);
  // The spa's serial / SKU barcode photos go into the contract's gallery too, as a
  // warehouse receive does (same files — the inventory unit keeps them as well).
  const images = c.extra_images ? JSON.parse(c.extra_images) : [];
  const has = p => images.some(i => (typeof i === 'string' ? i : i.path) === p);
  const added = [];
  if (unit.sku_photo_path && !has(unit.sku_photo_path)) { images.unshift({ path: unit.sku_photo_path, label: 'SKU Barcode Photo' }); added.push('SKU barcode'); }
  if (unit.serial_photo_path && !has(unit.serial_photo_path)) { images.unshift({ path: unit.serial_photo_path, label: 'Serial Number Photo' }); added.push('serial'); }
  db.transaction(() => {
    db.prepare(`UPDATE inventory SET availability='Sold', contract_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id, unit.id);
    db.prepare(`UPDATE contracts SET status=?, extra_images=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(toReceived ? 'received' : c.status, images.length ? JSON.stringify(images) : null, c.id);
  })();
  return { unit, fromStatus: c.status, toReceived, photosAdded: added };
}

module.exports = { findUnlinkedSerials, linkInStockSerial };
