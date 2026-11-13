/**
 * Put delivered contracts back on Google Calendar, greyed out (Graphite).
 *
 * Before Nov 2026 a delivery DELETED its Google event; now the event stays
 * and turns grey. This creates a grey event for every Delivered contract that
 * has a delivery slot but no event on the calendar, so Google matches the
 * portal's calendar. The event is built from the contract exactly like a new
 * booking (title, description, location, slot) and its ID is saved, so later
 * changes reach it. Delivered contracts with no delivery slot (e.g. back-dated
 * ones never scheduled) are listed and left alone.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/restore-delivered-events.js                         # report only
 *   node scripts/restore-delivered-events.js --since=2026-01-01      # report, slots from that date
 *   node scripts/restore-delivered-events.js [--since=…] --apply     # backup, then create
 * Safe to re-run: contracts whose event is already on the calendar are skipped.
 */
require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Delivered contracts with a slot (optionally from `since`), oldest first.
function planDeliveredEvents(db, since) {
  const all = db.prepare(`
    SELECT c.*, COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name
    FROM contracts c LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.status = 'delivered'
    ORDER BY COALESCE(c.scheduled_datetime,''), c.id`).all();
  const noSlot = all.filter(c => !c.scheduled_datetime);
  const withSlot = all.filter(c => c.scheduled_datetime && (!since || c.scheduled_datetime.slice(0, 10) >= since));
  return { withSlot, noSlot };
}

// Create the missing events (grey) and save their IDs. `cal` = services/googleCalendar.
async function applyDeliveredEvents(db, contracts, cal, { pause = 150 } = {}) {
  const created = [], skipped = [], failed = [];
  const save = db.prepare('UPDATE contracts SET calendar_event_id=? WHERE id=?');
  for (const c of contracts) {
    try {
      if (c.calendar_event_id && await cal.calendarEventExists(c.calendar_event_id)) {
        await cal.markEventDelivered(c.calendar_event_id); // make sure it's grey
        skipped.push(c.contract_number);
        continue;
      }
      const id = await cal.createCalendarEvent(c, JSON.parse(c.data || '{}'));
      if (!id) throw new Error('calendar not configured');
      save.run(id, c.id); // saved before the colour change, so a failure there can't duplicate it on a re-run
      await cal.markEventDelivered(id);
      created.push(c.contract_number);
    } catch (e) {
      failed.push(`${c.contract_number}: ${e.message}`);
    }
    if (pause) await sleep(pause);
  }
  return { created, skipped, failed };
}

async function main() {
  const db = require(path.join(__dirname, '../db/database'));
  const cal = require(path.join(__dirname, '../services/googleCalendar'));
  const APPLY = process.argv.includes('--apply');
  const sinceArg = process.argv.find(a => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice(8) : '';
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.log('--since must be YYYY-MM-DD, e.g. --since=2026-01-01'); process.exit(2); }

  console.log(`Calendar: ${process.env.GOOGLE_CALENDAR_ID || '(not set)'}`);
  const { withSlot, noSlot } = planDeliveredEvents(db, since);
  console.log(`\nDelivered with a delivery slot${since ? ' from ' + since : ''}: ${withSlot.length}`);
  for (const c of withSlot) {
    console.log(`  ${c.contract_number}  ${c.customer_name || ''}  ${c.scheduled_datetime.replace('T', ' ')}  ${c.calendar_event_id ? '(has an event ID — kept if still on the calendar)' : '← event to create'}`);
  }
  if (noSlot.length) {
    console.log(`\nDelivered with NO delivery slot — left alone: ${noSlot.length}`);
    noSlot.forEach(c => console.log(`  ${c.contract_number}  ${c.customer_name || ''}  delivered ${c.delivery_date || '?'}`));
  }
  if (!APPLY) { console.log('\nREPORT ONLY — nothing was changed. Re-run with --apply to create the grey events.'); return; }
  if (!withSlot.length) { console.log('\nNothing to do.'); return; }

  const access = await cal.checkCalendarAccess();
  console.log(`\nAccess OK (${access.accessRole}). Backing up the database first…`);
  execFileSync(process.execPath, [path.join(__dirname, 'backup-db.js'), '--manual'], { stdio: 'inherit' });

  console.log('Creating grey events…');
  const r = await applyDeliveredEvents(db, withSlot, cal);
  console.log(`\nCreated ${r.created.length}, already on the calendar ${r.skipped.length}, failed ${r.failed.length}.`);
  r.failed.forEach(f => console.log('  FAILED ' + f));
  if (r.failed.length) { console.log('Re-run with --apply to retry the failed ones (created ones are skipped).'); process.exitCode = 1; }
}

module.exports = { planDeliveredEvents, applyDeliveredEvents };
if (require.main === module) main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
