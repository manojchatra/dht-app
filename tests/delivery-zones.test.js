'use strict';
// Calendar colour by delivery zip (East blue, Central orange, West yellow,
// anything else Out of Town green) — Google events and the portal calendar.
const { zoneKeyForZip, ZONES } = require('../utils/deliveryZones');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

test.each([
  ['85234', 'east'], ['85143', 'east'], ['85048', 'east'], ['85331', 'east'],
  ['85004', 'central'], ['85051', 'central'], ['85339', 'central'], ['85305', 'central'],
  ['85374', 'west'], ['85353', 'west'], ['85382', 'west'], ['85338', 'west'],
  ['85001', 'out'], ['86001', 'out'], ['', 'out'], [undefined, 'out'], ['85234-1234', 'east'], [' 85234 ', 'east'],
])('zip %j → %s', (zip, zone) => expect(zoneKeyForZip(zip)).toBe(zone));

test('Google colours: Peacock, Tangerine, Banana, Basil', () => {
  expect([ZONES.east, ZONES.central, ZONES.west, ZONES.out].map(z => z.googleColorId)).toEqual(['7', '6', '5', '10']);
});

describe('events and calendar data', () => {
  let ctx, admin;
  beforeAll(async () => {
    ctx = createTestApp();
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  });
  afterAll(() => { destroyTestApp(ctx); });

  test('the Google event: no team in the title; zone in the description, team below the salesman', () => {
    const { _buildSummary, _buildDescription } = jest.requireActual('../services/googleCalendar');
    const c = { contract_number: 'X1', make: 'HotSpring', model: 'Envoy', serial_number: 'SN1', delivery_team: 'team_a', salesman: 'Destiny' };
    const data = { customer: { name: 'Jane', zip: '85234' } };
    expect(_buildSummary(c, data)).toBe('Jane · HotSpring Envoy · S/N: SN1'); // no team in the title
    const text = _buildDescription(c, data);
    expect(text).toMatch(/Zone:\s+East Valley/);
    expect(text).toMatch(/Salesman: Destiny\nTeam:\s+Classic Spa Team/); // team right below the salesman
  });

  test('the portal calendar data carries the zone colour', async () => {
    const base = contractFormData();
    const { contractId } = await createContract(admin, { customer: { ...base.customer, zip: '85374' } });
    ctx.db.prepare("UPDATE contracts SET status='scheduled', scheduled_datetime='2026-12-05T08:00', delivery_team='team_b' WHERE id=?").run(contractId);
    const listed = (await admin.get('/api/contracts')).body.find(c => c.id === contractId);
    expect(listed).toMatchObject({ zone_name: 'West Valley', zone_color: '#F6BF26' });
    const cal = (await admin.get('/api/delivery/calendar')).body.find(c => c.id === contractId);
    expect(cal).toMatchObject({ zone_name: 'West Valley', zone_color: '#F6BF26', zone_text_color: '#1f1f1f' });
  });
});
