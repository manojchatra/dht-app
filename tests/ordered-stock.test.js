'use strict';
// On-order stock (Ordered, no serial, on a truck) sold on a contract: reserved
// instead of ordered a second time, received once, released on cancel/delete.
const sharp = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx, admin;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

let n = 0;
const addOrdered = (model = 'Vanto') => ctx.db.prepare(`INSERT INTO inventory
  (make, model, shell_color, cabinet_color, availability, web_order_number, truck_number, added_by)
  VALUES ('Caldera', ?, 'Pearl', 'Java', 'Ordered', ?, ?, 'test')`).run(model, `WO-${++n}`, `TRK-${n}`).lastInsertRowid;
const unitById = id => ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
const contract = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const onOrderProduct = unitId => ({ status: 'tbo', orderedUnitId: unitId, serialNumber: '', make: 'Caldera', model: 'Vanto', year: '2026' });
const jpeg = () => sharp({ create: { width: 40, height: 40, channels: 3, background: '#888' } }).jpeg().toBuffer();
const emails = () => require('../utils/emailSender');

describe('picking on-order stock on a new contract', () => {
  test('the New Contract search lists unreserved on-order stock after In-stock, only when asked', async () => {
    const id = addOrdered('SearchModel');
    const withOrdered = (await admin.get('/api/inventory/search').query({ q: 'searchmodel', includeOrdered: '1' })).body.results;
    expect(withOrdered.map(r => r.id)).toContain(id);
    const plain = (await admin.get('/api/inventory/search').query({ q: 'searchmodel' })).body.results;
    expect(plain.map(r => r.id)).not.toContain(id);
  });

  test('the "On order" filter lists only unreserved on-order stock', async () => {
    const id = addOrdered('FilterModel');
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability, location) VALUES ('Caldera','FilterModel','FM-STOCK-1','In-stock','Warehouse')").run();
    const rows = (await admin.get('/api/inventory/search').query({ q: 'filtermodel', store: 'onorder', includeOrdered: '1' })).body.results;
    expect(rows.map(r => r.id)).toEqual([id]);
  });

  test('reserves the unit and starts the contract at Order Placed with its Web Order # / Truck #', async () => {
    const id = addOrdered();
    const { contractId } = await createContract(admin, { product: onOrderProduct(id) });

    const c = contract(contractId);
    const u = unitById(id);
    expect(c).toMatchObject({ status: 'order_placed', product_status: 'tbo', web_order_number: u.web_order_number, truck_number: u.truck_number });
    expect(u).toMatchObject({ availability: 'Ordered', contract_id: contractId, serial_number: null });
    expect(emails().notifyContractCreatedOnOrder).toHaveBeenCalled();
    expect(require('../services/driveInventory').moveToOrderPlaced).toHaveBeenCalledWith(c.contract_number, u.web_order_number, u.truck_number, expect.any(Object));

    // Now reserved: not offered again, and a second contract can't take it.
    const results = (await admin.get('/api/inventory/search').query({ includeOrdered: '1' })).body.results;
    expect(results.map(r => r.id)).not.toContain(id);
    const again = await admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData({ product: onOrderProduct(id) })) });
    expect(again.status).toBe(409);
  });

  test('an on-order spa cannot be sold as In Stock or back-entered', async () => {
    const id = addOrdered();
    const instock = await admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData({ product: { ...onOrderProduct(id), status: 'instock' } })) });
    expect(instock.status).toBe(400);
    const past = await admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData({ product: onOrderProduct(id), deliveryDate: '2020-01-01' })) });
    expect(past.status).toBe(400);
    expect(unitById(id).contract_id).toBeNull();
  });
});

describe('receiving a contract that reserved on-order stock', () => {
  test('the Warehouse queue shows the spa once (as the contract), and receiving it fills in that unit', async () => {
    const id = addOrdered();
    const { contractId } = await createContract(admin, { product: onOrderProduct(id) });

    const queue = (await admin.get('/api/warehouse/queue')).body;
    expect(queue.filter(r => r.type === 'inventory' && r.id === id)).toHaveLength(0);
    expect(queue.filter(r => r.type === 'contract' && r.id === contractId)).toHaveLength(1);

    const before = ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
    const photo = await jpeg();
    const res = await admin.post(`/api/warehouse/${contractId}/receive`)
      .field('serialNumber', `RCV-WH-${id}`).field('skuNumber', 'SKU-1')
      .attach('serialPhoto', photo, 'serial.jpg').attach('skuPhoto', photo, 'sku.jpg');

    expect(res.status).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c).toBe(before);
    expect(unitById(id)).toMatchObject({ serial_number: `RCV-WH-${id}`, availability: 'Sold', contract_id: contractId, sku_number: 'SKU-1' });
    expect(contract(contractId)).toMatchObject({ status: 'received', serial_number: `RCV-WH-${id}` });
  });

  test('the admin Mark Received flow fills in the reserved unit too', async () => {
    const id = addOrdered();
    const { contractId } = await createContract(admin, { product: onOrderProduct(id) });
    const res = await admin.post(`/api/contracts/${contractId}/received`)
      .field('serialNumber', `RCV-ADM-${id}`).attach('serialPhoto', await jpeg(), 'serial.jpg');
    expect(res.status).toBe(200);
    expect(unitById(id)).toMatchObject({ serial_number: `RCV-ADM-${id}`, availability: 'Sold', contract_id: contractId });
  });

  test('the reserved unit cannot be received or re-labelled from the Inventory page', async () => {
    const id = addOrdered();
    const { contractNumber } = await createContract(admin, { product: onOrderProduct(id) });
    const recv = await admin.patch(`/api/inventory-items/${id}/receive`).field('serialNumber', 'NOPE-1');
    expect(recv.status).toBe(400);
    expect(recv.body.error).toMatch(contractNumber);
    expect((await admin.patch(`/api/inventory-items/${id}`).send({ availability: 'In-stock' })).status).toBe(400);
    const listed = (await admin.get('/api/inventory-items')).body.find(i => i.id === id);
    expect(listed.reserved_contract_number).toBe(contractNumber);
  });
});

describe('re-linking a contract to a different on-order unit', () => {
  const svc = () => require('../services/orderedStock');

  test('moves the reservation and the Web Order # / Truck #; the old unit is free again', async () => {
    const wrong = addOrdered(), right = addOrdered();
    const { contractId } = await createContract(admin, { product: onOrderProduct(wrong) });

    const { from, to } = svc().relinkOrdered(ctx.db, contractId, right);

    expect([from.id, to.id]).toEqual([wrong, right]);
    expect(unitById(wrong)).toMatchObject({ availability: 'Ordered', contract_id: null });
    expect(unitById(right)).toMatchObject({ availability: 'Ordered', contract_id: contractId });
    const c = contract(contractId);
    expect(c).toMatchObject({ web_order_number: unitById(right).web_order_number, truck_number: unitById(right).truck_number });
    expect(JSON.parse(c.data).product.orderedUnitId).toBe(right);
  });

  test('refuses a unit that is already reserved, and a contract already received', async () => {
    const a = addOrdered(), b = addOrdered();
    const one = await createContract(admin, { product: onOrderProduct(a) });
    const two = await createContract(admin, { product: onOrderProduct(b) });
    expect(() => svc().relinkOrdered(ctx.db, one.contractId, b)).toThrow(/not unreserved/);
    expect(unitById(a).contract_id).toBe(one.contractId); // unchanged

    ctx.db.prepare("UPDATE contracts SET status='received' WHERE id=?").run(two.contractId);
    expect(() => svc().relinkOrdered(ctx.db, two.contractId, addOrdered())).toThrow(/only an Order Placed/);
  });
});

describe('converting a contract with a typed placeholder serial to on-order stock', () => {
  const svc = () => require('../services/orderedStock');

  test('reserves the on-order unit, deletes the placeholder unit, and moves the contract to Order Placed', async () => {
    const id = addOrdered();
    const placeholder = `Truck 20 #${id}`;
    const { contractId } = await createContract(admin, { product: { status: 'instock', serialNumber: placeholder, make: 'Caldera', model: 'Vanto' } });
    expect(ctx.db.prepare('SELECT created_by_contract_id FROM inventory WHERE serial_number=?').get(placeholder).created_by_contract_id).toBe(contractId);

    const { removed } = svc().convertToOnOrder(ctx.db, contractId, id);

    expect(removed.map(u => u.serial_number)).toEqual([placeholder]);
    expect(ctx.db.prepare('SELECT 1 FROM inventory WHERE serial_number=?').get(placeholder)).toBeUndefined();
    expect(unitById(id).contract_id).toBe(contractId);
    const c = contract(contractId);
    expect(c).toMatchObject({ status: 'order_placed', product_status: 'tbo', serial_number: null, truck_number: unitById(id).truck_number });
    expect(JSON.parse(c.data).product).toMatchObject({ status: 'tbo', serialNumber: '', orderedUnitId: id });
  });

  test('a real spa the contract had goes back to In-stock, not deleted', async () => {
    const serial = `REAL-SPA-${++n}`;
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('Caldera','Vanto',?,'In-stock')").run(serial);
    const { contractId } = await createContract(admin, { product: { status: 'instock', serialNumber: serial, make: 'Caldera', model: 'Vanto' } });
    svc().convertToOnOrder(ctx.db, contractId, addOrdered());
    expect(ctx.db.prepare('SELECT availability, contract_id FROM inventory WHERE serial_number=?').get(serial)).toEqual({ availability: 'In-stock', contract_id: null });
  });
});

describe('releasing reserved on-order stock', () => {
  test('cancelling the contract returns the unit to unreserved Ordered stock', async () => {
    const id = addOrdered();
    const { contractId } = await createContract(admin, { product: onOrderProduct(id) });
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' })).status).toBe(200);
    expect(unitById(id)).toMatchObject({ availability: 'Ordered', contract_id: null });
  });

  test('deleting the contract returns the unit to unreserved Ordered stock', async () => {
    const id = addOrdered();
    const { contractId } = await createContract(admin, { product: onOrderProduct(id) });
    expect((await admin.delete(`/api/contracts/${contractId}`)).status).toBe(200);
    expect(unitById(id)).toMatchObject({ availability: 'Ordered', contract_id: null });
  });
});

describe('admin links a To Be Ordered contract to on-order stock', () => {
  test('Move to Order Placed offers matching stock and links it instead of a new order', async () => {
    const id = addOrdered('LinkModel');
    const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'caldera', model: 'LinkModel ' } });
    expect(contract(contractId).status).toBe('tbo');

    const matches = (await admin.get('/api/inventory/ordered-matches').query({ make: 'caldera', model: 'LinkModel ' })).body.results;
    expect(matches.map(u => u.id)).toEqual([id]);

    const res = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'order_placed', inventoryId: id });
    expect(res.status).toBe(200);
    const u = unitById(id);
    expect(u.contract_id).toBe(contractId);
    expect(contract(contractId)).toMatchObject({ status: 'order_placed', web_order_number: u.web_order_number, truck_number: u.truck_number });
    expect((await admin.get('/api/inventory/ordered-matches').query({ make: 'Caldera', model: 'LinkModel' })).body.results).toEqual([]);
  });

  test('salespeople cannot move a contract to Order Placed', async () => {
    const sales = await loginAgent(ctx.app);
    const id = addOrdered();
    const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'Caldera', model: 'Vanto' } });
    expect((await sales.patch(`/api/contracts/${contractId}/status`).send({ status: 'order_placed', inventoryId: id })).status).toBe(403);
    expect(unitById(id).contract_id).toBeNull();
  });
});
