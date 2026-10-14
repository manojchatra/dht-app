/**
 * calendarResync.js — put every currently Scheduled delivery onto the calendar
 * in GOOGLE_CALENDAR_ID (used when moving to a new calendar / Google account).
 *
 * A contract whose saved event already exists on that calendar is skipped, so
 * re-running never duplicates events. Events on the old calendar are left
 * alone (the new service account usually can't reach them).
 * Used by scripts/resync-calendar.js (report by default, --apply to write).
 */

// Today in Arizona as "YYYY-MM-DDTHH:mm" (scheduled_datetime is naive Arizona time).
const phoenixNow = () => new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 16);

function planCalendarResync(db) {
  const rows = db.prepare(`
    SELECT c.*, COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name
    FROM contracts c LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.status = 'scheduled' AND COALESCE(c.scheduled_datetime,'') <> ''
    ORDER BY c.scheduled_datetime`).all();
  const now = phoenixNow();
  return rows.map(c => ({ contract: c, past: c.scheduled_datetime.slice(0, 16) < now }));
}

// cal = { createCalendarEvent, calendarEventExists } (services/googleCalendar)
async function applyCalendarResync(db, plan, cal) {
  const result = { created: [], skipped: [], failed: [] };
  const save = db.prepare('UPDATE contracts SET calendar_event_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  for (const { contract } of plan) {
    try {
      if (contract.calendar_event_id && await cal.calendarEventExists(contract.calendar_event_id)) {
        result.skipped.push(contract.contract_number);
        continue;
      }
      const data = JSON.parse(contract.data || '{}');
      const eventId = await cal.createCalendarEvent(contract, data);
      if (!eventId) throw new Error('calendar not configured');
      save.run(eventId, contract.id);
      result.created.push(contract.contract_number);
    } catch (e) {
      result.failed.push(`${contract.contract_number}: ${e.message}`);
    }
  }
  return result;
}

module.exports = { planCalendarResync, applyCalendarResync };
