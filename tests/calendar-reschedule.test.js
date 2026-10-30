'use strict';
// DHT2609CH00054: its calendar event was deleted in Google; rescheduling kept
// "updating" the deleted event, so the delivery never showed. Now a missing or
// deleted event is replaced. Also: setting the status a contract already has
// is refused (Apply clicked several times logged "assigned → assigned").
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, cal;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  cal = require('../services/googleCalendar');
});
afterAll(() => { destroyTestApp(ctx); });

let slot = 0;
const reschedule = id => admin.patch(`/api/contracts/${id}/status`)
  .send({ status: 'scheduled', scheduledDatetime: `2026-12-1${++slot}T12:00`, scheduledDuration: 120, deliveryTeam: 'team_b' });
const scheduled = async eventId => {
  const { contractId } = await createContract(admin);
  ctx.db.prepare("UPDATE contracts SET status='scheduled', scheduled_datetime='2026-12-01T08:00', delivery_team='team_a', calendar_event_id=? WHERE id=?").run(eventId, contractId);
  return contractId;
};

beforeEach(() => { for (const f of ['createCalendarEvent', 'updateCalendarEvent', 'calendarEventExists']) cal[f].mockClear(); });

test('a deleted event is replaced by a new one, and its id saved', async () => {
  const id = await scheduled('deleted-evt');
  cal.calendarEventExists.mockResolvedValueOnce(false);
  cal.createCalendarEvent.mockResolvedValueOnce('new-evt');
  expect((await reschedule(id)).status).toBe(200);
  expect(cal.calendarEventExists).toHaveBeenCalledWith('deleted-evt');
  expect(cal.updateCalendarEvent).not.toHaveBeenCalled();
  expect(ctx.db.prepare('SELECT calendar_event_id FROM contracts WHERE id=?').get(id).calendar_event_id).toBe('new-evt');
});

test('a live event is updated in place', async () => {
  const id = await scheduled('live-evt');
  cal.calendarEventExists.mockResolvedValueOnce(true);
  expect((await reschedule(id)).status).toBe(200);
  expect(cal.updateCalendarEvent).toHaveBeenCalledWith('live-evt', expect.objectContaining({ id }), expect.anything());
  expect(cal.createCalendarEvent).not.toHaveBeenCalled();
});

test('setting the status a contract already has is refused and not logged', async () => {
  const { contractId } = await createContract(admin); // Assigned
  const before = ctx.db.prepare('SELECT COUNT(*) n FROM activity_log WHERE contract_id=?').get(contractId).n;
  const res = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'assigned' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Contract is already Assigned.');
  expect(ctx.db.prepare('SELECT COUNT(*) n FROM activity_log WHERE contract_id=?').get(contractId).n).toBe(before);
});

test('a typed "Other steps" is saved as the steps model', async () => {
  const { contractId } = await createContract(admin, { details: { spaPrice: '5000', steps: { type: 'Cedar 2-step', price: '', included: true } } });
  const d = JSON.parse(ctx.db.prepare('SELECT data FROM contracts WHERE id=?').get(contractId).data);
  expect(d.details.steps.type).toBe('Cedar 2-step');
  const ack = (await admin.get(`/api/delivery/contract/${contractId}`)).body;
  expect(ack.steps_type).toBe('Cedar 2-step');
});

test('typed "Other steps" and "Other lift" reach the calendar event and the delivery view', async () => {
  const { _buildDescription } = jest.requireActual('../services/googleCalendar');
  const data = { customer: { name: 'A' }, details: { steps: { type: 'Cedar 2-step' },
    cover: { coverType: ['F/B'], brand: 'Caldera', lift: 'CCI', otherLift: 'Side lift' } } };
  const text = _buildDescription({ contract_number: 'X1', make: 'Caldera', model: 'Geneva' }, data);
  expect(text).toMatch(/Steps:\s+Cedar 2-step/);
  expect(text).toMatch(/Cover:\s+F\/B - Caldera - CCI - Side lift/);

  const { contractId } = await createContract(admin, { details: { spaPrice: '5000', steps: { type: 'Cedar 2-step' },
    cover: { coverType: ['F/B'], brand: 'Caldera', lift: 'CCI', otherLift: 'Side lift' } } });
  expect((await admin.get(`/api/delivery/contract/${contractId}`)).body.cover_type).toBe('F/B - Caldera - CCI - Side lift');
});

test('changing the serial on a Scheduled contract updates its calendar event to the new serial', async () => {
  const id = await scheduled('evt-serial');
  cal.calendarEventExists.mockResolvedValueOnce(true);
  const res = await admin.patch(`/api/contracts/${id}/serial`).send({ serialNumber: 'NEW-SN-777' }); // not in inventory
  expect(res.status).toBe(200);
  expect(cal.updateCalendarEvent).toHaveBeenCalledWith('evt-serial', expect.objectContaining({ id, serial_number: 'NEW-SN-777' }), expect.anything());

  // Not scheduled → no calendar event to touch.
  const { contractId } = await createContract(admin);
  cal.updateCalendarEvent.mockClear(); cal.createCalendarEvent.mockClear();
  await admin.patch(`/api/contracts/${contractId}/serial`).send({ serialNumber: 'NEW-SN-778' });
  expect(cal.updateCalendarEvent).not.toHaveBeenCalled();
  expect(cal.createCalendarEvent).not.toHaveBeenCalled();
});
