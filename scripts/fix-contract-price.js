/**
 * Correct a mistyped spa price on a contract — the portal can't edit prices
 * after saving. Recalculates subtotal, tax, Grand Total and the balance; the
 * contract PDF is rebuilt on its next download, the Sheet's Paid/Pending is
 * updated, and the old and new figures go in the activity log. The serial is
 * also written in capitals (contract + Sheet). See services/contractPriceFix.js.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/fix-contract-price.js <contract#> --spa-price 20300            # report only
 *   node scripts/fix-contract-price.js <contract#> --spa-price 20300 --apply    # backup, then save
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { planPriceFix, applyPriceFix } = require(path.join(__dirname, '../services/contractPriceFix'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contractNumber = args[0] && !args[0].startsWith('--') ? args[0].trim() : '';
const i = args.indexOf('--spa-price');
const newSpa = i >= 0 ? parseFloat(String(args[i + 1] || '').replace(/[$,\s]/g, '')) : NaN;

async function main() {
  if (!contractNumber || !(newSpa > 0)) {
    console.log('Usage: node scripts/fix-contract-price.js <contract#> --spa-price 20300 [--apply]');
    process.exit(1);
  }
  const plan = planPriceFix(db, contractNumber, newSpa);
  const rows = ['spaPrice', 'subtotal', 'taxPercent', 'taxAmount', 'productTotal', 'grandTotal', 'balance', 'serial'];
  console.log(`${contractNumber}   (payments recorded: $${plan.paid})`);
  for (const k of rows) console.log(`  ${k.padEnd(13)} ${String(plan.before[k] ?? '—').padStart(14)}  →  ${plan.after[k]}`);
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to save.'); return; }

  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
  const r = applyPriceFix(db, plan);
  logActivity(db, { contractId: plan.contract.id, contractNum: contractNumber, eventType: 'CONTRACT_UPDATED',
    actor: 'fix-contract-price',
    detail: `Spa price corrected ${plan.before.spaPrice} → ${plan.after.spaPrice}; Grand Total ${plan.before.grandTotal} → ${plan.after.grandTotal}; balance ${plan.before.balance} → ${plan.after.balance}`
      + (plan.before.serial !== plan.after.serial ? `; serial ${plan.before.serial} → ${plan.after.serial}` : '') });
  console.log('\nSaved.');

  try {
    const { updatePaymentInSheet, updateTBOSerial } = require(path.join(__dirname, '../services/driveInventory'));
    await updatePaymentInSheet(contractNumber, r.paid, r.balance);
    if (plan.after.serial && plan.before.serial !== plan.after.serial) await updateTBOSerial(contractNumber, plan.after.serial);
    console.log('Google Sheet updated (Paid / Pending' + (plan.before.serial !== plan.after.serial ? ', serial' : '') + ').');
  } catch (e) { console.log('Google Sheet NOT updated (' + e.message + ') — the app is correct; fix the row by hand if needed.'); }
  console.log('The contract PDF is rebuilt the next time it is downloaded.');
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
