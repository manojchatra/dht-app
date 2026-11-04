'use strict';
// Inventory shows the contract a spa is linked to: "Sold · Jane Smith ·
// DHT2610PH00066" (Sold) and "Ordered · Reserved · …" (on-order stock).
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, warehouse;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  await admin.post('/api/users').send({ username: 'wh-9', password: 'Secret123', role: 'warehouse', name: 'WH', email: 'w9@example.com' });
  warehouse = await loginAgent(ctx.app, { username: 'wh-9', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

test('a Sold spa and a Reserved on-order spa carry their contract and customer', async () => {
  const sold = await createContract(admin, { product: { status: 'instock', serialNumber: 'LINKED-INV-1', make: 'HotSpring', model: 'Envoy' } });
  const unitId = ctx.db.prepare("INSERT INTO inventory (make, model, availability, web_order_number, truck_number) VALUES ('HotSpring','Envoy','Ordered','WO-9','T-9')").run().lastInsertRowid;
  const tbo = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'HotSpring', model: 'Envoy' } });
  await admin.patch(`/api/contracts/${tbo.contractId}/status`).send({ status: 'order_placed', inventoryId: unitId });
  ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('HotSpring','Envoy','FREE-INV-1','In-stock')").run();

  for (const agent of [admin, warehouse]) {
    const items = (await agent.get('/api/inventory-items')).body;
    expect(items.find(i => i.serial_number === 'LINKED-INV-1')).toMatchObject({
      availability: 'Sold', linked_contract_id: sold.contractId, linked_contract_number: sold.contractNumber,
      linked_customer_name: 'Jane Test', reserved_contract_number: null });
    expect(items.find(i => i.id === unitId)).toMatchObject({
      availability: 'Ordered', linked_contract_number: tbo.contractNumber, reserved_contract_number: tbo.contractNumber });
    expect(items.find(i => i.serial_number === 'FREE-INV-1')).toMatchObject({ linked_contract_id: null, linked_contract_number: null });
  }
});

// Sales: view-only Inventory. Every name and contract number is shown, but the
// contract id (the page's link) only on their own contracts; no Finance.
describe('sales view-only inventory', () => {
  let sales, salesB;
  beforeAll(async () => {
    sales = await loginAgent(ctx.app);
    await admin.post('/api/sales').send({ username: 'sales-inv2', password: 'Secret123', name: 'Other Seller', email: 'inv2@example.com' });
    salesB = await loginAgent(ctx.app, { username: 'sales-inv2', password: 'Secret123' });
  });

  test('sees the list: link only on own contracts, no Finance', async () => {
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability, finance) VALUES ('HotSpring','Envoy','SALES-OWN-1','In-stock','Bank Owned')").run();
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability, finance) VALUES ('HotSpring','Envoy','SALES-OTHER-1','In-stock','DHT Owned')").run();
    const own = await createContract(sales, { product: { status: 'instock', serialNumber: 'SALES-OWN-1', make: 'HotSpring', model: 'Envoy' } });
    const other = await createContract(salesB, { product: { status: 'instock', serialNumber: 'SALES-OTHER-1', make: 'HotSpring', model: 'Envoy' } });

    const res = await sales.get('/api/inventory-items');
    expect(res.status).toBe(200);
    const mine = res.body.find(i => i.serial_number === 'SALES-OWN-1');
    const theirs = res.body.find(i => i.serial_number === 'SALES-OTHER-1');
    expect(mine).toMatchObject({ availability: 'Sold', linked_contract_id: own.contractId, linked_contract_number: own.contractNumber, linked_customer_name: 'Jane Test' });
    expect(theirs).toMatchObject({ availability: 'Sold', linked_contract_id: null, linked_contract_number: other.contractNumber, linked_customer_name: 'Jane Test' });
    expect(res.body.every(i => !('finance' in i) && !('linked_salesman_user_id' in i))).toBe(true);

    // Admin still gets Finance and every link.
    const adminItems = (await admin.get('/api/inventory-items')).body;
    expect(adminItems.find(i => i.serial_number === 'SALES-OTHER-1')).toMatchObject({ finance: 'DHT Owned', linked_contract_id: other.contractId });
  });

  test('cannot add, edit, receive or delete', async () => {
    const id = ctx.db.prepare("INSERT INTO inventory (make, model, availability) VALUES ('HotSpring','Envoy','Ordered')").run().lastInsertRowid;
    expect((await sales.post('/api/inventory-items').field('make', 'HotSpring').field('model', 'Envoy').field('serialNumber', 'NOPE-1')).status).toBe(403);
    expect((await sales.patch(`/api/inventory-items/${id}`).send({ line: '3' })).status).toBe(403);
    expect((await sales.patch(`/api/inventory-items/${id}/receive`).send({ serialNumber: 'NOPE-2' })).status).toBe(403);
    expect((await sales.delete(`/api/inventory-items/${id}`)).status).toBe(403);
    expect((await sales.get('/api/inventory-items/sku-lookup?sku=X')).status).toBe(403);
    expect(ctx.db.prepare('SELECT availability FROM inventory WHERE id=?').get(id).availability).toBe('Ordered');
  });
});
