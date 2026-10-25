'use strict';
// Colour names follow the SKU List (utils/colours.js); "Sold at" booth sales
// (utils/saleChannel.js); City and Zip required on New Contract.
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');
const { normalizeColour, buildColourLists, listsForMake, planColourFix } = require('../utils/colours');
const { cleanSaleChannel, saleChannelLabel } = require('../utils/saleChannel');

describe('normalizeColour', () => {
  test.each([
    ['HotSpring', 'shell', 'Tuscan Sun', 'Tuscan'],
    ['Caldera', 'shell', 'tuscan sun', 'Tuscan'],
    ['HotSpring', 'shell', 'Ice Grey', 'Ice Gray'],
    ['HotSpring', 'cabinet', 'Costal Gray', 'Coastal Gray'],
    ['HotSpring', 'cabinet', 'Nickel', 'Brushed Nickel'],
    ['HotSpring', 'cabinet', 'Diamond', 'Diamond Weave'],
    ['Caldera', 'shell', 'Taupe', 'Natural Taupe'],
    ['LifeSmart', 'shell', 'Taupe', 'Taupe'],          // a real LifeSmart colour
    ['LifeSmart', 'shell', 'Seasalt', 'Sea Salt'],
    ['WLA', 'cabinet', 'Charcoalcoal', 'Charcoal'],
    ['HotSpring', 'shell', 'Smoke', 'Smoke'],
    ['Caldera', 'shell', 'Alpine White', 'Arctic White'],
    ['LifeSmart', 'shell', 'alpine white', 'Arctic White'],
    ['WLA', 'shell', 'Arctic white', 'Alpine White'],
    ['HotSpring', 'shell', 'Alpine White', 'Alpine White'], // HotSpring's white stays Alpine White
    ['HotSpring', 'shell', 'Taupe', 'Taupe'],               // a real HotSpring Mini colour
    ['HotSpring', 'shell', '  Some  Custom ', 'Some Custom'],
    ['HotSpring', 'shell', '', ''],
  ])('%s %s %j → %j', (make, part, input, out) => expect(normalizeColour(make, part, input)).toBe(out));
});

describe('colour buttons per brand', () => {
  const sku = [
    { Make: 'HotSpring', 'Shell Color': 'Tuscan', 'Cabinet Color': 'Mosaic' },
    { Make: 'Hotspring', 'Shell Color': 'Smoke', 'Cabinet Color': 'Diamond Weave' },
    { Make: 'Caldera', 'Shell Color': 'Natural Taupe', 'Cabinet Color': 'Honeycomb' },
  ];

  test('come from the SKU List per brand, plus the extras', () => {
    const l = buildColourLists(sku);
    expect(l.brands.HotSpring.shell).toEqual(['Smoke', 'Taupe', 'Tuscan']);
    expect(l.brands.HotSpring.cabinet).toEqual(['Ash', 'Brown', 'Diamond Weave', 'Driftwood', 'Gray', 'Mocha', 'Mosaic']);
    expect(l.brands.Caldera.cabinet).toEqual(['Honeycomb', 'Mocha']);
    expect(l.brands.Caldera.shell).toEqual(['Natural Taupe']);
    expect(l.brands.WLA).toEqual({ shell: ['Alpine White'], cabinet: ['Brown', 'Charcoal'] });
    expect(l.brands.Tylo).toEqual({ shell: [], cabinet: [] });
    expect(l.all.shell).toEqual(expect.arrayContaining(['Tuscan', 'Natural Taupe', 'Sea Salt', 'Alpine White']));
    expect(listsForMake(l, 'hot spring').shell).toEqual(['Smoke', 'Taupe', 'Tuscan']);
    expect(listsForMake(l, 'Unknown Brand')).toBeNull();
  });

  test('fall back to the built-in snapshot when the SKU List is unavailable', () => {
    const l = buildColourLists([]);
    expect(l.brands.HotSpring.shell).toContain('Tuscan');
    expect(l.brands['Endless Pools'].cabinet).toEqual(['Brown', 'Espresso', 'Gray', 'Mocha']);
  });
});

describe('planColourFix (existing inventory)', () => {
  const lists = buildColourLists([]);
  test('spelling', () => {
    expect(planColourFix({ make: 'HotSpring', model: 'Envoy', shell_color: 'Ice Grey', cabinet_color: 'Nickel' }, lists))
      .toMatchObject({ shell: 'Ice Gray', cabinet: 'Brushed Nickel', changed: true, offList: [] });
  });
  test('shell and cabinet swapped (Beam 220)', () => {
    const p = planColourFix({ make: 'HotSpring', model: 'Beam220', shell_color: 'Costal Gray', cabinet_color: 'Ice Gray' }, lists);
    expect(p).toMatchObject({ shell: 'Ice Gray', cabinet: 'Coastal Gray', changed: true });
    expect(p.why).toContain('shell / cabinet swapped');
  });
  test('cold plunge colour moved to cabinet', () => {
    expect(planColourFix({ make: 'HotSpring', model: 'Vigor', shell_color: 'Mocha', cabinet_color: '' }, lists))
      .toMatchObject({ shell: '', cabinet: 'Mocha', changed: true, offList: [] });
  });
  test('already right → no change; unknown colour → reported only', () => {
    expect(planColourFix({ make: 'HotSpring', model: 'Envoy', shell_color: 'Tuscan', cabinet_color: 'Linen' }, lists).changed).toBe(false);
    const p = planColourFix({ make: 'HotSpring', model: 'Envoy', shell_color: 'Purple', cabinet_color: 'Linen' }, lists);
    expect(p).toMatchObject({ changed: false, offList: ['shell "Purple"'] });
  });
});

describe('saleChannel', () => {
  test('cleans input and labels booth sales', () => {
    expect(cleanSaleChannel(undefined)).toEqual({ channel: 'showroom', location: '' });
    expect(cleanSaleChannel({ channel: 'bogus', location: 'X' })).toEqual({ channel: 'showroom', location: '' });
    expect(cleanSaleChannel({ channel: 'showroom', location: 'ignored' })).toEqual({ channel: 'showroom', location: '' });
    expect(saleChannelLabel({ channel: 'costco', location: ' Gilbert ' })).toBe('Costco – Gilbert');
    expect(saleChannelLabel({ channel: 'walmart' })).toBe('Walmart');
  });
});

describe('New Contract and Add to Inventory', () => {
  let ctx, admin;
  beforeAll(async () => {
    ctx = createTestApp();
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  });
  afterAll(() => { destroyTestApp(ctx); });
  const post = overrides => admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData(overrides)) });
  const base = contractFormData();

  test('City and Zip are required', async () => {
    const noCity = await post({ customer: { ...base.customer, city: ' ' } });
    expect(noCity.status).toBe(400); expect(noCity.body.error).toBe('City is required');
    const badZip = await post({ customer: { ...base.customer, zip: '8500' } });
    expect(badZip.status).toBe(400); expect(badZip.body.error).toMatch(/Zip is required/);
  });

  test('a booth sale keeps its store and is listed with its channel', async () => {
    const { contractId, contractNumber } = await createContract(admin, { store: 'Chandler', saleChannel: { channel: 'costco', location: 'Gilbert' } });
    expect(contractNumber).toMatch(/^DHT\d{4}CH\d{5}$/); // numbering unchanged
    const data = JSON.parse(ctx.db.prepare('SELECT data FROM contracts WHERE id=?').get(contractId).data);
    expect(data.saleChannel).toEqual({ channel: 'costco', location: 'Gilbert' });
    const listed = (await admin.get('/api/contracts')).body.find(c => c.id === contractId);
    expect(listed).toMatchObject({ sale_channel: 'costco', sale_location: 'Gilbert', store: 'Chandler' });
  });

  test('a normal sale is a showroom sale', async () => {
    const { contractId } = await createContract(admin);
    expect((await admin.get('/api/contracts')).body.find(c => c.id === contractId).sale_channel).toBe('showroom');
  });

  test('colours are saved in the SKU List spelling', async () => {
    const { contractId } = await createContract(admin, { product: { ...base.product, make: 'HotSpring', shellColor: 'Tuscan Sun', cabinetColor: 'Nickel' } });
    const p = JSON.parse(ctx.db.prepare('SELECT data FROM contracts WHERE id=?').get(contractId).data).product;
    expect([p.shellColor, p.cabinetColor]).toEqual(['Tuscan', 'Brushed Nickel']);

    const res = await admin.post('/api/inventory-items').field('make', 'Caldera').field('model', 'Vanto')
      .field('serialNumber', 'COL-1').field('shellColor', 'Taupe').field('cabinetColor', 'Costal Gray');
    expect(res.status).toBe(200);
    expect(ctx.db.prepare("SELECT shell_color, cabinet_color FROM inventory WHERE serial_number='COL-1'").get())
      .toEqual({ shell_color: 'Natural Taupe', cabinet_color: 'Coastal Gray' });
  });

  test('/api/inventory/colours serves per-brand buttons and the alias map', async () => {
    const res = await admin.get('/api/inventory/colours');
    expect(res.status).toBe(200);
    expect(res.body.brands.HotSpring.cabinet).toEqual(expect.arrayContaining(['Diamond Weave', 'Driftwood']));
    expect(res.body.brands.LifeSmart.shell).toEqual(['Arctic White', 'Sand', 'Sea Salt', 'Taupe']);
    expect(res.body.aliases['*']['tuscan sun']).toBe('Tuscan');
  });

  test('the new inventory locations are recognised by the stock import', () => {
    const { mapLocation } = require('../services/inventoryReplace');
    expect(mapLocation('EMP Room')).toEqual({ value: 'Back Room', known: true });
    expect(mapLocation('back room')).toEqual({ value: 'Back Room', known: true });
    expect(mapLocation('Costco')).toEqual({ value: 'Costco', known: true });
  });
});
