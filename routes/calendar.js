/**
 * calendar.js — the delivery calendar page's data (Nov 2026)
 *
 * GET    /api/calendar/bookings     admin: every scheduled + delivered booking.
 *                                    sales: their own in full, and everyone else's
 *                                    scheduled ones as "Booked" — time, team, zone
 *                                    colour and the salesperson's first name only.
 * GET    /api/calendar/schedulable  Assigned + Received contracts the + box can
 *                                    book (sales: their own), with why one can't yet.
 * GET    /api/calendar/blocks       time blocked off (delivery crews: their team's
 *                                    and both-team blocks).
 * POST   /api/calendar/blocks       admin: block off time (refused over bookings).
 * DELETE /api/calendar/blocks/:id   admin: remove a block.
 *
 * Delivery crews keep GET /api/delivery/calendar for their bookings.
 */
'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireRole, requireAdmin } = require('../middleware/auth');
const { zoneForZip } = require('../utils/deliveryZones');
const { teamName, TEAM_NAMES } = require('../utils/teams');
const { totalPaid } = require('../utils/paymentTotals');
const { phoenixToday } = require('../utils/arizona');
const { bookingsInside, hourLabel } = require('../utils/calendarBlocks');
const { createBlockEvent, deleteCalendarEvent } = require('../services/googleCalendar');

const zone = zip => { const z = zoneForZip(zip); return { zone_name: z.name, zone_color: z.hex, zone_text_color: z.text }; };
const firstName = s => String(s || '').trim().split(/\s+/)[0] || '';

// ── Bookings ─────────────────────────────────────────────────────────────────
router.get('/bookings', requireRole(['admin', 'sales']), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.contract_number, c.status, c.make, c.model, c.serial_number, c.salesman, c.salesman_user_id,
        c.scheduled_datetime, c.scheduled_duration, c.delivery_team,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name,
        COALESCE(json_extract(c.data,'$.customer.address'), cu.address) AS address,
        COALESCE(json_extract(c.data,'$.customer.city'), cu.city) AS city,
        COALESCE(json_extract(c.data,'$.customer.zip'), cu.zip) AS zip
      FROM contracts c LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.status IN ('scheduled','delivered') AND COALESCE(c.scheduled_datetime,'') <> ''
      ORDER BY c.scheduled_datetime`).all();
    const admin = req.session.role === 'admin';
    const out = [];
    for (const r of rows) {
      const { salesman_user_id, ...full } = r;
      if (admin || salesman_user_id === req.session.userId) { out.push({ ...full, ...zone(r.zip), mine: true }); continue; }
      if (r.status !== 'scheduled') continue; // other people's past deliveries aren't needed to book
      out.push({ id: null, mine: false, status: r.status, scheduled_datetime: r.scheduled_datetime,
        scheduled_duration: r.scheduled_duration, delivery_team: r.delivery_team,
        salesman_first: firstName(r.salesman), ...zone(r.zip) });
    }
    res.json(out);
  } catch (e) {
    console.error('[Calendar bookings]', e.message);
    res.status(500).json({ error: 'Failed to load the calendar' });
  }
});

// ── Contracts the + box can book ─────────────────────────────────────────────
router.get('/schedulable', requireRole(['admin', 'sales']), (req, res) => {
  try {
    const own = req.session.role === 'sales';
    const rows = db.prepare(`
      SELECT c.id, c.contract_number, c.status, c.salesman, c.serial_number, c.grand_total, c.created_at,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS customer_name,
        COALESCE(json_extract(c.data,'$.customer.address'), cu.address, '') AS address,
        COALESCE(json_extract(c.data,'$.customer.city'), cu.city, '') AS city,
        COALESCE(json_extract(c.data,'$.customer.zip'), cu.zip, '') AS zip
      FROM contracts c LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.status IN ('assigned','received') ${own ? 'AND c.salesman_user_id = ?' : ''}
      ORDER BY c.created_at DESC`).all(...(own ? [req.session.userId] : []));
    res.json(rows.map(r => {
      const balance = Math.round((parseFloat(r.grand_total || 0) - totalPaid(db, r.id)) * 100) / 100;
      const why = !String(r.serial_number || '').trim() ? 'No serial'
        : balance > 0 ? 'Balance $' + balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' owing'
        : '';
      return { id: r.id, contract_number: r.contract_number, status: r.status, customer_name: r.customer_name,
        salesman: r.salesman || '', address: r.address, city: r.city, zip: r.zip, why };
    }));
  } catch (e) {
    console.error('[Calendar schedulable]', e.message);
    res.status(500).json({ error: 'Failed to load contracts' });
  }
});

// ── Blocks ───────────────────────────────────────────────────────────────────
router.get('/blocks', requireRole(['admin', 'sales', 'delivery']), (req, res) => {
  try {
    const crew = req.session.role === 'delivery';
    const rows = db.prepare(`SELECT id, start_datetime, end_datetime, all_day, team, note FROM calendar_blocks
      ${crew ? 'WHERE team IS NULL OR team = ?' : ''} ORDER BY start_datetime`).all(...(crew ? [req.session.team] : []));
    res.json(rows.map(b => ({ ...b, all_day: !!b.all_day, team_name: b.team ? teamName(b.team) : 'Both teams' })));
  } catch (e) {
    console.error('[Calendar blocks]', e.message);
    res.status(500).json({ error: 'Failed to load blocked times' });
  }
});

const HOUR = /^([01]\d|2[0-3]):00$/;
const nextDay = date => new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);

router.post('/blocks', requireAdmin, async (req, res) => {
  try {
    const { date, from, to, allDay } = req.body || {};
    const team = req.body.team || null;
    const note = String(req.body.note || '').trim().slice(0, 60);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || isNaN(Date.parse(date))) return res.status(400).json({ error: 'Choose a date.' });
    if (date < phoenixToday()) return res.status(400).json({ error: 'That date has passed.' });
    if (team && !TEAM_NAMES[team]) return res.status(400).json({ error: 'Unknown team.' });
    let start, end;
    if (allDay) { start = date + 'T00:00:00'; end = nextDay(date) + 'T00:00:00'; }
    else {
      if (!HOUR.test(from || '') || !HOUR.test(to || '')) return res.status(400).json({ error: 'Choose a From and To time.' });
      if (to <= from) return res.status(400).json({ error: '"To" must be later than "From".' });
      start = date + 'T' + from + ':00'; end = date + 'T' + to + ':00';
    }

    // Deliveries already booked in that time must be rescheduled first.
    const clash = bookingsInside(db, start, end, team);
    if (clash.length) {
      return res.status(409).json({
        error: 'This time has deliveries booked. Reschedule them first, then block the time.',
        conflicts: clash.map(c => ({ id: c.id, contract_number: c.contract_number, customer_name: c.customer_name,
          team: teamName(c.delivery_team) || 'No team',
          slot: hourLabel(c.scheduled_datetime) + ' – ' + hourLabel(new Date(Date.parse(c.scheduled_datetime + 'Z') + (c.scheduled_duration || 120) * 60000).toISOString().slice(0, 19)) })),
      });
    }

    const block = { start_datetime: start, end_datetime: end, all_day: allDay ? 1 : 0, team, note, created_by: req.session.username };
    const id = db.prepare(`INSERT INTO calendar_blocks (start_datetime, end_datetime, all_day, team, note, created_by)
      VALUES (@start_datetime, @end_datetime, @all_day, @team, @note, @created_by)`).run(block).lastInsertRowid;
    try {
      const eventId = await createBlockEvent(block);
      if (eventId) db.prepare('UPDATE calendar_blocks SET google_event_id=? WHERE id=?').run(eventId, id);
    } catch (e) { console.error('[Calendar block event failed]', e.message); }
    console.log(`[Calendar] ${req.session.username} blocked ${start} – ${end} (${team || 'both teams'})${note ? ': ' + note : ''}`);
    res.json({ ok: true, id });
  } catch (e) {
    console.error('[Calendar block save]', e.message);
    res.status(500).json({ error: 'Failed to save the block' });
  }
});

router.delete('/blocks/:id', requireAdmin, async (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM calendar_blocks WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'That block was already removed.' });
    db.prepare('DELETE FROM calendar_blocks WHERE id=?').run(b.id);
    if (b.google_event_id) {
      try { await deleteCalendarEvent(b.google_event_id); } catch (e) { console.error('[Calendar block event delete failed]', e.message); }
    }
    console.log(`[Calendar] ${req.session.username} removed the block ${b.start_datetime} – ${b.end_datetime}${b.note ? ': ' + b.note : ''}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Calendar block delete]', e.message);
    res.status(500).json({ error: 'Failed to remove the block' });
  }
});

module.exports = router;
