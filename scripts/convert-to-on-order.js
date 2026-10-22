/**
 * Link an Assigned / To Be Ordered contract to a spa that's already on order
 * (e.g. the salesperson typed "Truck 20" as the serial instead of picking the
 * on-order spa). The contract becomes Order Placed with that spa reserved; a
 * placeholder unit the contract created from the typed serial is deleted (app
 * and Sheet); any real spa it had goes back to stock.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/convert-to-on-order.js <contract#>                    # current state + on-order spas it can take
 *   node scripts/convert-to-on-order.js <contract#> --to <id>          # report only
 *   node scripts/convert-to-on-order.js <contract#> --to <id> --apply  # backup, then convert
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { getUnreservedOrdered, findOrderedMatches, convertToOnOrder } = require(path.join(__dirname, '../services/orderedStock'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contractNumber = args[0] && !args[0].startsWith('--') ? args[0].trim() : '';
const toIdx = args.indexOf('--to');
const toId = toIdx >= 0 ? parseInt(args[toIdx + 1], 10) : null;

const unitLine = u => `id ${u.id}  ${u.make} ${u.model}${u.year ? ' ' + u.year : ''}  ${u.shell_color || '—'} / ${u.cabinet_color || '—'}  ` +
  (u.serial_number ? `serial ${u.serial_number}  [${u.availability}]` : `Truck ${u.truck_number || '—'}  WO ${u.web_order_number || '—'}`);

async function main() {
  if (!contractNumber) { console.log('Usage: node scripts/convert-to-on-order.js <contract#> [--to <id>] [--apply]'); process.exit(1); }
  const c = db.prepare('SELECT * FROM contracts WHERE contract_number=?').get(contractNumber);
  if (!c) { console.log(`Contract ${contractNumber} not found.`); process.exit(1); }
  const p = (() => { try { return JSON.parse(c.data || '{}'); } catch (e) { return {}; } })();
  const pr = p.product || {};
  console.log(`${c.contract_number}  [${c.status}]  ${p.customer?.name || ''}`);
  console.log(`  spa: ${c.make} ${c.model}  ${pr.shellColor || '—'} / ${pr.cabinetColor || '—'}  paperwork: ${pr.status === 'instock' ? 'In Stock' : 'To Be Ordered'}  serial: ${c.serial_number || '—'}`);
  const linked = db.prepare('SELECT * FROM inventory WHERE contract_id=?').all(c.id);
  linked.forEach(u => console.log(`  linked unit: ${unitLine(u)}  → ${u.created_by_contract_id === c.id ? 'WILL BE DELETED (placeholder this contract created)' : 'will go back to stock'}`));
  if (!['assigned', 'tbo'].includes(c.status)) { console.log(`  Contract is "${c.status}" — only Assigned or To Be Ordered can be converted.`); process.exit(2); }

  if (!toId) {
    const options = findOrderedMatches(db, c.make, c.model);
    console.log(`\nUnreserved on-order ${c.make} ${c.model}: ${options.length}`);
    options.forEach(u => console.log('  ' + unitLine(u)));
    console.log('\nRe-run with --to <id> to see the change.');
    return;
  }
  const to = getUnreservedOrdered(db, toId);
  if (!to) { console.log(`  Unit ${toId} is not unreserved on-order stock — nothing changed.`); process.exit(2); }
  console.log(`  link to:     ${unitLine(to)}`);
  const diff = [['make', c.make], ['model', c.model], ['shell_color', pr.shellColor], ['cabinet_color', pr.cabinetColor]]
    .filter(([k, v]) => v && String(v).toLowerCase() !== String(to[k] || '').toLowerCase()).map(([k]) => k);
  if (diff.length) console.log(`  WARNING: contract and spa differ in ${diff.join(', ')} — check this is the right spa.`);
  console.log(`  contract → Order Placed, paperwork To Be Ordered, serial cleared, Truck ${to.truck_number || '—'} / WO ${to.web_order_number || '—'}`);
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to convert.'); return; }

  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { stdio: 'inherit' });
  const { removed, released } = convertToOnOrder(db, c.id, to.id);
  logActivity(db, { contractId: c.id, contractNum: c.contract_number, eventType: 'ORDER_PLACED', actor: 'admin-script',
    detail: `Linked on-order stock — Truck ${to.truck_number || '—'} / WO ${to.web_order_number || '—'}` +
      (removed.length ? `; removed placeholder unit ${removed.map(u => u.serial_number || u.id).join(', ')}` : '') +
      (released.length ? `; returned to stock ${released.map(u => u.serial_number || u.id).join(', ')}` : '') });
  console.log(`Converted: Order Placed, Truck ${to.truck_number || '—'} / WO ${to.web_order_number || '—'}.`);

  // Google Sheet: contract row → Order Placed tab; placeholder rows out of Inventory Items; Customer Record.
  try {
    const drive = require(path.join(__dirname, '../services/driveInventory'));
    const { buildDriveData } = require(path.join(__dirname, '../routes/contracts'));
    const { syncCustomerRecord } = require(path.join(__dirname, '../services/customers'));
    const fresh = db.prepare('SELECT * FROM contracts WHERE id=?').get(c.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(fresh.customer_id);
    await drive.deleteContractRowFromSheet(fresh.contract_number);
    await drive.moveToOrderPlaced(fresh.contract_number, fresh.web_order_number || '', fresh.truck_number || '', buildDriveData(fresh, customer));
    for (const u of removed) if (u.serial_number) await drive.deleteInventoryItem(u.serial_number);
    for (const u of released) if (u.serial_number && u.availability !== 'Ordered') await drive.updateInventoryItemField(u.serial_number, 'availability', 'In-stock');
    await syncCustomerRecord(c.id);
    console.log('Google Sheet updated.');
  } catch (e) { console.log(`Google Sheet NOT fully updated (${e.message}) — the app is correct; run node scripts/replace-inventory.js --sheet-only for the inventory tab.`); }
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
