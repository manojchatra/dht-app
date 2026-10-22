'use strict';
// One spelling per spa brand (utils/makes.js), applied where makes are saved.
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');
const { normalizeMake } = require('../utils/makes');

describe('normalizeMake', () => {
  test.each([
    ['Hotspring', 'HotSpring'], ['hot spring', 'HotSpring'], [' HOTSPRING ', 'HotSpring'],
    ['EndlessPools', 'Endless Pools'], ['Endless Pool', 'Endless Pools'], ['endless pools', 'Endless Pools'],
    ['caldera', 'Caldera'], ['Lifesmart', 'LifeSmart'], ['wla', 'WLA'],
    ['Some New Brand', 'Some New Brand'], ['', ''],
  ])('%j → %j', (input, out) => expect(normalizeMake(input)).toBe(out));
});

describe('makes are saved in the standard spelling', () => {
  let ctx, admin;
  beforeAll(async () => {
    ctx = createTestApp();
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  });
  afterAll(() => { destroyTestApp(ctx); });

  test('New Contract', async () => {
    const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'hotspring', model: 'Relay' } });
    const c = ctx.db.prepare('SELECT make, data FROM contracts WHERE id=?').get(contractId);
    expect(c.make).toBe('HotSpring');
    expect(JSON.parse(c.data).product.make).toBe('HotSpring');
  });

  test('Add to Inventory', async () => {
    const res = await admin.post('/api/inventory-items').field('make', 'EndlessPools').field('model', 'E500').field('serialNumber', 'EP-MAKE-1');
    expect(res.status).toBe(200);
    expect(ctx.db.prepare("SELECT make FROM inventory WHERE serial_number='EP-MAKE-1'").get().make).toBe('Endless Pools');
  });

  test('stock sheet import', () => {
    const [row] = require('../services/inventoryReplace').parseSheetRows([{ 'Serial Number': 'X1', Make: 'Hot Spring', Model: 'Mini' }]);
    expect(row.make).toBe('HotSpring');
  });
});
