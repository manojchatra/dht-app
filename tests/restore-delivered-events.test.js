'use strict';
// scripts/restore-delivered-events.js — grey Google events for contracts
// delivered before deliveries stopped deleting their event.
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { planDeliveredEvents, applyDeliveredEvents } = require('../scripts/restore-delivered-events');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

let n = 0;
const add = (status, slot, eventId = null) => ctx.db.prepare(`INSERT INTO contracts
  (contract_number, status, scheduled_datetime, calendar_event_id, data)
  VALUES (?, ?, ?, ?, '{"customer":{"name":"Pat Doe","zip":"85001"}}')`)
  .run(`DHT-RDE-${++n}`, status, slot, eventId).lastInsertRowid;
const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);

test('creates grey events for delivered slots, keeps live ones, skips the rest; safe to re-run', async () => {
  ctx.db.exec("DELETE FROM contracts");
  const gone = add('delivered', '2026-03-10T09:00:00');
  const stale = add('delivered', '2026-05-02T13:00:00', 'evt-deleted');
  const live = add('delivered', '2026-06-01T10:00:00', 'evt-live');
  const early = add('delivered', '2025-12-20T09:00:00');
  const noSlot = add('delivered', '');
  add('scheduled', '2026-12-01T09:00:00');

  const all = planDeliveredEvents(ctx.db, '');
  expect(all.withSlot.map(c => c.id)).toEqual([early, gone, stale, live]);
  expect(all.noSlot.map(c => c.id)).toEqual([noSlot]);
  const { withSlot } = planDeliveredEvents(ctx.db, '2026-01-01');
  expect(withSlot.map(c => c.id)).toEqual([gone, stale, live]);

  let k = 0;
  const cal = {
    calendarEventExists: jest.fn(async id => id === 'evt-live' || id.startsWith('new-')),
    createCalendarEvent: jest.fn(async () => `new-${++k}`),
    markEventDelivered: jest.fn(async () => {}),
  };
  const r = await applyDeliveredEvents(ctx.db, withSlot, cal, { pause: 0 });
  expect(r).toEqual({ created: [row(gone).contract_number, row(stale).contract_number], skipped: [row(live).contract_number], failed: [] });
  expect(row(gone).calendar_event_id).toBe('new-1');
  expect(row(stale).calendar_event_id).toBe('new-2');
  expect(row(live).calendar_event_id).toBe('evt-live');
  expect(row(early).calendar_event_id).toBeNull();
  expect(cal.markEventDelivered.mock.calls.map(c => c[0]).sort()).toEqual(['evt-live', 'new-1', 'new-2']);
  expect(cal.createCalendarEvent.mock.calls[0][1]).toMatchObject({ customer: { name: 'Pat Doe' } });

  const again = await applyDeliveredEvents(ctx.db, planDeliveredEvents(ctx.db, '2026-01-01').withSlot, cal, { pause: 0 });
  expect(again.created).toEqual([]);
  expect(cal.createCalendarEvent).toHaveBeenCalledTimes(2);
});

test('a failure is reported and the others still go through', async () => {
  ctx.db.exec("DELETE FROM contracts");
  const a = add('delivered', '2026-07-01T09:00:00');
  const b = add('delivered', '2026-07-02T09:00:00');
  const cal = {
    calendarEventExists: jest.fn(async () => false),
    createCalendarEvent: jest.fn(async c => { if (c.id === a) throw new Error('quota'); return 'new-b'; }),
    markEventDelivered: jest.fn(async () => {}),
  };
  const r = await applyDeliveredEvents(ctx.db, planDeliveredEvents(ctx.db, '').withSlot, cal, { pause: 0 });
  expect(r.failed).toEqual([`${row(a).contract_number}: quota`]);
  expect(r.created).toEqual([row(b).contract_number]);
  expect(row(a).calendar_event_id).toBeNull();
});
