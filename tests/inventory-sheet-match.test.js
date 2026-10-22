'use strict';
// Finding an on-order unit's row in the "Inventory Items" Sheet tab when one
// Web Order # covers a whole truck (services/inventorySheetMatch.js).
const { pickOrderedItemRow } = require('../services/inventorySheetMatch');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent } = require('./helpers/fixtures');

// Serial, SKU, Make, Series, Model, Shell, Cabinet, Availability, Location, Steps, Cover, Finance, Added, Speaker, WO, Truck
const row = (serial, make, model, shell, cabinet, wo, truck) => [serial, '', make, '', model, shell, cabinet, serial ? 'In-stock' : 'Ordered', '', '', '', '', '', '', wo, truck];
const HEADER = ['Serial Number'];
const WO = 'WEB300746790', T20 = 'DHT2026-20';
const unit = o => ({ make: 'HotSpring', model: 'Mini', shell_color: 'Dune', cabinet_color: 'Diamond', web_order_number: WO, truck_number: T20, ...o });

describe('pickOrderedItemRow', () => {
  const sheet = [
    HEADER,
    row('', 'HotSpring', 'SX', 'Tuscan', 'Coastal', WO, T20),        // row 2
    row('MIN-1', 'HotSpring', 'Mini', 'Dune', 'Diamond', WO, T20),   // row 3 — already received
    row('', 'HotSpring', 'Mini', 'Dune', 'Mosaic', WO, T20),         // row 4
    row('', 'Hotspring', 'Mini', 'Dune', 'Diamond', WO, T20),        // row 5 — make spelled differently
    row('', 'Caldera', 'Aventine', 'Arctic White', 'Ash', WO, T20),  // row 6
  ];

  test('skips rows that already have a serial and picks the matching model and colours', () => {
    expect(pickOrderedItemRow(sheet, unit())).toBe(5);
  });

  test('a different cabinet colour on the same truck gets its own row', () => {
    expect(pickOrderedItemRow(sheet, unit({ cabinet_color: 'Mosaic' }))).toBe(4);
  });

  test('another model on the same web order is never matched to the wrong row', () => {
    expect(pickOrderedItemRow(sheet, unit({ make: 'Caldera', model: 'Aventine', shell_color: 'Arctic White', cabinet_color: 'Ash' }))).toBe(6);
    expect(pickOrderedItemRow(sheet, unit({ model: 'Relay' }))).toBe(-1);
  });

  test('when colours differ from every row, still takes a same-model row', () => {
    expect([4, 5]).toContain(pickOrderedItemRow(sheet, unit({ shell_color: 'Pearl', cabinet_color: 'Storm' })));
  });

  test('no Web Order #: matched by Truck #', () => {
    const s = [HEADER, row('', 'HotSpring', 'Mini', 'Dune', 'Diamond', '', 'DHT2026-21')];
    expect(pickOrderedItemRow(s, unit({ web_order_number: '', truck_number: 'DHT2026-21' }))).toBe(2);
    expect(pickOrderedItemRow(s, unit({ web_order_number: '', truck_number: '' }))).toBe(-1);
  });
});

describe('Inventory page uses the unit to find its Sheet row', () => {
  let ctx, admin;
  beforeAll(async () => {
    ctx = createTestApp();
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  });
  afterAll(() => { destroyTestApp(ctx); });
  const drive = () => require('../services/driveInventory');
  const addOrdered = () => ctx.db.prepare(`INSERT INTO inventory (make, model, availability, web_order_number, truck_number)
    VALUES ('HotSpring','Mini','Ordered','WO-X','TRK-X')`).run().lastInsertRowid;

  test('receiving an on-order unit passes the unit (not just the web order)', async () => {
    const id = addOrdered();
    const res = await admin.patch(`/api/inventory-items/${id}/receive`).field('serialNumber', `SHEET-RCV-${id}`);
    expect(res.status).toBe(200);
    expect(drive().markInventoryItemReceivedInSheet).toHaveBeenCalledWith(expect.objectContaining({ id, model: 'Mini', web_order_number: 'WO-X' }), `SHEET-RCV-${id}`);
  });

  test('deleting an on-order unit removes its Sheet row by web order / make / model', async () => {
    const id = addOrdered();
    const res = await admin.delete(`/api/inventory-items/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.sheetSynced).toBe(true);
    expect(drive().deleteOrderedInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ id, web_order_number: 'WO-X' }));
  });
});
