/**
 * Correct a contract's sale date — the portal can't change it after saving.
 * The contract number takes the new year/month and keeps its sequence
 * (DHT2611PH00098 → DHT2609PH00098): its upload folder, stored photo paths,
 * activity log and notifications follow. Payments taken at signing of an old
 * sale entered after delivery move to the new date. The Google Sheet row
 * (Contract ID, Contract Date) and the Customer Record row are updated; the
 * contract PDF is rebuilt on its next download. See services/contractDateFix.js.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/fix-contract-date.js <contract#> --date 9-20-2026            # report only
 *   node scripts/fix-contract-date.js <contract#> --date 9-20-2026 --apply    # backup, then save
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { planDateFix, applyDateFix } = require(path.join(__dirname, '../services/contractDateFix'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));
const { phoenixToday } = require(path.join(__dirname, '../utils/arizona'));
const { removeContractThumbs } = require(path.join(__dirname, '../middleware/thumbnails'));

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contractNumber = args[0] && !args[0].startsWith('--') ? args[0].trim().toUpperCase() : '';
const i = args.indexOf('--date');
const newDate = i >= 0 ? args[i + 1] : '';

async function main() {
  if (!contractNumber || !newDate) {
    console.log('Usage: node scripts/fix-contract-date.js <contract#> --date 9-20-2026 [--apply]');
    process.exit(1);
  }
  const plan = planDateFix(db, contractNumber, newDate, { today: phoenixToday(), uploadsDir: UPLOADS_DIR });
  const { before, after } = plan;
  const renumber = after.number !== before.number;
  console.log(`${before.number}   (${plan.contract.status}${plan.contract.back_entered ? ', entered after delivery' : ''})`);
  console.log(`  Sale date      ${before.date}  →  ${after.date}`);
  console.log(`  Number         ${before.number}  →  ${after.number}${renumber ? '' : '   (unchanged)'}`);
  if (renumber) console.log(`  Folder         ${plan.folder.exists ? plan.folder.from + '  →  ' + plan.folder.to : '(none yet)'}`);
  console.log(`  Payments       ${plan.payments.length
    ? plan.payments.map(p => `$${p.amount} ${p.method} ${p.date} → ${after.date}`).join('; ')
    : 'none re-dated (only payments taken at signing of an old sale entered after delivery move)'}`);
  plan.warnings.forEach(w => console.log('  WARNING: ' + w));
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to save.'); return; }

  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });
  applyDateFix(db, plan);
  if (renumber) removeContractThumbs(UPLOADS_DIR, before.number); // made again when next viewed
  logActivity(db, { contractId: plan.contract.id, contractNum: after.number, eventType: 'CONTRACT_UPDATED',
    actor: 'fix-contract-date',
    detail: `Sale date corrected ${before.date} → ${after.date}` + (renumber ? `; contract number ${before.number} → ${after.number}` : '')
      + (plan.payments.length ? `; ${plan.payments.length} payment(s) taken at signing re-dated` : '') });
  console.log('\nSaved.');

  try {
    const drive = require(path.join(__dirname, '../services/driveInventory'));
    const { syncCustomerRecord, removeCustomerRecord } = require(path.join(__dirname, '../services/customers'));
    const tab = await drive.fixContractRowNumberAndDate(before.number, after.number, after.date);
    console.log(tab ? `Google Sheet: ${tab} row updated.` : 'Google Sheet: no row found for ' + before.number + ' — nothing to update there.');
    if (renumber) await removeCustomerRecord(before.number);
    console.log((await syncCustomerRecord(plan.contract.id)) ? 'Customer Record row written.' : 'Customer Record row NOT written — run migrate-customers.js --sync-sheet later.');
  } catch (e) { console.log('Google Sheet NOT updated (' + e.message + ') — the app is correct; fix the row by hand if needed.'); }
  console.log('The contract PDF is rebuilt the next time it is downloaded.');
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
