'use strict';
// Contracts carrying the serial of an in-stock spa that isn't linked to them
// (services/serialLink.js) — the spa would otherwise stay sellable.
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, n = 0;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

const svc = () => require('../services/serialLink');
const addStock = serial => ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('HotSpring','Envoy',?,'In-stock')").run(serial).lastInsertRowid;
const unit = id => ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
const status = id => ctx.db.prepare('SELECT status FROM contracts WHERE id=?').get(id).status;

test('a To Be Ordered contract saved with an in-stock serial is found, linked, and moved to Received', async () => {
  const serial = `KKN-TEST-${++n}`;
  const id = addStock(serial);
  // Saved as To Be Ordered with the serial typed in — the app doesn't link it.
  const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: serial, make: 'HotSpring', model: 'Envoy' } });
  ctx.db.prepare("UPDATE contracts SET status='order_placed', web_order_number='WO', truck_number='T20' WHERE id=?").run(contractId);
  expect(unit(id)).toMatchObject({ availability: 'In-stock', contract_id: null });

  expect(svc().findUnlinkedSerials(ctx.db).map(r => r.contract_id)).toContain(contractId);
  const res = svc().linkInStockSerial(ctx.db, contractId);

  expect(res).toMatchObject({ fromStatus: 'order_placed', toReceived: true });
  expect(unit(id)).toMatchObject({ availability: 'Sold', contract_id: contractId });
  expect(status(contractId)).toBe('received');
  expect(svc().findUnlinkedSerials(ctx.db).map(r => r.contract_id)).not.toContain(contractId);
});

test("the spa's serial and SKU photos are added to the contract's gallery, once", async () => {
  const serial = `KKN-TEST-${++n}`;
  const id = addStock(serial);
  ctx.db.prepare("UPDATE inventory SET serial_photo_path='/u/inventory/x/serial-photo.jpg', sku_photo_path='/u/inventory/x/sku-photo.jpg' WHERE id=?").run(id);
  const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: serial, make: 'HotSpring', model: 'Envoy' } });

  expect(svc().linkInStockSerial(ctx.db, contractId).photosAdded).toEqual(['SKU barcode', 'serial']);

  const imgs = JSON.parse(ctx.db.prepare('SELECT extra_images FROM contracts WHERE id=?').get(contractId).extra_images);
  expect(imgs.slice(0, 2)).toEqual([
    { path: '/u/inventory/x/serial-photo.jpg', label: 'Serial Number Photo' },
    { path: '/u/inventory/x/sku-photo.jpg', label: 'SKU Barcode Photo' },
  ]);
  expect(imgs.some(i => i.label === 'Customer Signature')).toBe(true); // existing images kept
  expect(unit(id).serial_photo_path).toBe('/u/inventory/x/serial-photo.jpg'); // spa keeps its photos
});

test('an Assigned contract is linked without a status change', async () => {
  const serial = `KKN-TEST-${++n}`;
  const id = addStock(serial);
  const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'HotSpring', model: 'Envoy' } });
  ctx.db.prepare("UPDATE contracts SET status='assigned', serial_number=? WHERE id=?").run(serial, contractId);
  expect(svc().linkInStockSerial(ctx.db, contractId).toReceived).toBe(false);
  expect(status(contractId)).toBe('assigned');
  expect(unit(id).contract_id).toBe(contractId);
});

test('a spa already sold to another contract is reported but never re-linked', async () => {
  const serial = `KKN-TEST-${++n}`;
  addStock(serial);
  const first = await createContract(admin, { product: { status: 'instock', serialNumber: serial, make: 'HotSpring', model: 'Envoy' } });
  const second = await createContract(admin, { product: { status: 'tbo', serialNumber: serial, make: 'HotSpring', model: 'Envoy' } });
  const row = svc().findUnlinkedSerials(ctx.db).find(r => r.contract_id === second.contractId);
  expect(row.unit_contract_id).toBe(first.contractId);
  expect(() => svc().linkInStockSerial(ctx.db, second.contractId)).toThrow(/another contract/);
});
