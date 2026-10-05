'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const sync = () => require('../services/inventorySync');
const unit = serial => ctx.db.prepare('SELECT * FROM inventory WHERE serial_number=?').get(serial);
const insert = (serial, availability, location, contractId = null) =>
  ctx.db.prepare('INSERT INTO inventory (make, model, serial_number, availability, location, contract_id) VALUES (?,?,?,?,?,?)')
    .run('Make', 'Model', serial, availability, location, contractId);
const sheetRow = (serial, availability) => ({ Make: 'NewMake', Series: 'S', Model: 'NewModel', Shell: 'Grey', Cabinet: 'Brown', 'Serial Number': serial, Cover: '', Steps: '', Availability: availability });

describe('sync inventory from the stock sheet', () => {
  beforeAll(() => {
    insert('SYNC-STAY', 'In-stock', 'Warehouse');
    insert('SYNC-MOVE', 'In-stock', 'Warehouse');
    insert('SYNC-GONE', 'In-stock', 'Phoenix Floor');
    insert('SYNC-SOLD', 'Sold', 'Warehouse');
  });

  const sheet = () => [
    sheetRow('SYNC-STAY', 'Stock'),
    sheetRow('SYNC-MOVE', 'Chandler showroom'),
    sheetRow('SYNC-SOLD', 'Tolleson'),
    sheetRow('SYNC-NEW', 'EMP'),
    sheetRow('', 'Phoenix'),
  ];

  test('plans adds, moves and a report of units missing from the sheet — and changes nothing', () => {
    const before = ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
    const plan = sync().planInventorySync(sheet(), ctx.db.prepare('SELECT * FROM inventory').all());

    expect(plan.add.map(a => a.serialNumber)).toEqual(['SYNC-NEW']);
    expect(plan.add[0].location).toBe('EMP Room');
    expect(plan.move).toEqual([expect.objectContaining({ serialNumber: 'SYNC-MOVE', from: 'Warehouse', to: 'Chandler Floor' })]);
    expect(plan.notInSheet.map(u => u.serialNumber)).toContain('SYNC-GONE');
    expect(plan.noSerial).toBe(1);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM inventory').get().c).toBe(before);
  });

  test('applying adds and moves, never touches sold units or removes anything', async () => {
    const plan = sync().planInventorySync(sheet(), ctx.db.prepare('SELECT * FROM inventory').all());
    const appendInventoryItem = jest.fn().mockResolvedValue(null);
    const updateInventoryItemField = jest.fn().mockResolvedValue(null);

    const result = await sync().applyInventorySync(ctx.db, plan, { appendInventoryItem, updateInventoryItemField, delayMs: 0 });

    expect(result).toMatchObject({ added: 1, moved: 1 });
    expect(unit('SYNC-NEW')).toMatchObject({ availability: 'In-stock', location: 'EMP Room', make: 'NewMake' });
    expect(unit('SYNC-MOVE').location).toBe('Chandler Floor');
    expect(unit('SYNC-SOLD')).toMatchObject({ availability: 'Sold', location: 'Warehouse' });
    expect(unit('SYNC-GONE')).toMatchObject({ availability: 'In-stock' });
    expect(updateInventoryItemField).toHaveBeenCalledWith('SYNC-MOVE', 'location', 'Chandler Floor');
  });

  test('a second run finds nothing more to do', () => {
    const plan = sync().planInventorySync(sheet(), ctx.db.prepare('SELECT * FROM inventory').all());
    expect(plan.add).toHaveLength(0);
    expect(plan.move).toHaveLength(0);
  });
});

describe('backfill units for delivered contracts', () => {
  test('reports, then creates a Sold unit linked to each delivered contract missing one', async () => {
    const data = JSON.stringify({ product: { shellColor: 'Grey', cabinetColor: 'Brown' } });
    const add = (num, status, serial) => ctx.db.prepare(
      "INSERT INTO contracts (contract_number, status, serial_number, make, model, data) VALUES (?,?,?,'Mk','Md',?)").run(num, status, serial, data).lastInsertRowid;
    const delivered = add('DHTBF00001', 'delivered', 'BF-1');
    add('DHTBF00002', 'assigned', 'BF-2');      // not delivered — skipped
    add('DHTBF00003', 'delivered', 'SYNC-STAY'); // already in inventory — skipped

    const items = sync().planContractBackfill(ctx.db);
    expect(items.map(i => i.serialNumber)).toEqual(['BF-1']);
    expect(unit('BF-1')).toBeUndefined();

    await sync().applyContractBackfill(ctx.db, items, { appendInventoryItem: jest.fn().mockResolvedValue(null), delayMs: 0 });
    expect(unit('BF-1')).toMatchObject({ availability: 'Sold', contract_id: delivered, created_by_contract_id: delivered, shell_color: 'Grey' });
    expect(sync().planContractBackfill(ctx.db)).toHaveLength(0);
  });
});
