/**
 * Link a contract to the in-stock spa whose serial it already carries (the spa
 * still shows In-stock and could be sold twice). The spa becomes Sold and
 * linked; a contract still waiting on an order (To Be Ordered / Order Placed)
 * moves to Received, since its spa is in hand. See services/serialLink.js.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/link-serial-to-contract.js                     # list every contract in this state
 *   node scripts/link-serial-to-contract.js <contract#>         # report only
 *   node scripts/link-serial-to-contract.js <contract#> --apply # backup, link, update the Sheet
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { findUnlinkedSerials, linkInStockSerial } = require(path.join(__dirname, '../services/serialLink'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contractNumber = args[0] && !args[0].startsWith('--') ? args[0].trim() : '';
const line = r => `${r.contract_number} [${r.status}]  serial ${r.serial_number}  →  spa id ${r.unit_id} ${r.make} ${r.model} ${r.shell_color || '—'} / ${r.cabinet_color || '—'}  [${r.availability}]` +
  (r.unit_contract_id ? `  LINKED TO ANOTHER CONTRACT (id ${r.unit_contract_id}) — needs a look` : '');

async function main() {
  const all = findUnlinkedSerials(db);
  if (!contractNumber) {
    console.log(`Contracts whose serial is a spa not linked to them: ${all.length}`);
    all.forEach(r => console.log('  ' + line(r)));
    if (all.length) console.log('\nRe-run with a contract number to see the fix for one.');
    return;
  }
  const r = all.find(x => x.contract_number === contractNumber);
  if (!r) { console.log(`${contractNumber}: nothing to link (no unlinked spa with its serial, or it isn't an open contract).`); return; }
  const c = db.prepare('SELECT * FROM contracts WHERE id=?').get(r.contract_id);
  const pr = (() => { try { return JSON.parse(c.data || '{}').product || {}; } catch (e) { return {}; } })();
  console.log(line(r));
  console.log(`  contract says: ${c.make} ${c.model} ${pr.shellColor || '—'} / ${pr.cabinetColor || '—'}${c.truck_number ? `  (Truck ${c.truck_number}, WO ${c.web_order_number})` : ''}`);
  const diff = [['make', c.make, r.make], ['model', c.model, r.model], ['shell', pr.shellColor, r.shell_color], ['cabinet', pr.cabinetColor, r.cabinet_color]]
    .filter(([, a, b]) => a && b && String(a).toLowerCase() !== String(b).toLowerCase()).map(([k]) => k);
  if (diff.length) console.log(`  WARNING: contract and spa differ in ${diff.join(', ')} — check this is the right spa.`);
  if (r.unit_contract_id || r.availability !== 'In-stock') { console.log('  Spa is not free In-stock stock — nothing changed. Sort this one out by hand.'); process.exit(2); }
  const waiting = ['tbo', 'order_placed'].includes(c.status);
  console.log(`  fix: spa → Sold, linked to ${c.contract_number}${waiting ? `; contract ${c.status} → received (spa is in hand)` : ''}`);
  const u = db.prepare('SELECT serial_photo_path, sku_photo_path FROM inventory WHERE id=?').get(r.unit_id);
  const photos = [u.serial_photo_path && 'serial', u.sku_photo_path && 'SKU barcode'].filter(Boolean);
  console.log(`  photos: ${photos.length ? `spa's ${photos.join(' + ')} photo(s) added to the contract's gallery (also kept on the spa)` : 'the spa has none'}`);
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to link.'); return; }

  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
  const { unit, fromStatus, toReceived, photosAdded } = linkInStockSerial(db, c.id);
  logActivity(db, { contractId: c.id, contractNum: c.contract_number, eventType: toReceived ? 'MARK_RECEIVED' : 'STATUS_CHANGED', actor: 'admin-script',
    detail: `Linked in-stock spa ${unit.serial_number} (Sold)${toReceived ? `; ${fromStatus} → received` : ''}` +
      (photosAdded.length ? `; added ${photosAdded.join(' + ')} photo(s) to the gallery` : '') });
  console.log(`Linked: ${unit.serial_number} is Sold to ${c.contract_number}${toReceived ? '; contract is now Received' : ''}` +
    (photosAdded.length ? `; ${photosAdded.join(' + ')} photo(s) added to the gallery` : '') + '.');

  try {
    const drive = require(path.join(__dirname, '../services/driveInventory'));
    const { buildDriveData } = require(path.join(__dirname, '../routes/contracts'));
    const { syncCustomerRecord } = require(path.join(__dirname, '../services/customers'));
    await drive.updateInventoryItemField(unit.serial_number, 'availability', 'Sold');
    if (toReceived) {
      const fresh = db.prepare('SELECT * FROM contracts WHERE id=?').get(c.id);
      const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(fresh.customer_id);
      const today = new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10); // Arizona date
      const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');
      const rel = unit.serial_photo_path ? path.relative(uploadsDir, unit.serial_photo_path) : '';
      const photoUrl = rel && !rel.startsWith('..') ? 'https://app.deserthottubsaz.com/uploads/' + rel.replace(/\\/g, '/') : '';
      await drive.moveToReceived(fresh.contract_number, today, photoUrl, buildDriveData(fresh, customer));
    }
    await syncCustomerRecord(c.id);
    console.log('Google Sheet updated.');
  } catch (e) { console.log(`Google Sheet NOT fully updated (${e.message}) — the app is correct; run node scripts/replace-inventory.js --sheet-only for the inventory tab.`); }
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
