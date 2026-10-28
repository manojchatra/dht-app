'use strict';
// New Contract must say In Stock or To Be Ordered, and an In Stock sale must
// name its spa (DHT2607SU00040 / DHT2610SU00039 were saved In Stock with
// neither a spa nor a serial). The serial lookup gives the form what it needs
// for the "Spa found in inventory" popup. Assign SI. No works on Assigned.
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx, admin;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

const base = contractFormData();
const post = product => admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData({ product: { ...base.product, ...product } })) });

test('Availability Status is required', async () => {
  const res = await post({ status: '' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Availability Status is required (In Stock or To Be Ordered)');
});

test('an In Stock sale needs a spa or a serial; To Be Ordered and old delivered sales don\'t', async () => {
  const res = await post({ status: 'instock', serialNumber: '' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('An In Stock sale needs its spa: pick it in Inventory Search or type its serial number.');

  expect((await post({ status: 'tbo', serialNumber: '' })).status).toBe(200);
  const back = await admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData({
    product: { ...base.product, status: 'instock', serialNumber: '' }, deliveryDate: '2025-01-15',
  })) });
  expect(back.status).toBe(200);
});

test('the serial lookup describes the spa, and says whether it can be sold', async () => {
  ctx.db.prepare(`INSERT INTO inventory (make, series, model, year, serial_number, shell_color, cabinet_color, location, availability)
    VALUES ('HotSpring','Highlife','Sovereign','2026','IIN26D3261076','Alpine White','Brushed Nickel','Surprise Floor','In-stock')`).run();
  const free = (await admin.get('/api/inventory/serial-exists').query({ serial: 'iin26d3261076' })).body;
  expect(free).toMatchObject({ exists: true, available: true, linkedTo: null,
    unit: { make: 'HotSpring', series: 'Highlife', model: 'Sovereign', shell_color: 'Alpine White', cabinet_color: 'Brushed Nickel', location: 'Surprise Floor' } });

  const { contractNumber } = await createContract(admin, { product: { ...base.product, serialNumber: 'IIN26D3261076' } });
  const sold = (await admin.get('/api/inventory/serial-exists').query({ serial: 'IIN26D3261076' })).body;
  expect(sold).toMatchObject({ exists: true, available: false, linkedTo: contractNumber });
  expect((await admin.get('/api/inventory/serial-exists').query({ serial: 'NOT-THERE' })).body).toEqual({ exists: false });
});

test('Assign SI. No on an Assigned contract links a free In-stock spa', async () => {
  const { contractId } = await createContract(admin, { product: { ...base.product, serialNumber: '' }, deliveryDate: '2025-02-01' });
  ctx.db.prepare("UPDATE contracts SET status='assigned' WHERE id=?").run(contractId); // as DHT2610SU00039 is
  const unitId = ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('Endless Pools','R200','EPR20025D4251012','In-stock')").run().lastInsertRowid;
  const ask = await admin.patch(`/api/contracts/${contractId}/serial`).send({ serialNumber: 'EPR20025D4251012' });
  expect(ask.body.needsConfirm).toBe(true);
  expect((await admin.patch(`/api/contracts/${contractId}/serial`).send({ serialNumber: 'EPR20025D4251012', linkInventory: true })).status).toBe(200);
  expect(ctx.db.prepare('SELECT availability, contract_id FROM inventory WHERE id=?').get(unitId)).toEqual({ availability: 'Sold', contract_id: contractId });
  expect(ctx.db.prepare('SELECT status, serial_number FROM contracts WHERE id=?').get(contractId)).toEqual({ status: 'assigned', serial_number: 'EPR20025D4251012' });
});
