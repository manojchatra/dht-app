/**
 * Removes test sales/warehouse users and their contracts before a client
 * handover. Goes further than the app's own admin "Delete Contract" button,
 * which only removes two of the tracked image fields and misses the
 * acknowledgement PDF, delivery photos/signatures, activity_log/
 * notifications rows, and the contract's upload folder entirely. This
 * removes all of it, plus unlinks (not deletes) any inventory item the
 * contract was tied to, since SQLite's foreign-key constraint blocks
 * deleting a contract that's still referenced.
 *
 * Safe by default: prints exactly what it WOULD do and touches nothing
 * unless you pass --confirm. Run node scripts/list-test-data.js first to
 * find the exact usernames/contract numbers to pass in here.
 *
 * Run this ON THE SERVER where the app actually runs (reads the same
 * db/database.js the app itself uses).
 *
 * Usage:
 *   node scripts/cleanup-test-data.js --users=u1,u2 --contracts=DHT2609PH00001,DHT2609PH00002 [--confirm]
 *
 * --users can be omitted if you only want to remove contracts.
 * --contracts can be omitted if you only want to remove users (any
 *   contracts still attributed to those users will block their deletion —
 *   the script tells you which ones instead of forcing it).
 * Every contract belonging to a listed user is included automatically, in
 * addition to anything named directly in --contracts.
 * Without --confirm this is a dry run: nothing is deleted or removed.
 */
const path = require('path');
const fs   = require('fs');
const db   = require(path.join(__dirname, '../db/database'));

function parseArgs() {
  const args = { users: [], contracts: [], confirm: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--confirm') args.confirm = true;
    else if (a.startsWith('--users=')) args.users = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--contracts=')) args.contracts = a.slice(12).split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

function main() {
  const { users: usernames, contracts: contractNumbers, confirm } = parseArgs();
  if (!usernames.length && !contractNumbers.length) {
    console.log('Nothing to do — pass --users=... and/or --contracts=...');
    console.log('Run node scripts/list-test-data.js first to find the exact values.');
    return;
  }

  console.log(confirm ? '*** LIVE RUN — changes will be made ***' : '*** DRY RUN — nothing will be changed (pass --confirm to actually run this) ***');
  console.log('');

  // Resolve users
  const users = usernames.map(uname => {
    const row = db.prepare(`SELECT * FROM users WHERE username=?`).get(uname);
    if (!row) console.log(`! User not found, skipping: ${uname}`);
    return row;
  }).filter(Boolean);

  // Resolve contracts: everything named explicitly, plus everything
  // attributed to any of the listed users.
  const byNumber = contractNumbers.map(num => {
    const row = db.prepare(`SELECT * FROM contracts WHERE contract_number=?`).get(num);
    if (!row) console.log(`! Contract not found, skipping: ${num}`);
    return row;
  }).filter(Boolean);

  const byUser = users.flatMap(u =>
    db.prepare(`SELECT * FROM contracts WHERE salesman_user_id=?`).all(u.id)
  );

  const contractsById = new Map();
  [...byNumber, ...byUser].forEach(c => contractsById.set(c.id, c));
  const contracts = [...contractsById.values()];

  console.log(`Users to remove: ${users.length}`);
  users.forEach(u => console.log(`  - ${u.username} (id=${u.id}, role=${u.role})`));
  console.log(`Contracts to remove: ${contracts.length}`);
  contracts.forEach(c => console.log(`  - ${c.contract_number} (id=${c.id})`));
  console.log('');

  if (!confirm) {
    console.log('Dry run complete — re-run with --confirm to actually delete the above.');
    return;
  }

  // ── Contracts first (users can't be deleted while a contract references them) ──
  for (const c of contracts) {
    console.log(`Removing contract ${c.contract_number}...`);
    db.prepare('DELETE FROM payments WHERE contract_id=?').run(c.id);
    db.prepare('DELETE FROM activity_log WHERE contract_id=?').run(c.id);
    db.prepare('DELETE FROM notifications WHERE contract_id=?').run(c.id);
    const unlinked = db.prepare('UPDATE inventory SET contract_id=NULL WHERE contract_id=?').run(c.id);
    if (unlinked.changes) console.log(`  unlinked ${unlinked.changes} inventory item(s) (left as-is otherwise — not deleted)`);

    const folder = path.join(__dirname, '../uploads/contracts', c.contract_number);
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
      console.log(`  removed upload folder: ${folder}`);
    }

    db.prepare('DELETE FROM contracts WHERE id=?').run(c.id);
    console.log(`  done.`);
  }

  // ── Then users ──
  for (const u of users) {
    const stillReferenced = db.prepare('SELECT COUNT(*) AS c FROM contracts WHERE salesman_user_id=?').get(u.id).c;
    if (stillReferenced) {
      console.log(`! Skipping user ${u.username} — ${stillReferenced} contract(s) still reference them. Add those contract numbers to --contracts and re-run.`);
      continue;
    }
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    console.log(`Removed user ${u.username}.`);
  }

  console.log('');
  console.log('Done. Note: this does not touch data/activity.log (the plain-text log) —');
  console.log('that file is append-only history and this script never rewrites it.');
}

main();
