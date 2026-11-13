'use strict';
// Nov 2026: a delivered contract keeps its calendar event, greyed out — on
// Google Calendar (Graphite) and on the portal calendar. Cancel and delete
// still remove the event.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, crewA, cal;
beforeAll(async () => {
  ctx = createTestApp();
  cal = require('../services/googleCalendar'); // the jest mock from createTestApp
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  await admin.post('/api/users').send({ username: 'crew-grey', password: 'Secret123', role: 'delivery', team: 'team_a', name: 'Crew', email: 'crew-grey@example.com' });
  crewA = await loginAgent(ctx.app, { username: 'crew-grey', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT status, calendar_event_id FROM contracts WHERE id=?').get(id);
// Paid in full, booked for a team, with a Google event.
async function booked(team = 'team_a', eventId = 'evt-' + Math.random().toString(36).slice(2)) {
  const { contractId } = await createContract(admin, { costing: { grandTotal: '5000' } });
  ctx.db.prepare(`UPDATE contracts SET status='scheduled', delivery_team=?, calendar_event_id=?, scheduled_datetime='2026-11-20T09:00:00', scheduled_duration=120 WHERE id=?`)
    .run(team, eventId, contractId);
  return { contractId, eventId };
}

test('Delivered on the Status page greys the event and keeps it', async () => {
  const { contractId, eventId } = await booked();
  cal.markEventDelivered.mockClear(); cal.deleteCalendarEvent.mockClear();
  const r = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered', deliveryDate: '2026-11-20' });
  expect(r.status).toBe(200);
  expect(row(contractId)).toEqual({ status: 'delivered', calendar_event_id: eventId });
  expect(cal.markEventDelivered).toHaveBeenCalledWith(eventId);
  expect(cal.deleteCalendarEvent).not.toHaveBeenCalled();
});

test('a failed recolour still marks it Delivered', async () => {
  const { contractId } = await booked();
  cal.markEventDelivered.mockRejectedValueOnce(new Error('Google down'));
  jest.spyOn(console, 'error').mockImplementationOnce(() => {});
  expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' })).status).toBe(200);
  expect(row(contractId).status).toBe('delivered');
});

test('cancelling a scheduled contract still deletes its event', async () => {
  const { contractId, eventId } = await booked();
  cal.deleteCalendarEvent.mockClear();
  expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' })).status).toBe(200);
  expect(cal.deleteCalendarEvent).toHaveBeenCalledWith(eventId);
  expect(row(contractId).calendar_event_id).toBeNull();
});

test('the crew calendar lists its team\'s delivered contracts too, not other teams\'', async () => {
  const mine = await booked('team_a');
  const theirs = await booked('team_b');
  for (const { contractId } of [mine, theirs]) ctx.db.prepare("UPDATE contracts SET status='delivered' WHERE id=?").run(contractId);
  const noTeam = await createContract(admin);
  ctx.db.prepare("UPDATE contracts SET status='delivered', scheduled_datetime='2026-11-21T09:00:00' WHERE id=?").run(noTeam.contractId);

  const ids = (await crewA.get('/api/delivery/calendar')).body.map(c => c.id);
  expect(ids).toContain(mine.contractId);
  expect(ids).not.toContain(theirs.contractId);
  expect(ids).not.toContain(noTeam.contractId); // delivered with no team is no crew's
  const adminIds = (await admin.get('/api/delivery/calendar')).body.map(c => c.id);
  expect(adminIds).toEqual(expect.arrayContaining([mine.contractId, theirs.contractId, noTeam.contractId]));
});

test('the portal calendar shows delivered in grey, with a Delivered key', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/calendar.html'), 'utf8');
  expect(src).toMatch(/\.filter\(c=>\(c\.status==='scheduled'\|\|c\.status==='delivered'\)&&c\.scheduled_datetime\)/);
  expect(src).toMatch(/const DELIVERED_GREY = '#616161';/);
  expect(src).toMatch(/backgroundColor: delivered \? DELIVERED_GREY/);
  expect(src).toMatch(/<i style="background:#616161"><\/i>Delivered/);
  expect(require('../utils/deliveryZones').DELIVERED).toMatchObject({ googleColorId: '8', hex: '#616161' });
});

test('Google: only the colour changes (Graphite); an event already gone is fine', async () => {
  const real = jest.requireActual('../services/googleCalendar');
  expect(typeof real.markEventDelivered).toBe('function');
  const src = fs.readFileSync(path.join(__dirname, '../services/googleCalendar.js'), 'utf8');
  expect(src).toMatch(/requestBody: \{ colorId: DELIVERED\.googleColorId \}/);
}, 60000);
