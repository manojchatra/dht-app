'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const svc = () => require('../services/calendarResync');
const eventId = id => ctx.db.prepare('SELECT calendar_event_id FROM contracts WHERE id=?').get(id).calendar_event_id;
let n = 0;

async function scheduled(agent, datetime, oldEventId) {
  const { contractId } = await createContract(agent, { product: { status: 'instock', serialNumber: `ZZCAL-${++n}`, make: 'M', model: 'X' } });
  ctx.db.prepare("UPDATE contracts SET status='scheduled', scheduled_datetime=?, scheduled_duration=120, delivery_team='team_a', calendar_event_id=? WHERE id=?")
    .run(datetime, oldEventId, contractId);
  return contractId;
}

describe('resync scheduled deliveries onto a new calendar', () => {
  let futureId, pastId, notScheduledId;

  beforeAll(async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    futureId = await scheduled(agent, '2099-01-15T09:00', 'old-event-1');
    pastId = await scheduled(agent, '2020-01-15T13:00', 'old-event-2');
    notScheduledId = (await createContract(agent, { product: { status: 'instock', serialNumber: `ZZCAL-${++n}`, make: 'M', model: 'X' } })).contractId;
  });

  test('the report lists only scheduled deliveries, flags past slots, and changes nothing', () => {
    const plan = svc().planCalendarResync(ctx.db);
    const ids = plan.map(p => p.contract.id);
    expect(ids).toEqual(expect.arrayContaining([futureId, pastId]));
    expect(ids).not.toContain(notScheduledId);
    expect(plan.find(p => p.contract.id === pastId).past).toBe(true);
    expect(plan.find(p => p.contract.id === futureId).past).toBe(false);
    expect(eventId(futureId)).toBe('old-event-1');
  });

  test('apply creates an event per delivery and saves the new event id', async () => {
    let k = 0;
    const cal = {
      calendarEventExists: jest.fn().mockResolvedValue(false),          // old ids aren't on the new calendar
      createCalendarEvent: jest.fn().mockImplementation(async () => `new-event-${++k}`),
    };
    const plan = svc().planCalendarResync(ctx.db).filter(p => [futureId, pastId].includes(p.contract.id));

    const result = await svc().applyCalendarResync(ctx.db, plan, cal);

    expect(result.created).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(cal.createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ id: futureId, delivery_team: 'team_a' }), expect.any(Object));
    expect(eventId(futureId)).toMatch(/^new-event-/);
    expect(eventId(pastId)).toMatch(/^new-event-/);
  });

  test('re-running skips deliveries already on the new calendar (no duplicates)', async () => {
    const cal = { calendarEventExists: jest.fn().mockResolvedValue(true), createCalendarEvent: jest.fn() };
    const plan = svc().planCalendarResync(ctx.db).filter(p => [futureId, pastId].includes(p.contract.id));

    const result = await svc().applyCalendarResync(ctx.db, plan, cal);

    expect(result.skipped).toHaveLength(2);
    expect(cal.createCalendarEvent).not.toHaveBeenCalled();
  });

  test('a failure on one delivery is reported and does not stop the others', async () => {
    ctx.db.prepare('UPDATE contracts SET calendar_event_id=NULL WHERE id IN (?,?)').run(futureId, pastId);
    const cal = {
      calendarEventExists: jest.fn().mockResolvedValue(false),
      createCalendarEvent: jest.fn().mockRejectedValueOnce(new Error('403 Forbidden')).mockResolvedValue('new-event-x'),
    };
    const plan = svc().planCalendarResync(ctx.db).filter(p => [futureId, pastId].includes(p.contract.id));

    const result = await svc().applyCalendarResync(ctx.db, plan, cal);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatch(/403 Forbidden/);
    expect(result.created).toHaveLength(1);
  });

  test('refresh rewrites every live event from its contract and recreates missing ones', async () => {
    ctx.db.prepare("UPDATE contracts SET calendar_event_id='live-1', serial_number='CHANGED-SN' WHERE id=?").run(futureId);
    ctx.db.prepare("UPDATE contracts SET calendar_event_id='gone-2' WHERE id=?").run(pastId);
    const cal = {
      calendarEventExists: jest.fn(async id => id === 'live-1'),
      updateCalendarEvent: jest.fn().mockResolvedValue(),
      createCalendarEvent: jest.fn().mockResolvedValue('new-event-r'),
    };
    const plan = svc().planCalendarResync(ctx.db).filter(p => [futureId, pastId].includes(p.contract.id));

    const result = await svc().applyCalendarRefresh(ctx.db, plan, cal);

    expect(result).toMatchObject({ failed: [] });
    expect(result.updated).toHaveLength(1);
    expect(result.created).toHaveLength(1);
    expect(cal.updateCalendarEvent).toHaveBeenCalledWith('live-1', expect.objectContaining({ id: futureId, serial_number: 'CHANGED-SN' }), expect.any(Object));
    expect(eventId(pastId)).toBe('new-event-r');
  });
});
