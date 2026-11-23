'use strict';
// Nov 2026 calendar: salespeople see everyone's bookings (others' as "Booked",
// first name only), book from the calendar's + (Assigned / Received contracts),
// and admin blocks off time — nobody books inside a block, and a block can't be
// saved over deliveries already booked. Blocks go to Google Calendar.
const fs = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, sales, sales2, crew, cal;
beforeAll(async () => {
  ctx = createTestApp();
  cal = require('../services/googleCalendar');
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
  await admin.post('/api/sales').send({ username: 'cal-s2', password: 'Secret123', name: 'Bob Stone', email: 'cal-s2@example.com' });
  await admin.post('/api/users').send({ username: 'cal-crew', password: 'Secret123', role: 'delivery', team: 'team_b', name: 'Crew B', email: 'cal-crew@example.com' });
  sales2 = await loginAgent(ctx.app, { username: 'cal-s2', password: 'Secret123' });
  crew = await loginAgent(ctx.app, { username: 'cal-crew', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const book = (agent, id, dt, team, dur = 120) => agent.patch(`/api/contracts/${id}/status`)
  .send({ status: 'scheduled', scheduledDatetime: dt, scheduledDuration: dur, deliveryTeam: team });
const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);

describe('shared bookings', () => {
  let mine, theirs, theirsDelivered;
  beforeAll(async () => {
    mine = (await createContract(sales, { customer: { name: 'Mia Own', email: 'mia@example.com', zip: '85201', phone: { cell: '602-555-0101' }, address: '1 A St', city: 'Mesa', state: 'AZ' } })).contractId;
    theirs = (await createContract(sales2, { customer: { name: 'Tom Other', email: 'tom@example.com', zip: '85374', phone: { cell: '602-555-0102' }, address: '2 B St', city: 'Surprise', state: 'AZ' } })).contractId;
    theirsDelivered = (await createContract(sales2)).contractId;
    expect((await book(sales, mine, '2027-02-01T08:00', 'team_a')).status).toBe(200);
    expect((await book(sales2, theirs, '2027-02-01T08:00', 'team_b')).status).toBe(200);
    ctx.db.prepare("UPDATE contracts SET status='delivered', scheduled_datetime='2027-01-05T09:00', delivery_team='team_a' WHERE id=?").run(theirsDelivered);
  });

  test('a salesperson sees their own in full and others\' scheduled ones as Booked, first name only', async () => {
    const list = (await sales.get('/api/calendar/bookings')).body;
    const own = list.find(b => b.id === mine);
    expect(own).toMatchObject({ mine: true, contract_number: row(mine).contract_number, customer_name: 'Mia Own', zone_name: 'East Valley' });
    const other = list.filter(b => b.mine === false);
    expect(other).toHaveLength(1);
    expect(other[0]).toEqual({ id: null, mine: false, status: 'scheduled', scheduled_datetime: '2027-02-01T08:00',
      scheduled_duration: 120, delivery_team: 'team_b', salesman_first: String(row(theirs).salesman).split(' ')[0],
      zone_name: 'West Valley', zone_color: expect.any(String), zone_text_color: expect.any(String) });
    expect(JSON.stringify(other)).not.toMatch(/Tom Other|Surprise|DHT/);
  });

  test('admin sees every booking in full; crews keep their own endpoint', async () => {
    const list = (await admin.get('/api/calendar/bookings')).body;
    expect(list.map(b => b.id)).toEqual(expect.arrayContaining([mine, theirs, theirsDelivered]));
    expect(list.every(b => b.mine === true && b.contract_number)).toBe(true);
    expect((await crew.get('/api/calendar/bookings')).status).toBe(403);
  });

  test('a salesperson told a team is busy isn\'t told whose delivery it is; admin is', async () => {
    const extra = (await createContract(sales)).contractId;
    const r = await book(sales, extra, '2027-02-01T09:00', 'team_b');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Installation Team is already booked at this time\. Choose/);
    expect(r.body.error).not.toMatch(/DHT/);
    const a = await book(admin, extra, '2027-02-01T09:00', 'team_b');
    expect(a.body.error).toContain(row(theirs).contract_number);
  });
});

describe('contracts the + box can book', () => {
  test('Assigned / Received only; a salesperson gets their own; the reason one can\'t be booked yet', async () => {
    const ok = (await createContract(sales)).contractId;
    const owing = (await createContract(sales, { payment: { cheque: { selected: true, number: '7', amount: '1000' } } })).contractId;
    const other = (await createContract(sales2)).contractId;
    const scheduled = (await createContract(sales)).contractId;
    await book(sales, scheduled, '2027-02-20T08:00', 'team_a');

    const list = (await sales.get('/api/calendar/schedulable')).body;
    const ids = list.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining([ok, owing]));
    expect(ids).not.toContain(other);
    expect(ids).not.toContain(scheduled);
    expect(list.find(c => c.id === ok)).toMatchObject({ status: 'assigned', why: '', zip: '85001', contract_number: row(ok).contract_number });
    expect(list.find(c => c.id === owing).why).toBe('Balance $4,000.00 owing');

    ctx.db.prepare("UPDATE contracts SET serial_number='' WHERE id=?").run(ok);
    expect((await sales.get('/api/calendar/schedulable')).body.find(c => c.id === ok).why).toBe('No serial');

    expect((await admin.get('/api/calendar/schedulable')).body.map(c => c.id)).toContain(other);
    expect((await crew.get('/api/calendar/schedulable')).status).toBe(403);
  });
});

describe('blocked time', () => {
  beforeEach(() => { cal.createBlockEvent.mockClear(); cal.deleteCalendarEvent.mockClear(); });

  test('admin blocks time for one team: saved, on Google Calendar, nobody books that team inside it', async () => {
    cal.createBlockEvent.mockResolvedValueOnce('gblock-1');
    const r = await admin.post('/api/calendar/blocks').send({ date: '2027-03-10', from: '13:00', to: '16:00', team: 'team_b', note: "Dave's off" });
    expect(r.status).toBe(200);
    const saved = ctx.db.prepare('SELECT * FROM calendar_blocks WHERE id=?').get(r.body.id);
    expect(saved).toMatchObject({ start_datetime: '2027-03-10T13:00:00', end_datetime: '2027-03-10T16:00:00', all_day: 0, team: 'team_b', note: "Dave's off", created_by: 'admin', google_event_id: 'gblock-1' });
    expect(cal.createBlockEvent).toHaveBeenCalledWith(expect.objectContaining({ start_datetime: '2027-03-10T13:00:00', team: 'team_b', note: "Dave's off" }));

    const listed = (await sales.get('/api/calendar/blocks')).body.find(b => b.id === r.body.id);
    expect(listed).toMatchObject({ team_name: 'Installation Team', all_day: false, note: "Dave's off" });

    const c = (await createContract(sales)).contractId;
    const refused = await book(sales, c, '2027-03-10T15:00', 'team_b', 60);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/That time is blocked on the calendar \(Dave's off — Wed, Mar 10, 1 PM – 4 PM, Installation Team\)/);
    expect((await book(admin, c, '2027-03-10T12:00', 'team_b')).status).toBe(400); // 12–2 runs into it — admin too
    expect((await book(sales, c, '2027-03-10T14:00', 'team_a')).status).toBe(200);  // the other team is free
  });

  test('an all-day block for both teams stops every booking that day', async () => {
    const r = await admin.post('/api/calendar/blocks').send({ date: '2027-03-11', allDay: true, team: '', note: 'Holiday' });
    expect(r.status).toBe(200);
    expect(ctx.db.prepare('SELECT start_datetime, end_datetime, team FROM calendar_blocks WHERE id=?').get(r.body.id))
      .toEqual({ start_datetime: '2027-03-11T00:00:00', end_datetime: '2027-03-12T00:00:00', team: null });
    const c = (await createContract(sales)).contractId;
    for (const [dt, team] of [['2027-03-11T06:00', 'team_a'], ['2027-03-11T17:00', 'team_b']]) {
      const x = await book(admin, c, dt, team);
      expect(x.status).toBe(400);
      expect(x.body.error).toMatch(/Holiday — Thu, Mar 11, all day, both teams/);
    }
    expect((await book(sales, c, '2027-03-12T08:00', 'team_a')).status).toBe(200);
  });

  test('can\'t block over deliveries already booked — they\'re listed to reschedule first', async () => {
    const c = (await createContract(sales)).contractId;
    await book(sales, c, '2027-03-15T09:00', 'team_a');
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM calendar_blocks').get().n;
    const r = await admin.post('/api/calendar/blocks').send({ date: '2027-03-15', from: '08:00', to: '12:00', team: '' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Reschedule them first/);
    expect(r.body.conflicts).toEqual([expect.objectContaining({ id: c, contract_number: row(c).contract_number, team: 'Classic Spa Team', slot: '9 AM – 11 AM' })]);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM calendar_blocks').get().n).toBe(before);
    expect(cal.createBlockEvent).not.toHaveBeenCalled();
    // The other team's time is free to block
    expect((await admin.post('/api/calendar/blocks').send({ date: '2027-03-15', from: '08:00', to: '12:00', team: 'team_b' })).status).toBe(200);
  });

  test('checks: admin only, a date not in the past, To after From, a known team', async () => {
    expect((await sales.post('/api/calendar/blocks').send({ date: '2027-04-01', allDay: true })).status).toBe(403);
    expect((await admin.post('/api/calendar/blocks').send({ date: '2020-01-01', allDay: true })).body.error).toBe('That date has passed.');
    expect((await admin.post('/api/calendar/blocks').send({ date: '2027-04-01', from: '12:00', to: '12:00' })).body.error).toMatch(/later than/);
    expect((await admin.post('/api/calendar/blocks').send({ date: '2027-04-01', from: '9', to: '10:00' })).status).toBe(400);
    expect((await admin.post('/api/calendar/blocks').send({ date: '2027-04-01', allDay: true, team: 'team_z' })).body.error).toBe('Unknown team.');
  });

  test('crews see their team\'s and both-team blocks; admin removes a block and its Google event', async () => {
    const a = (await admin.post('/api/calendar/blocks').send({ date: '2027-05-03', allDay: true, team: 'team_a', note: 'A only' })).body.id;
    cal.createBlockEvent.mockResolvedValueOnce('gblock-del');
    const b = (await admin.post('/api/calendar/blocks').send({ date: '2027-05-04', allDay: true, team: '', note: 'Both' })).body.id;
    const seen = (await crew.get('/api/calendar/blocks')).body.map(x => x.id);
    expect(seen).toContain(b);
    expect(seen).not.toContain(a);

    expect((await sales.delete(`/api/calendar/blocks/${b}`)).status).toBe(403);
    const d = await admin.delete(`/api/calendar/blocks/${b}`);
    expect(d.status).toBe(200);
    expect(cal.deleteCalendarEvent).toHaveBeenCalledWith('gblock-del');
    expect(ctx.db.prepare('SELECT id FROM calendar_blocks WHERE id=?').get(b)).toBeUndefined();
    expect((await admin.delete(`/api/calendar/blocks/${b}`)).status).toBe(404);
  });

  test('the Google event: "BLOCKED – note", red, team in the description; all-day as an all-day event', () => {
    const { _blockEventBody } = jest.requireActual('../services/googleCalendar');
    expect(_blockEventBody({ start_datetime: '2027-03-10T13:00:00', end_datetime: '2027-03-10T16:00:00', all_day: 0, team: 'team_b', note: "Dave's off", created_by: 'admin' }))
      .toEqual({ summary: "BLOCKED – Dave's off", colorId: '11',
        description: 'Team: Installation Team\nNo deliveries can be booked in this time.\nBlocked in GOBI by admin',
        start: { dateTime: '2027-03-10T13:00:00', timeZone: 'America/Phoenix' }, end: { dateTime: '2027-03-10T16:00:00', timeZone: 'America/Phoenix' } });
    const allDay = _blockEventBody({ start_datetime: '2027-03-11T00:00:00', end_datetime: '2027-03-12T00:00:00', all_day: 1, team: null, note: '' });
    expect(allDay).toMatchObject({ summary: 'BLOCKED', start: { date: '2027-03-11' }, end: { date: '2027-03-12' } });
    expect(allDay.description).toMatch(/^Team: Both teams/);
  });
});

describe('the calendar page', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/calendar.html'), 'utf8');
  test('loads the shared bookings and blocks; month view as coloured bars; team tick boxes, Classic Spa by default', () => {
    expect(src).toMatch(/'\/api\/calendar\/bookings'/);
    expect(src).toMatch(/fetch\('\/api\/calendar\/blocks'\)/);
    expect(src).toMatch(/eventDisplay: 'block'/);
    expect(src).toMatch(/id="showTeamA" checked> Classic Spa Team/);
    expect(src).toMatch(/id="showTeamB"> Installation Team/);
    expect(src).toMatch(/const show = \{ team_a: true, team_b: false \}/);
    expect(src).toMatch(/#calendar\.halves \.fc-timegrid-event-harness:has\(> \.lane-b\)/);
  });
  test('delivery crews open on Day view; the hover + finds the day by position (hour rows sit on top of the columns)', () => {
    expect(src).toMatch(/initialView: role\(\) === 'delivery' \? 'timeGridDay' : 'dayGridMonth'/);
    // phones / tablets (no hover) get a "+ Add" button for sales + admin
    expect(src).toMatch(/left: 'prev,next today' \+ \(canAdd\(\) && matchMedia\('\(hover:none\)'\)\.matches \? ' addBtn' : ''\)/);
    expect(src).toMatch(/addBtn: \{ text: '\+ Add'/);
    // the current-time line, in Arizona time (no time-zone plugin: "now" is given as Arizona clock time)
    expect(src).toMatch(/now: {10}\(\) => new Date\(Date\.now\(\) - 7 \* 3600000\),\s*nowIndicator: true,/);
    expect(src).toMatch(/querySelectorAll\('#calendar \.fc-timegrid-col\[data-date\]'\)\]\s*\.find\(td => \{ const r = td\.getBoundingClientRect\(\); return e\.clientX >= r\.left/);
  });
  test('the + box books through the Status page\'s own route; Block time is admin only', () => {
    expect(src).toMatch(/fetch\('\/api\/contracts\/' \+ am\.picked \+ '\/status'/);
    expect(src).toMatch(/fetch\('\/api\/calendar\/schedulable'\)/);
    expect(src).toMatch(/getElementById\('amTabs'\)\.style\.display = role\(\) === 'admin'/);
  });
});
