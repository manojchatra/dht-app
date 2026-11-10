'use strict';
// Add Inventory → On Order: a spa whose Web Order #, make and model match an
// Order Placed contract with no spa reserved yet is probably that customer's
// spa. The page is asked first (409 needsChoice); "Reserve for <contract>"
// adds it reserved, "Add as general stock" adds it as before.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, drive;
beforeAll(async () => {
  ctx = createTestApp();
  drive = require('../services/driveInventory'); // the jest mock from createTestApp
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

const contract = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const unit = id => ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
let n = 0;

/** A To Be Ordered contract moved to Order Placed with typed numbers (no spa in Inventory). */
async function orderPlaced(model = 'Geneva', truck = 'Truck 25') {
  const wo = `WO-M${++n}`;
  const { contractId, contractNumber } = await createContract(admin, {
    customer: { name: 'Jane Pool', email: `jp${n}@example.com`, zip: '85001', phone: { cell: '602-555-0100' }, address: '1 A St', city: 'Mesa', state: 'AZ' },
    product: { status: 'tbo', serialNumber: '', make: 'Caldera', model } });
  const r = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'order_placed', webOrderNumber: wo, truckNumber: truck });
  expect(r.status).toBe(200);
  return { contractId, contractNumber, wo };
}
const addOnOrder = (fields, choice) => {
  const req = admin.post('/api/inventory-items')
    .field('make', fields.make || 'Caldera').field('model', fields.model || 'Geneva')
    .field('webOrderNumber', fields.wo).field('truckNumber', fields.truck || 'Truck 25');
  return choice ? req.field('orderChoice', choice) : req;
};

test('a matching spa asks first and adds nothing until answered', async () => {
  const { contractId, contractNumber, wo } = await orderPlaced();
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n;
  const r = await addOnOrder({ wo: ' ' + wo.toLowerCase() + ' ', make: 'caldera' });
  expect(r.status).toBe(409);
  expect(r.body).toEqual({ needsChoice: true, matches: [{ id: contractId, contractNumber, customerName: 'Jane Pool', truckNumber: 'Truck 25' }] });
  expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n).toBe(before);
});

test('"Reserve for" adds it reserved for that contract; the contract takes its Truck #', async () => {
  const { contractId, contractNumber, wo } = await orderPlaced('Geneva', 'Truck 24');
  drive.moveToOrderPlaced.mockClear();
  const r = await addOnOrder({ wo, truck: 'Truck 25' }, String(contractId));
  expect(r.status).toBe(200);
  expect(r.body.reservedFor).toBe(contractNumber);
  expect(unit(r.body.id)).toMatchObject({ availability: 'Ordered', contract_id: contractId, web_order_number: wo, truck_number: 'Truck 25' });
  const c = contract(contractId);
  expect(c).toMatchObject({ status: 'order_placed', web_order_number: wo, truck_number: 'Truck 25' });
  expect(JSON.parse(c.data).product.orderedUnitId).toBe(r.body.id);
  expect(drive.moveToOrderPlaced).toHaveBeenCalledWith(contractNumber, wo, 'Truck 25', expect.any(Object)); // the Sheet row's Truck #
  const log = ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='ORDER_PLACED' ORDER BY id DESC").get(contractId);
  expect(log.detail).toMatch(/added to Inventory and reserved for it .* \(Truck # was Truck 24\)/);

  // Reserved now: the warehouse queue lists the contract only, and a second spa isn't matched to it.
  const queue = (await admin.get('/api/warehouse/queue')).body;
  expect(queue.filter(q => q.type === 'inventory' && q.id === r.body.id)).toEqual([]);
  expect((await addOnOrder({ wo })).status).toBe(200);
});

test('"Add as general stock" adds it unreserved, as before', async () => {
  const { contractId, wo } = await orderPlaced();
  const r = await addOnOrder({ wo }, 'stock');
  expect(r.status).toBe(200);
  expect(r.body.reservedFor).toBeNull();
  expect(unit(r.body.id).contract_id).toBeNull();
  expect(contract(contractId).truck_number).toBe('Truck 25');
});

test('no question for another model or Web Order #, a received contract, or a serial', async () => {
  const { contractId, wo } = await orderPlaced('Makena');
  expect((await addOnOrder({ wo, model: 'Geneva' })).status).toBe(200);
  expect((await addOnOrder({ wo: 'WO-OTHER', model: 'Makena' })).status).toBe(200);
  ctx.db.prepare("UPDATE contracts SET status='received' WHERE id=?").run(contractId);
  expect((await addOnOrder({ wo, model: 'Makena' })).status).toBe(200);
});

test('a contract that no longer needs the spa is refused, nothing added', async () => {
  const { contractId, wo } = await orderPlaced();
  ctx.db.prepare("UPDATE contracts SET status='cancelled' WHERE id=?").run(contractId);
  const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n;
  const r = await addOnOrder({ wo }, String(contractId));
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/no longer needs this spa/);
  expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n).toBe(before);
});

test('the Add Inventory page asks with Reserve for … / Add as general stock and sends the answer', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/inventory-add.html'), 'utf8');
  expect(src).toMatch(/if\(r\.status===409&&j\.needsChoice\)/);
  expect(src).toMatch(/label:'Reserve for '\+m\.contractNumber/);
  expect(src).toMatch(/\{value:'stock', label:'Add as general stock'\}/);
  expect(src).toMatch(/fd\.set\('orderChoice',choice\)/);
  expect(src).toMatch(/if\(!choice\) return; \/\/ closed: nothing added/);
});
