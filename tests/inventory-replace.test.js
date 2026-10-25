'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const svc = () => require('../services/inventoryReplace');
const unit = serial => ctx.db.prepare('SELECT * FROM inventory WHERE serial_number=?').get(serial);
const insertUnit = (serial, availability, contractId = null) =>
  ctx.db.prepare('INSERT INTO inventory (make, model, serial_number, availability, location, contract_id) VALUES (?,?,?,?,?,?)')
    .run('OldMake', 'OldModel', serial, availability, 'Warehouse', contractId).lastInsertRowid;
const sheetRow = (o) => ({ 'Serial Number': '', Make: 'HotSpring', Series: 'Highlife', Model: 'Envoy', Year: 2026, 'Shell Color': 'Platinum',
  'Cabinet Color': 'Charcoal', Location: 'Warehouse', Finance: '', 'Truck Number': '', Weborder: '', Line: '', Bay: '', ...o });

describe('replace inventory from a new stock sheet', () => {
  let linkedContractId, sold, noUnit;

  beforeAll(async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    // A contract that picked an in-stock unit -> unit Sold + linked.
    insertUnit('KEEP-LINKED', 'In-stock');
    linkedContractId = (await createContract(agent, { product: { status: 'instock', serialNumber: 'KEEP-LINKED', make: 'M', model: 'X', year: '2026' } })).contractId;
    // A TBO contract whose received spa is on the contract but (by accident) not linked.
    sold = (await createContract(agent, { product: { status: 'ordered', serialNumber: '', make: 'M', model: 'Y' } })).contractId;
    ctx.db.prepare("UPDATE contracts SET serial_number='KEEP-BY-SERIAL', status='received' WHERE id=?").run(sold);
    insertUnit('KEEP-BY-SERIAL', 'Sold');
    insertUnit('OLD-INSTOCK', 'In-stock');
    insertUnit('OLD-HOLD', 'Hold');
    // A removed unit with photos whose serial is on the new sheet.
    const pid = insertUnit('PHOTO-1', 'In-stock');
    ctx.db.prepare("UPDATE inventory SET serial_photo_path='/x/serial.jpg', sku_photo_path='/x/sku.jpg' WHERE id=?").run(pid);
    // Sold spa that never had an inventory unit (contract made before units were auto-created).
    noUnit = (await createContract(agent, { product: { status: 'ordered', serialNumber: '', make: 'Caldera', model: 'Vanto', year: '2026' } })).contractId;
    ctx.db.prepare("UPDATE contracts SET serial_number='NO-UNIT-1', status='assigned' WHERE id=?").run(noUnit);
    // To Be Ordered with a placeholder "serial" — must not get a unit.
    const tbo = (await createContract(agent, { product: { status: 'ordered', serialNumber: '', make: 'M', model: 'Z' } })).contractId;
    ctx.db.prepare("UPDATE contracts SET serial_number='Special Order' WHERE id=?").run(tbo);
  });

  const sheet = () => svc().parseSheetRows([
    sheetRow({ 'Serial Number': 'NEW-1', Year: 2025, Location: 'EMP ', Finance: 'Bank Owned' }),
    sheetRow({ 'Serial Number': 'NEW-2', Location: 'Chandler Floor', Line: 'L3', Bay: 'B7' }),
    sheetRow({ 'Serial Number': 'KEEP-LINKED' }),                       // already sold — skipped
    sheetRow({ Model: 'Mini', 'Truck Number': 'DHT2026-20' }),           // no serial, on a truck -> Ordered
    sheetRow({ Model: 'Aria', Location: 'Tolleson Floor' }),            // no serial, no truck -> In-stock
    sheetRow({ 'Serial Number': 'PHOTO-1' }),                           // re-added: keeps its photos
    sheetRow({ 'Serial Number': 'NO-UNIT-1', Make: 'Caldera', Model: 'Vanto', Location: 'EMP', Finance: 'Bank Owned' }), // sold, no unit
  ]);

  test('the report keeps contract units, removes the rest, and changes nothing', () => {
    const before = ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
    const plan = svc().planReplace(ctx.db, sheet());

    expect(plan.keep.map(k => k.unit.serial_number).sort()).toEqual(['KEEP-BY-SERIAL', 'KEEP-LINKED']);
    expect(plan.remove.map(u => u.serial_number).sort()).toEqual(['OLD-HOLD', 'OLD-INSTOCK', 'PHOTO-1']);
    expect(plan.skipSold.map(s => s.item.serial).sort()).toEqual(['KEEP-LINKED', 'NO-UNIT-1']);
    expect(plan.add).toHaveLength(5);
    expect(plan.link.map(l => [l.item.serial, l.contract.id, l.fromSheet])).toEqual([['NO-UNIT-1', noUnit, true]]);
    expect(plan.blocking).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c).toBe(before);
  });

  test('a serial listed twice blocks the import', () => {
    const items = svc().parseSheetRows([sheetRow({ 'Serial Number': 'DUP-1' }), sheetRow({ 'Serial Number': 'DUP-1', Location: 'EMP' })]);
    const plan = svc().planReplace(ctx.db, items);
    expect(plan.blocking[0]).toMatch(/DUP-1 is listed more than once \(rows 2 and 3\)/);
    expect(() => svc().applyReplace(ctx.db, plan)).toThrow(/Blocking/);
  });

  test('applying replaces the list and never touches contract units', () => {
    const linkedBefore = unit('KEEP-LINKED');
    const result = svc().applyReplace(ctx.db, svc().planReplace(ctx.db, sheet()));

    expect(result).toEqual({ removed: 3, added: 5, linked: 1, photosKept: 1 });
    expect(unit('PHOTO-1')).toMatchObject({ availability: 'In-stock', serial_photo_path: '/x/serial.jpg', sku_photo_path: '/x/sku.jpg' });
    expect(unit('NO-UNIT-1')).toMatchObject({ availability: 'Sold', contract_id: noUnit, created_by_contract_id: noUnit, location: 'Back Room', finance: 'Bank Owned' });
    expect(unit('Special Order')).toBeUndefined();
    expect(unit('KEEP-LINKED')).toEqual(linkedBefore);
    expect(unit('KEEP-LINKED').contract_id).toBe(linkedContractId);
    expect(unit('KEEP-BY-SERIAL')).toBeTruthy();
    expect(unit('OLD-INSTOCK')).toBeUndefined();
    expect(unit('OLD-HOLD')).toBeUndefined();
    expect(unit('NEW-1')).toMatchObject({ availability: 'In-stock', year: '2025', location: 'Back Room', finance: 'Bank Owned' });
    expect(unit('NEW-2')).toMatchObject({ location: 'Chandler Floor', line: 'L3', bay: 'B7' });
    const noSerial = ctx.db.prepare("SELECT model, availability, truck_number FROM inventory WHERE serial_number IS NULL ORDER BY model").all();
    expect(noSerial).toEqual([
      { model: 'Aria', availability: 'In-stock', truck_number: '' },
      { model: 'Mini', availability: 'Ordered', truck_number: 'DHT2026-20' },
    ]);
  });
});

describe('add units from a sheet without replacing the inventory', () => {
  let soldOn;
  beforeAll(async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    insertUnit('ADD-EXISTS', 'In-stock');
    insertUnit('ADD-UNTOUCHED', 'Hold');
    soldOn = (await createContract(agent, { product: { status: 'ordered', serialNumber: '', make: 'Tylo', model: 'Kiruna' } })).contractId;
    ctx.db.prepare("UPDATE contracts SET serial_number='ADD-SOLD', status='assigned' WHERE id=?").run(soldOn);
  });

  const sheet = () => svc().parseSheetRows([
    sheetRow({ 'Serial Number': '', 'SKU Number': '9080-3050', Make: 'Tylo', Series: '', Model: 'Kiruna 2 IR' }),
    sheetRow({ 'Serial Number': '', 'SKU Number': '9080-3050', Make: 'Tylo', Series: '', Model: 'Kiruna 2 IR' }), // same SKU twice is fine
    sheetRow({ 'Serial Number': 'ADD-NEW', Make: 'Tylo', Model: 'Halmstad 2', Location: 'Phoenix Floor' }),
    sheetRow({ 'Serial Number': 'add-exists', Make: 'Tylo', Model: 'Lulea 3' }),   // already in inventory (any case) — skipped
    sheetRow({ 'Serial Number': 'ADD-SOLD', Make: 'Tylo', Model: 'Kiruna' }),       // on a contract — skipped
  ]);

  test('the report lists adds and skips, and changes nothing', () => {
    const before = ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
    const plan = svc().planAdd(ctx.db, sheet());
    expect(plan.add.map(i => i.serial || i.sku)).toEqual(['9080-3050', '9080-3050', 'ADD-NEW']);
    expect(plan.skipExisting.map(i => i.serial)).toEqual(['add-exists']);
    expect(plan.skipSold.map(s => s.item.serial)).toEqual(['ADD-SOLD']);
    expect(plan.blocking).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c).toBe(before);
  });

  test('a serial listed twice blocks the add', () => {
    const plan = svc().planAdd(ctx.db, svc().parseSheetRows([sheetRow({ 'Serial Number': 'TWICE' }), sheetRow({ 'Serial Number': 'TWICE' })]));
    expect(plan.blocking[0]).toMatch(/TWICE is listed more than once/);
    expect(() => svc().applyAdd(ctx.db, plan)).toThrow(/Blocking/);
  });

  test('applying adds the new units and leaves every existing unit alone', () => {
    const existing = ctx.db.prepare('SELECT * FROM inventory ORDER BY id').all();
    expect(svc().applyAdd(ctx.db, svc().planAdd(ctx.db, sheet()))).toEqual({ added: 3 });
    expect(ctx.db.prepare(`SELECT * FROM inventory WHERE id <= ? ORDER BY id`).all(existing[existing.length - 1].id)).toEqual(existing);
    expect(unit('ADD-NEW')).toMatchObject({ make: 'Tylo', availability: 'In-stock', location: 'Phoenix Floor', added_by: 'inventory-import' });
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM inventory WHERE sku_number='9080-3050' AND serial_number IS NULL AND availability='In-stock'").get().c).toBe(2);
    expect(unit('ADD-SOLD')).toBeUndefined();
  });
});

describe('Year, Line and Bay on inventory units', () => {
  let warehouse, admin, id;
  beforeAll(async () => {
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    await admin.post('/api/users').send({ username: 'wh1', password: 'Secret123', role: 'warehouse', name: 'WH', email: 'wh@example.com' });
    warehouse = await loginAgent(ctx.app, { username: 'wh1', password: 'Secret123' });
    const res = await admin.post('/api/inventory-items').field('make', 'Caldera').field('model', 'Vanto')
      .field('serialNumber', 'YLB-1').field('year', '2026').field('line', 'L1').field('bay', 'B2');
    expect(res.status).toBe(200);
    id = res.body.id || unit('YLB-1').id;
  });

  test('Add to Inventory saves year, line and bay', () => {
    expect(unit('YLB-1')).toMatchObject({ year: '2026', line: 'L1', bay: 'B2' });
  });

  test('warehouse can change Line and Bay', async () => {
    const res = await warehouse.patch(`/api/inventory-items/${id}`).send({ line: 'L9', bay: 'B4' });
    expect(res.status).toBe(200);
    expect(unit('YLB-1')).toMatchObject({ line: 'L9', bay: 'B4' });
  });

  test('warehouse cannot change anything else', async () => {
    const res = await warehouse.patch(`/api/inventory-items/${id}`).send({ bay: 'B5', finance: 'Bank Owned' });
    expect(res.status).toBe(403);
    expect(unit('YLB-1')).toMatchObject({ bay: 'B4', finance: null });
  });

  test('admin can change the year', async () => {
    expect((await admin.patch(`/api/inventory-items/${id}`).send({ year: '2025' })).status).toBe(200);
    expect(unit('YLB-1').year).toBe('2025');
  });

  test('the contract inventory search returns the year', async () => {
    const res = await admin.get('/api/inventory/search').query({ q: 'vanto' });
    expect(res.body.results.find(r => r.serial_number === 'YLB-1').year).toBe('2025');
  });
});
