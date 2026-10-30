/**
 * Put every currently Scheduled delivery onto the calendar set in
 * GOOGLE_CALENDAR_ID — run once after switching to a new Google calendar /
 * service account (see services/calendarResync.js).
 *
 * Usage (on the server, from /home/DHT/dht-app, AFTER .env points at the new calendar):
 *   node scripts/resync-calendar.js            # report only — changes nothing
 *   node scripts/resync-calendar.js --apply    # create the events, save their IDs
 *   node scripts/resync-calendar.js --refresh  # also rewrite every existing event from its
 *                                              # contract (serial, steps, cover, time, colour)
 * Safe to re-run: deliveries already on the new calendar are skipped (--apply)
 * or brought up to date (--refresh).
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const cal = require(path.join(__dirname, '../services/googleCalendar'));
const { planCalendarResync, applyCalendarResync, applyCalendarRefresh } = require(path.join(__dirname, '../services/calendarResync'));

const REFRESH = process.argv.includes('--refresh');
const APPLY = REFRESH || process.argv.includes('--apply');
const { TEAM_NAMES: TEAMS } = require(path.join(__dirname, '../utils/teams'));

async function main() {
  console.log(`Calendar:        ${process.env.GOOGLE_CALENDAR_ID || '(not set)'}`);
  console.log(`Service account: ${process.env.GOOGLE_CLIENT_EMAIL || '(not set)'}`);
  console.log('Check these are the NEW calendar and service account before applying.\n');

  const plan = planCalendarResync(db);
  console.log(`Scheduled deliveries: ${plan.length}`);
  for (const { contract: c, past } of plan) {
    console.log(`  ${c.contract_number}  ${c.customer_name}  ${c.scheduled_datetime.replace('T', ' ')} (${c.scheduled_duration || 120} min)  ${TEAMS[c.delivery_team] || c.delivery_team || 'no team'}${past ? '  ← slot already passed' : ''}`);
  }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to create missing events, or --refresh to also rewrite existing ones.'); return; }

  const access = await cal.checkCalendarAccess();
  if (REFRESH) {
    console.log(`\nAccess OK (${access.accessRole}). Rewriting every event from its contract…`);
    const r = await applyCalendarRefresh(db, plan, cal);
    console.log(`Updated ${r.updated.length}, created ${r.created.length}, failed ${r.failed.length}.`);
    r.failed.forEach(f => console.log('  FAILED ' + f));
    if (r.failed.length) process.exitCode = 1;
    return;
  }
  console.log(`\nAccess OK (${access.accessRole}). Creating events…`);
  const result = await applyCalendarResync(db, plan, cal);
  console.log(`Created ${result.created.length}, already on this calendar ${result.skipped.length}, failed ${result.failed.length}.`);
  result.failed.forEach(f => console.log('  FAILED ' + f));
  if (result.failed.length) process.exitCode = 1;
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
