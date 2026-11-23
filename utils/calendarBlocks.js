// utils/calendarBlocks.js — time an admin blocks off on the delivery calendar
// (calendar_blocks, Nov 2026). Nobody can book a delivery inside a block, and a
// block can't be saved over deliveries already booked. Times are Phoenix-local
// "YYYY-MM-DDTHH:mm:ss" strings like contracts.scheduled_datetime (Arizona has
// no DST, so -07:00 always).
'use strict';
const { teamName } = require('./teams');

const ms = naive => new Date(naive + '-07:00').getTime();
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

// "1 PM", "1:30 PM"
function hourLabel(naive) {
  const [h, m] = naive.slice(11, 16).split(':').map(Number);
  return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM');
}

// "Dave's off — Wed, Nov 25, 1 PM – 4 PM, Installation Team"
function blockLabel(b) {
  const day = new Date(b.start_datetime + '-07:00').toLocaleDateString('en-US',
    { timeZone: 'America/Phoenix', weekday: 'short', month: 'short', day: 'numeric' });
  const when = b.all_day ? day + ', all day' : day + ', ' + hourLabel(b.start_datetime) + ' – ' + hourLabel(b.end_datetime);
  return (b.note ? b.note + ' — ' : '') + when + ', ' + (b.team ? teamName(b.team) : 'both teams');
}

// The first block that a delivery at `start` for `durationMins` would fall in,
// for this team (blocks for both teams always count). No team → any block.
function blockingBlock(db, start, durationMins, team) {
  const s = ms(start), e = s + durationMins * 60000;
  const rows = db.prepare('SELECT * FROM calendar_blocks WHERE end_datetime > ? ORDER BY start_datetime')
    .all(start.slice(0, 10) + 'T00:00:00');
  return rows.find(b => (!team || !b.team || b.team === team) && overlaps(s, e, ms(b.start_datetime), ms(b.end_datetime))) || null;
}

// Scheduled deliveries inside [start, end) for this team (null = both teams).
function bookingsInside(db, start, end, team) {
  const s = ms(start), e = ms(end);
  return db.prepare(`
      SELECT c.id, c.contract_number, c.scheduled_datetime, c.scheduled_duration, c.delivery_team,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name
      FROM contracts c LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE c.status = 'scheduled' AND COALESCE(c.scheduled_datetime,'') <> ''
      ORDER BY c.scheduled_datetime`).all()
    .filter(c => (!team || !c.delivery_team || c.delivery_team === team))
    .filter(c => { const cs = ms(c.scheduled_datetime); return overlaps(s, e, cs, cs + (c.scheduled_duration || 120) * 60000); });
}

module.exports = { blockingBlock, bookingsInside, blockLabel, hourLabel };
