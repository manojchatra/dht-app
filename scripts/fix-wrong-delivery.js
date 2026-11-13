/**
 * Undo a delivery acknowledgement the crew submitted on the WRONG contract,
 * and give its photos to the contract that was really delivered.
 *
 * The wrong contract goes back to Scheduled (same slot and team; its Google
 * event, greyed out as delivered, gets its zone colour back — reschedule it
 * from the Status page if it isn't delivered on that slot; the crew can submit
 * its own acknowledgement again straight away).
 * Its delivery photos, the signed acknowledgement PDF and the signatures move
 * to the right contract's folder and gallery under their own names, so a later
 * acknowledgement on the right contract can't overwrite them. The right
 * contract's status is NOT changed — mark it Delivered on the Status page.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/fix-wrong-delivery.js <wrong#> <right#>           # report only
 *   node scripts/fix-wrong-delivery.js <wrong#> <right#> --apply   # backup, then fix
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require(path.join(__dirname, '../db/database'));
const { logActivity } = require(path.join(__dirname, '../utils/activityLogger'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const [wrongNum, rightNum] = args.filter(a => !a.startsWith('--')).map(a => a.trim().toUpperCase());

// Next unused "<base>-N-moved<ext>" in a folder.
function freeName(dir, base, ext) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}-${n}-moved${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

async function main() {
  if (!wrongNum || !rightNum) { console.log('Usage: node scripts/fix-wrong-delivery.js <wrong contract#> <right contract#> [--apply]'); process.exit(2); }
  const get = n => db.prepare('SELECT * FROM contracts WHERE contract_number=?').get(n);
  const wrong = get(wrongNum), right = get(rightNum);
  if (!wrong) { console.log(`${wrongNum} not found.`); process.exit(2); }
  if (!right) { console.log(`${rightNum} not found.`); process.exit(2); }
  if (wrong.status !== 'delivered' || !wrong.acknowledgement_pdf) { console.log(`${wrongNum} is ${wrong.status} with no acknowledgement — nothing to undo.`); process.exit(2); }
  if (!['scheduled', 'delivered'].includes(right.status)) { console.log(`${rightNum} is ${right.status} — expected Scheduled or Delivered. Nothing changed.`); process.exit(2); }

  const wrongImgs = JSON.parse(wrong.extra_images || '[]');
  const ackPdf = wrong.acknowledgement_pdf;
  const isAckItem = i => /^Delivery Photo \d+$/.test(i.label) || /^Exception Photo \d+$/.test(i.label) || i.path === ackPdf;
  const moving = wrongImgs.filter(isAckItem);
  const keeping = wrongImgs.filter(i => !isAckItem(i));
  const wrongDir = path.dirname(ackPdf);
  const rightDir = path.join(path.dirname(wrongDir), right.contract_number);
  const sigs = ['sig-customer.png', 'sig-team.png'].map(f => path.join(wrongDir, f)).filter(p => fs.existsSync(p));
  const missing = moving.filter(i => !fs.existsSync(i.path));
  const feedback = db.prepare('SELECT * FROM post_delivery_feedback WHERE contract_id=?').all(wrong.id);

  console.log(`WRONG ${wrong.contract_number}  [${wrong.status}, delivered ${wrong.delivery_date}]`);
  console.log(`  → back to Scheduled: ${wrong.scheduled_datetime.replace('T', ' ')}, team ${wrong.delivery_team}; acknowledgement + delivery date cleared`);
  console.log('  → Google Sheet row: Delivered tab → Assigned tab (Scheduled)');
  console.log(`  → stays in its gallery: ${keeping.map(i => i.label).join(', ') || '(nothing)'}`);
  if (feedback.length) console.log(`  NOTE: ${feedback.length} post-delivery feedback row(s) on it — left as they are (Cory's real delivery follows).`);
  console.log(`RIGHT ${right.contract_number}  [${right.status}] — status not changed`);
  console.log(`  ← moved into ${rightDir}:`);
  moving.forEach(i => console.log(`      ${i.label}  ${path.basename(i.path)}${fs.existsSync(i.path) ? '' : '  (FILE MISSING)'}`));
  sigs.forEach(p => console.log(`      (signature file, not in gallery)  ${path.basename(p)}`));
  if (missing.length) { console.log('\nSome files are missing — nothing changed. Check them by hand.'); process.exit(2); }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to fix.'); return; }

  console.log('\nBacking up the database first…');
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });

  // Files first (a later failure leaves them findable in the right folder).
  fs.mkdirSync(rightDir, { recursive: true });
  const added = [];
  for (const i of moving) {
    const ext = path.extname(i.path);
    const dest = i.path === ackPdf
      ? path.join(rightDir, `${path.basename(ackPdf, ext)}-on-${wrong.contract_number}-form${ext}`)
      : freeName(rightDir, path.basename(i.path, ext).replace(/-\d+$/, ''), ext);
    fs.renameSync(i.path, dest);
    added.push({ path: dest, label: i.path === ackPdf ? `Delivery Acknowledgement (signed on ${wrong.contract_number} form by mistake)` : i.label });
  }
  for (const p of sigs) fs.renameSync(p, freeName(rightDir, path.basename(p, '.png'), '.png'));

  db.transaction(() => {
    db.prepare(`UPDATE contracts SET status='scheduled', delivery_date='', acknowledgement_pdf=NULL, extra_images=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(keeping), wrong.id);
    const rightImgs = JSON.parse(db.prepare('SELECT extra_images FROM contracts WHERE id=?').get(right.id).extra_images || '[]');
    const photos = added.filter(a => a.path.endsWith('.pdf') === false);
    const pdfs = added.filter(a => a.path.endsWith('.pdf'));
    db.prepare('UPDATE contracts SET extra_images=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify([...photos, ...rightImgs, ...pdfs]), right.id);
    db.prepare("UPDATE notifications SET dismissed=1 WHERE contract_id=? AND event_type IN ('DELIVERED','DELIVERED_OWING')").run(wrong.id);
    logActivity(db, { contractId: wrong.id, contractNum: wrong.contract_number, eventType: 'DELIVERY_REVERSED', actor: 'admin-script',
      detail: `Acknowledgement of ${wrong.delivery_date} was for ${right.contract_number} — back to Scheduled; photos and PDF moved to ${right.contract_number}` });
    logActivity(db, { contractId: right.id, contractNum: right.contract_number, eventType: 'PHOTOS_MOVED', actor: 'admin-script',
      detail: `Delivery photos + acknowledgement (signed on ${wrong.contract_number} form by mistake, ${wrong.delivery_date}) moved here` });
  })();
  console.log(`${wrong.contract_number} is Scheduled again; ${added.length} item(s) now in ${right.contract_number}'s gallery.`);

  try {
    const drive = require(path.join(__dirname, '../services/driveInventory'));
    const { buildDriveData } = require(path.join(__dirname, '../routes/contracts'));
    const { syncCustomerRecord } = require(path.join(__dirname, '../services/customers'));
    const fresh = db.prepare('SELECT * FROM contracts WHERE id=?').get(wrong.id);
    const d = buildDriveData(fresh, db.prepare('SELECT * FROM customers WHERE id=?').get(fresh.customer_id));
    d.serialNumber = fresh.serial_number || '';
    await drive.deleteContractRowFromSheet(fresh.contract_number);
    await drive.writeToAssigned(d);
    await drive.updateToScheduled(fresh.contract_number, fresh.scheduled_datetime, d);
    await syncCustomerRecord(fresh.id);
    console.log('Google Sheet updated.');
  } catch (e) { console.log(`Google Sheet NOT updated (${e.message}) — the app is correct; fix ${wrong.contract_number}'s Sheet row by hand.`); }

  // Its calendar event was greyed out as delivered — back to its zone colour.
  try {
    const fresh = db.prepare('SELECT * FROM contracts WHERE id=?').get(wrong.id);
    if (fresh.calendar_event_id) {
      const { updateCalendarEvent } = require(path.join(__dirname, '../services/googleCalendar'));
      await updateCalendarEvent(fresh.calendar_event_id, fresh, JSON.parse(fresh.data || '{}'));
      console.log('Google Calendar event back to its zone colour.');
    }
  } catch (e) { console.log(`Google Calendar NOT updated (${e.message}) — reschedule ${wrong.contract_number} on the Status page to fix its event.`); }
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
