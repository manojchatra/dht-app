'use strict';
// Nov 2026: the Status page's date filter (the date follows the tab) with a
// Clear filters button, and 1-hour delivery slots (6 AM – 5 PM starts, 1–4
// hours, 2 by default) on Schedule / Reschedule and the portal calendar.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

describe('Status page date filter', () => {
  // The page's own functions, run here.
  const src = page('status.html');
  const code = src.slice(src.indexOf('function dateFieldFor'), src.indexOf('const matchesFilters'));
  const range = { from: '', to: '' };
  const { dateFieldFor, matchesDate } = new Function('document',
    code + 'return { dateFieldFor, matchesDate };')({ getElementById: id => ({ value: range[id.replace('Date', '')] }) });

  test('the date follows the tab', () => {
    const c = { date: '2026-10-01', scheduled_datetime: '2026-11-20T09:00:00', delivery_date: '2026-11-21' };
    expect(dateFieldFor('scheduled')).toMatchObject({ label: 'Delivery date' });
    expect(dateFieldFor('scheduled').of(c)).toBe('2026-11-20');
    expect(dateFieldFor('delivered')).toMatchObject({ label: 'Delivered date' });
    expect(dateFieldFor('delivered').of(c)).toBe('2026-11-21');
    for (const tab of ['assigned', 'tbo', 'order_placed', 'received', 'cancelled']) {
      expect(dateFieldFor(tab).label).toBe('Sale date');
      expect(dateFieldFor(tab).of(c)).toBe('2026-10-01');
    }
  });

  test('From and To are inclusive and each optional; each contract uses its own tab\'s date', () => {
    const sched = { status: 'scheduled', date: '2026-01-01', scheduled_datetime: '2026-11-20T16:00:00' };
    const sold  = { status: 'assigned', date: '2026-11-20' };
    expect(matchesDate(sched, { from: '', to: '' })).toBe(true);
    expect(matchesDate(sched, { from: '2026-11-20', to: '2026-11-20' })).toBe(true);
    expect(matchesDate(sched, { from: '2026-11-21', to: '' })).toBe(false);
    expect(matchesDate(sched, { from: '', to: '2026-11-19' })).toBe(false);
    expect(matchesDate(sold, { from: '2026-11-01', to: '2026-11-30' })).toBe(true);
    expect(matchesDate({ status: 'delivered' }, { from: '2026-11-01', to: '' })).toBe(false); // no date → not a match
  });

  test('Clear filters empties the search and both dates; it shows only while a filter is set', () => {
    const clear = src.slice(src.indexOf('function clearFilters'), src.indexOf('function updateTabCounts'));
    expect(clear).toMatch(/getElementById\('statusSearch'\)\.value='';/);
    expect(clear).toMatch(/\['fromDate','fromDateText','toDate','toDateText'\]/);
    expect(src).toMatch(/document\.getElementById\('clearFiltersBtn'\)\.style\.display=active\?'':'none';/);
    expect(src).toMatch(/const filtered=allContracts\.filter\(c=>c\.status===currentTab&&matchesFilters\(c,q,r\)\);/);
  });
});

describe('1-hour delivery slots', () => {
  test('Schedule and Reschedule offer every hour 6 AM – 5 PM, 1–4 hours, 2 by default; the calendar shows 1-hour rows', () => {
    const src = page('status.html');
    const fill = src.slice(src.indexOf('(function fillSlotOptions'), src.indexOf('// ── Reschedule modal'));
    const sel = cls => ({ innerHTML: '', cls });
    const els = { '.slot-starts': [sel(), sel()], '.slot-durations': [sel(), sel()] };
    new Function('document', fill)({ querySelectorAll: q => els[q] });
    const starts = els['.slot-starts'][0].innerHTML;
    expect([...starts.matchAll(/value="(\d\d:00)"/g)].map(m => m[1]))
      .toEqual(['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
    expect(starts).toMatch(/<option value="17:00">5:00 PM<\/option>/);
    expect(els['.slot-durations'][1].innerHTML).toBe('<option value="60">1 hour</option><option value="120" selected>2 hours</option>'
      + '<option value="180">3 hours</option><option value="240">4 hours</option>');
    expect(src).toMatch(/<select id="slotStart" class="slot-starts"/);
    expect(src).toMatch(/<select id="reschedDuration" class="slot-durations"/);
    expect(page('calendar.html')).toMatch(/slotDuration: '01:00:00'/);
  });

  describe('booking a team by the hour', () => {
    let ctx, admin;
    beforeAll(async () => {
      ctx = createTestApp();
      admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    });
    afterAll(() => { destroyTestApp(ctx); });
    const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const book = async (time, minutes) => {
      const { contractId } = await createContract(admin);
      return admin.patch(`/api/contracts/${contractId}/status`)
        .send({ status: 'scheduled', scheduledDatetime: `${day}T${time}:00`, scheduledDuration: String(minutes), deliveryTeam: 'team_a' });
    };

    test('back-to-back 1-hour bookings fit; an overlapping one is refused', async () => {
      expect((await book('08:00', 60)).status).toBe(200);
      expect((await book('09:00', 60)).status).toBe(200);
      const clash = await book('09:00', 120);
      expect(clash.status).toBe(400);
      expect(clash.body.error).toMatch(/Classic Spa Team is already booked at this time/);
      expect((await book('10:00', 120)).status).toBe(200); // 10–12, after the 9–10 booking
    });
  });
});
