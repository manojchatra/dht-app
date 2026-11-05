'use strict';
// Nov 2026: the Acknowledgement page's Scheduled and Completed tabs share a
// search + date filter (the date follows the tab) with Clear filters, for
// every role that opens the page (delivery users get only their team's list);
// Reschedule is a button on the admin's Scheduled status card, not in ⋮.
const fs   = require('fs');
const path = require('path');

const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

describe('Acknowledgement page filters', () => {
  const src = page('acknowledgement-hub.html');
  const code = src.slice(src.indexOf('const ACK_TABS'), src.indexOf('// Empty-tab message'));
  let allContracts = [];
  // The page's own functions, run here (its contract list swapped for this test's).
  const { ACK_TABS, ackMatches, ackRows } = new Function('getAll',
    code.replace(/allContracts\.filter/g, 'getAll().filter') + 'return { ACK_TABS, ackMatches, ackRows };')(() => allContracts);

  const sched = { status: 'scheduled', customer_name: 'Jane Pool', contract_number: 'DHT2611PH00001', serial_number: 'SN-1',
    address: '1 Desert Rd, Mesa', store: 'Phoenix', scheduled_datetime: '2026-11-20T09:00:00', delivery_date: '2026-11-01' };
  const done = { status: 'delivered', customer_name: 'Bob Spa', contract_number: 'DHT2610CH00002', serial_number: 'SN-2',
    address: '2 Cactus Ln', store: 'Chandler', delivery_date: '2026-10-15', acknowledgement_pdf_url: '/uploads/a.pdf' };
  const none = { q: '', from: '', to: '' };

  test('the date follows the tab: slot date on Scheduled, delivered date on Completed', () => {
    expect(ACK_TABS.scheduled.dateLabel).toBe('Delivery date');
    expect(ACK_TABS.scheduled.date(sched)).toBe('2026-11-20');
    expect(ACK_TABS.completed.dateLabel).toBe('Delivered date');
    expect(ACK_TABS.completed.date(done)).toBe('2026-10-15');
    expect(ackMatches(sched, 'scheduled', { ...none, from: '2026-11-20', to: '2026-11-20' })).toBe(true);
    expect(ackMatches(sched, 'scheduled', { ...none, from: '2026-11-21' })).toBe(false); // its delivery_date isn't used here
    expect(ackMatches(done, 'completed', { ...none, to: '2026-10-14' })).toBe(false);
  });

  test('search covers name, contract #, serial, address and store', () => {
    for (const q of ['jane', 'dht2611ph', 'sn-1', 'mesa', 'phoenix']) expect(ackMatches(sched, 'scheduled', { ...none, q })).toBe(true);
    expect(ackMatches(sched, 'scheduled', { ...none, q: 'bob' })).toBe(false);
  });

  test('each tab lists only its own contracts; Completed needs the acknowledgement PDF', () => {
    allContracts = [sched, done, { ...done, acknowledgement_pdf_url: null }];
    expect(ackRows('scheduled', none)).toEqual([sched]);
    expect(ackRows('completed', none)).toEqual([done]);
    expect(ackRows('completed', { ...none, q: 'cactus' })).toEqual([done]);
  });

  test('one bar for both tabs, with Clear filters; the delivery feed is kept', () => {
    expect(src).toMatch(/<input type="text" id="searchName"[^>]*oninput="renderAll\(\)"/);
    expect(src).toMatch(/id="fromDate"[^>]*renderAll\(\)/);
    expect(src).toMatch(/id="toDate"[^>]*renderAll\(\)/);
    expect(src.indexOf('id="searchName"')).toBeLessThan(src.indexOf('id="tab-scheduled"')); // above both tabs
    expect(src).toMatch(/\['searchName','fromDate','fromDateText','toDate','toDateText'\]/);
    expect(src).toMatch(/fetch\(isDelivery \? '\/api\/delivery\/acknowledgements' : '\/api\/contracts'\)/);
  });
});

describe('Scheduled status card', () => {
  test('Reschedule is a button on the admin card, no longer in the ⋮ menu', () => {
    const src = page('status.html');
    // Dropdown first (its own row), then Reschedule pushed left of Apply / ⋮.
    expect(src).toMatch(/\+ \(isScheduled \? '<button class="btn btn-secondary btn-sm resched-btn" onclick="openReschedule\('\+c\.id\+'\)"><i class="fa-solid fa-calendar"><\/i> Reschedule<\/button>' : ''\)/);
    expect(src).toMatch(/\.status-card-actions \.resched-btn\{margin-right:auto\}/);
    expect(src).not.toMatch(/menuItems\.push\('<button onclick="openReschedule/);
  });
});
