/**
 * Move an Order Placed contract to a different on-order spa (e.g. it was
 * linked to the Truck 21 unit but should be the identical Truck 20 one).
 * The old unit goes back to unreserved on-order stock; the contract takes the
 * new unit's Web Order # / Truck #, and its Order Placed Sheet row is rewritten.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/relink-ordered-unit.js <contract#>                    # shows the current unit + the units it can move to
 *   node scripts/relink-ordered-unit.js <contract#> --to <id>          # report only
 *   node scripts/relink-ordered-unit.js <contract#> --to <id> --apply  # backup, then switch
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { reservedUnitFor, getUnreservedOrdered, findOrderedMatches, relinkOrdered } = require(path.join(__dirname, '../services/orderedStock'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contractNumber = args[0] && !args[0].startsWith('--') ? args[0].trim() : '';
const toIdx = args.indexOf('--to');
const toId = toIdx >= 0 ? parseInt(args[toIdx + 1], 10) : null;

const unitLine = u => `id ${u.id}  ${u.make} ${u.model}${u.year ? ' ' + u.year : ''}  ${u.shell_color || '—'} / ${u.cabinet_color || '—'}  Truck ${u.truck_number || '—'}  WO ${u.web_order_number || '—'}`;

async function main() {
  if (!contractNumber) { console.log('Usage: node scripts/relink-ordered-unit.js <contract#> [--to <id>] [--apply]'); process.exit(1); }
  const c = db.prepare('SELECT * FROM contracts WHERE contract_number=?').get(contractNumber);
  if (!c) { console.log(`Contract ${contractNumber} not found.`); process.exit(1); }
  const name = (() => { try { return JSON.parse(c.data || '{}').customer?.name || ''; } catch (e) { return ''; } })();
  const from = reservedUnitFor(db, c.id);

  console.log(`${c.contract_number}  [${c.status}]  ${name}  —  ${c.make} ${c.model}  Truck ${c.truck_number || '—'}  WO ${c.web_order_number || '—'}`);
  console.log(`  linked now: ${from ? unitLine(from) : '(no on-order unit reserved)'}`);

  if (!toId) {
    const options = findOrderedMatches(db, c.make, c.model);
    console.log(`\nUnreserved on-order ${c.make} ${c.model} it can move to: ${options.length}`);
    options.forEach(u => console.log('  ' + unitLine(u)));
    console.log('\nRe-run with --to <id> to see the switch.');
    return;
  }

  const to = getUnreservedOrdered(db, toId);
  if (!to) { console.log(`  Unit ${toId} is not unreserved on-order stock — nothing changed.`); process.exit(2); }
  console.log(`  move to:    ${unitLine(to)}`);
  if (from) {
    const diff = ['make', 'model', 'shell_color', 'cabinet_color'].filter(k => String(from[k] || '').toLowerCase() !== String(to[k] || '').toLowerCase());
    if (diff.length) console.log(`  WARNING: the two units differ in ${diff.join(', ')} — check this is the right spa.`);
  }
  if (c.status !== 'order_placed') { console.log(`  Contract is "${c.status}" — only Order Placed (not yet received) can be re-linked. Nothing changed.`); process.exit(2); }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to switch.'); return; }

  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
  relinkOrdered(db, c.id, to.id);
  logActivity(db, { contractId: c.id, contractNum: c.contract_number, eventType: 'ORDER_PLACED', actor: 'admin-script',
    detail: `Re-linked on-order stock: Truck ${from?.truck_number || '—'} / WO ${from?.web_order_number || '—'} → Truck ${to.truck_number || '—'} / WO ${to.web_order_number || '—'}` });
  console.log(`Switched: now Truck ${to.truck_number || '—'}, WO ${to.web_order_number || '—'}.${from ? ` Unit ${from.id} is back in on-order stock.` : ''}`);

  // Google Sheet: rewrite the contract's Order Placed row with the new numbers.
  try {
    const { deleteContractRowFromSheet, moveToOrderPlaced } = require(path.join(__dirname, '../services/driveInventory'));
    const { buildDriveData } = require(path.join(__dirname, '../routes/contracts'));
    const fresh = db.prepare('SELECT * FROM contracts WHERE id=?').get(c.id);
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(fresh.customer_id);
    await deleteContractRowFromSheet(fresh.contract_number);
    await moveToOrderPlaced(fresh.contract_number, fresh.web_order_number || '', fresh.truck_number || '', buildDriveData(fresh, customer));
    console.log('Google Sheet "Order Placed" row updated.');
  } catch (e) { console.log(`Google Sheet NOT updated (${e.message}) — the app is correct; the row catches up on the contract's next status move.`); }
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
