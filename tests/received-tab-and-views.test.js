'use strict';
// Nov 2026: the Warehouse page's Received tab (spas marked received, by truck,
// with the contract they're tied to — a View contract link for admin only),
// the received date both Mark Received flows now save, salespeople's
// Inventory without SKU # / Line / Bay / Steps / Cover / Web Order #, and the
// Sales page's Username column.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, sales, warehouse, today;
beforeAll(async () => {
  ctx = createTestApp();
  today = require('../utils/arizona').phoenixToday();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
  await admin.post('/api/users').send({ username: 'wh-rcv', password: 'Secret123', role: 'warehouse', name: 'Warehouse', email: 'wh-rcv@example.com' });
  warehouse = await loginAgent(ctx.app, { username: 'wh-rcv', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const unit = id => ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
let n = 0;
const addOrdered = (truck = 'Truck 25') => ctx.db.prepare(`INSERT INTO inventory
  (make, model, shell_color, cabinet_color, availability, web_order_number, truck_number, added_by)
  VALUES ('Caldera','Geneva','Pearl','Java','Ordered',?,?, 'test')`).run(`WO-R${++n}`, truck).lastInsertRowid;

describe('Received tab', () => {
  test('general stock marked received gets today\'s date and is listed', async () => {
    const id = addOrdered('Truck 25');
    const r = await warehouse.patch(`/api/inventory-items/${id}/receive`).field('serialNumber', 'RCV-GEN-1');
    expect(r.status).toBe(200);
    expect(unit(id)).toMatchObject({ availability: 'In-stock', serial_number: 'RCV-GEN-1', received_at: today });
    const row = (await warehouse.get('/api/warehouse/received')).body.find(x => x.id === id);
    expect(row).toMatchObject({ truck_number: 'Truck 25', serial_number: 'RCV-GEN-1', contract_number: null, customer_name: '' });
  });

  test('a contract\'s reserved spa received on the Warehouse page carries the contract; admin gets the link, warehouse not', async () => {
    const id = addOrdered('Truck 26');
    const { contractId, contractNumber } = await createContract(admin, {
      customer: { name: 'Jane Pool', email: 'jp-rcv@example.com', zip: '85001', phone: { cell: '602-555-0100' }, address: '1 A St', city: 'Mesa', state: 'AZ' },
      product: { status: 'tbo', orderedUnitId: id, serialNumber: '', make: 'Caldera', model: 'Geneva' } });
    const sharp = require('sharp');
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const r = await warehouse.post(`/api/warehouse/${contractId}/receive`).field('serialNumber', 'RCV-CON-1').field('receivedDate', '2026-11-12')
      .attach('serialPhoto', jpeg, 'serial.jpg').attach('skuPhoto', jpeg, 'sku.jpg');
    expect(r.status).toBe(200);
    expect(unit(id)).toMatchObject({ availability: 'Sold', contract_id: contractId, received_at: '2026-11-12' });

    const forAdmin = (await admin.get('/api/warehouse/received')).body.find(x => x.id === id);
    expect(forAdmin).toMatchObject({ contract_number: contractNumber, customer_name: 'Jane Pool', contract_id: contractId });
    const forWarehouse = (await warehouse.get('/api/warehouse/received')).body.find(x => x.id === id);
    expect(forWarehouse).toMatchObject({ contract_number: contractNumber, customer_name: 'Jane Pool', contract_id: null });
  }, 30000);

  test('received general stock sold later shows its contract', async () => {
    const id = addOrdered('Truck 25');
    await warehouse.patch(`/api/inventory-items/${id}/receive`).field('serialNumber', 'RCV-GEN-2');
    const { contractNumber } = await createContract(admin, { product: { status: 'instock', serialNumber: 'RCV-GEN-2', make: 'Caldera', model: 'Geneva' } });
    const row = (await admin.get('/api/warehouse/received')).body.find(x => x.id === id);
    expect(row).toMatchObject({ availability: 'Sold', contract_number: contractNumber, received_at: today });
  });

  test('not listed: stock added with a serial, on-order stock not yet received; sales can\'t open the list', async () => {
    const added = await admin.post('/api/inventory-items').field('make', 'Caldera').field('model', 'Geneva').field('serialNumber', 'RCV-DIRECT-1');
    expect(added.status).toBe(200);
    const waiting = addOrdered('Truck 27');
    const ids = (await admin.get('/api/warehouse/received')).body.map(x => x.id);
    expect(ids).not.toContain(added.body.id);
    expect(ids).not.toContain(waiting);
    expect((await sales.get('/api/warehouse/received')).status).toBe(403);
  });

  test('the page: tabs next to the search, a Truck filter, the same card with the contract in the button area', () => {
    const src = page('warehouse-dashboard.html');
    expect(src).toMatch(/id="tab-queue"[^>]*>Awaiting receipt</);
    expect(src).toMatch(/id="tab-received"[^>]*>Received</);
    expect(src.indexOf('id="tab-received"')).toBeLessThan(src.indexOf('id="searchInput"'));
    expect(src).toMatch(/id="truckFilter"/);
    expect(src).toMatch(/fetch\('\/api\/warehouse\/received'\)/);
    expect(src).toMatch(/it\.contract_id\?' <a class="btn btn-secondary btn-sm" href="\/contracts\/'\+it\.contract_id/);
    expect(src).toMatch(/General Stock/);
  });
});

describe('the received date backfill', () => {
  test('dates spas received for a contract from its history (Arizona date); other spas stay undated', async () => {
    const { contractId } = await createContract(admin, { product: { status: 'instock', serialNumber: 'BACKFILL-1', make: 'Caldera', model: 'Geneva' } });
    const other = ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability, truck_number) VALUES ('Caldera','Geneva','BACKFILL-2','In-stock','Truck 1')").run().lastInsertRowid;
    // Received at 3 am UTC on Nov 2 = Nov 1 in Arizona.
    ctx.db.prepare("INSERT INTO activity_log (contract_id, contract_num, event_type, created_at) VALUES (?, 'X', 'MARK_RECEIVED', '2026-11-02 03:00:00')").run(contractId);
    ctx.db.exec('ALTER TABLE inventory DROP COLUMN received_at');

    jest.isolateModules(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const fresh = require('../db/database'); // runs the migrations again on the same database file
      fresh.close();
    });
    const linked = ctx.db.prepare('SELECT received_at FROM inventory WHERE contract_id=?').get(contractId);
    expect(linked.received_at).toBe('2026-11-01');
    expect(unit(other).received_at).toBeNull();
  });
});

describe('Inventory for salespeople', () => {
  test('SKU #, Line, Bay, Steps, Cover and Web Order # are not sent to sales; staff still get them', async () => {
    ctx.db.prepare(`INSERT INTO inventory (make, model, serial_number, sku_number, availability, line, bay, steps, cover, web_order_number, truck_number, finance)
      VALUES ('Caldera','Geneva','SALES-HIDE-1','SKU9','In-stock','L1','B2','HLStep','Grey','WO-9','Truck 9','Owned')`).run();
    const forSales = (await sales.get('/api/inventory-items')).body.find(i => i.serial_number === 'SALES-HIDE-1');
    for (const k of ['sku_number', 'line', 'bay', 'steps', 'cover', 'web_order_number', 'finance']) expect(forSales).not.toHaveProperty(k);
    expect(forSales).toMatchObject({ truck_number: 'Truck 9', make: 'Caldera' });
    const forAdmin = (await admin.get('/api/inventory-items')).body.find(i => i.serial_number === 'SALES-HIDE-1');
    expect(forAdmin).toMatchObject({ sku_number: 'SKU9', line: 'L1', bay: 'B2', steps: 'HLStep', cover: 'Grey', web_order_number: 'WO-9' });
  });

  test('the page hides those columns and card fields for sales', () => {
    const src = page('inventory-list.html');
    for (const h of ['SKU Number', 'Line', 'Bay', 'Steps', 'Cover', 'Finance', 'Web Order Number']) {
      expect(src).toMatch(new RegExp(`<th class="no-sales">${h}</th>`));
    }
    expect(src).toMatch(/staffOnly\('<td>'\+escHtml\(it\.sku_number\|\|''\)\+'<\/td>'\)/);
    expect(src).toMatch(/staffOnly\('<td>'\+escHtml\(it\.web_order_number\|\|''\)\+'<\/td>'\)/);
  });
});

test('Sales page: Username after Name', async () => {
  const src = page('sales-list.html');
  expect(src).toMatch(/<th>Name<\/th><th>Username<\/th><th>Email<\/th>/);
  expect(src).toMatch(/'<td>'\+escHtml\(u\.username\|\|''\)\+'<\/td>'/);
  const list = (await admin.get('/api/sales')).body;
  expect(list[0]).toHaveProperty('username');
});
