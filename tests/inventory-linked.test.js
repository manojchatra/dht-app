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
