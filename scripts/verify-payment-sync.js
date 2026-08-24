/**
 * Diagnostic for the payment -> Google Sheets sync fix (v13 Phase 1, item 2).
 * Not wired into `npm test` — run manually against a real ZZTEST contract that
 * already has at least one payment recorded through the app UI.
 *
 * Usage: node scripts/verify-payment-sync.js <contractId>
 *   <contractId> is the numeric contracts.id (not the contract_number string).
 *
 * Requires GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / INVENTORY_FILE_ID to be
 * set (this app's .env on the server, not necessarily local dev).
 */
require('dotenv').config();
const path = require('path');
const db   = require(path.join(__dirname, '../db/database'));
const { updatePaymentInSheet, readPaymentFromSheet } = require(path.join(__dirname, '../services/driveInventory'));

async function main() {
  const contractId = process.argv[2];
  if (!contractId) {
    console.error('Usage: node scripts/verify-payment-sync.js <contractId>');
    process.exit(1);
  }

  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
  if (!contract) {
    console.error(`FAIL: no contract with id=${contractId}`);
    process.exit(1);
  }

  const totalPaid  = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=?').get(contractId).t;
  const data       = JSON.parse(contract.data || '{}');
  const grandTotal = parseFloat(data.costing?.grandTotal || contract.grand_total || 0);
  const expectedPending = Math.max(0, grandTotal - totalPaid);

  console.log(`Contract: ${contract.contract_number} (id=${contractId})`);
  console.log(`  Grand total:     $${grandTotal}`);
  console.log(`  Sum of payments: $${totalPaid}`);
  console.log(`  Expected pending:$${expectedPending}`);

  console.log('\nStep 1: reading current Sheet state before update...');
  const before = await readPaymentFromSheet(contract.contract_number);
  if (!before) {
    console.error(`FAIL: contract ${contract.contract_number} not found in any tab (TBO/Assigned/Delivered/Cancelled/Received)`);
    process.exit(1);
  }
  console.log(`  Found in tab "${before.tab}" row ${before.row}: paid=${before.paid} pending=${before.pending}`);

  console.log('\nStep 2: writing computed paid/pending via updatePaymentInSheet...');
  const wrote = await updatePaymentInSheet(contract.contract_number, totalPaid, expectedPending);
  if (!wrote) {
    console.error('FAIL: updatePaymentInSheet reported it could not find a row to update');
    process.exit(1);
  }

  console.log('\nStep 3: reading back the Sheet to confirm the write landed...');
  const after = await readPaymentFromSheet(contract.contract_number);
  const paidMatch    = String(after.paid)    === String(totalPaid || '');
  const pendingMatch = String(after.pending) === String(expectedPending || '');
  console.log(`  Sheet now shows: paid=${after.paid} pending=${after.pending}`);

  if (paidMatch && pendingMatch) {
    console.log('\nPASS: Sheet paid/pending match the DB-computed values.');
    process.exit(0);
  } else {
    console.error('\nFAIL: Sheet values do not match expected values after write.');
    console.error(`  Expected paid=${totalPaid} pending=${expectedPending}`);
    console.error(`  Got      paid=${after.paid} pending=${after.pending}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FAIL: unexpected error', err);
  process.exit(1);
});
