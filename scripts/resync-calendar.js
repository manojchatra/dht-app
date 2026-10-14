/**
 * Put every currently Scheduled delivery onto the calendar set in
 * GOOGLE_CALENDAR_ID — run once after switching to a new Google calendar /
 * service account (see services/calendarResync.js).
 *
 * Usage (on the server, from /home/DHT/dht-app, AFTER .env points at the new calendar):
 *   node scripts/resync-calendar.js            # report only — changes nothing
 *   node scripts/resync-calendar.js --apply    # create the events, save their IDs
 * Safe to re-run: deliveries already on the new calendar are skipped.
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const cal = require(path.join(__dirname, '../services/googleCalendar'));
const { planCalendarResync, applyCalendarResync } = require(path.join(__dirname, '../services/calendarResync'));

const APPLY = process.argv.includes('--apply');
const TEAMS = { team_a: 'Clear Choice Team', team_b: 'Installation Team' };

async function main() {
  console.log(`Calendar:        ${process.env.GOOGLE_CALENDAR_ID || '(not set)'}`);
  console.log(`Service account: ${process.env.GOOGLE_CLIENT_EMAIL || '(not set)'}`);
  console.log('Check these are the NEW calendar and service account before applying.\n');

  const plan = planCalendarResync(db);
  console.log(`Scheduled deliveries: ${plan.length}`);
  for (const { contract: c, past } of plan) {
    console.log(`  ${c.contract_number}  ${c.customer_name}  ${c.scheduled_datetime.replace('T', ' ')} (${c.scheduled_duration || 120} min)  ${TEAMS[c.delivery_team] || c.delivery_team || 'no team'}${past ? '  ← slot already passed' : ''}`);
  }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to create the events.'); return; }

  const access = await cal.checkCalendarAccess();
  console.log(`\nAccess OK (${access.accessRole}). Creating events…`);
  const result = await applyCalendarResync(db, plan, cal);
  console.log(`Created ${result.created.length}, already on this calendar ${result.skipped.length}, failed ${result.failed.length}.`);
  result.failed.forEach(f => console.log('  FAILED ' + f));
  if (result.failed.length) process.exitCode = 1;
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
