'use strict';
// The spa on the Edit contract page (2026-11-05, services/contractSpa.js):
// an admin picks another spa, corrects the serial or switches In Stock ↔ To Be
// Ordered, and the card moves with the switch. Images can be added on the
// Edit page. Assign SI. No left the pages; Edit is in the card ⋮ menus.
const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, sales, drive;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
  drive = require('../services/driveInventory');
});
afterAll(() => { destroyTestApp(ctx); });

const row  = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const unit = serial => ctx.db.prepare('SELECT * FROM inventory WHERE upper(serial_number)=upper(?)').get(serial);
const addStock = (serial, extra = {}) => {
  const u = { make: 'TestMake', model: 'TestModel', shell: 'Grey', cabinet: 'Espresso', location: 'Phoenix Floor', ...extra };
  ctx.db.prepare(`INSERT INTO inventory (make, model, shell_color, cabinet_color, serial_number, availability, location)
    VALUES (?,?,?,?,?,'In-stock',?)`).run(u.make, u.model, u.shell, u.cabinet, serial, u.location);
};
const inStock = async serial => { addStock(serial); return createContract(admin, { product: {
  status: 'instock', serialNumber: serial, make: 'TestMake', model: 'TestModel', shellColor: 'Grey', cabinetColor: 'Espresso' } }); };
const toBeOrdered = (agent = admin, serialNumber = '') => createContract(agent, { product: { status: 'tbo', serialNumber, make: 'TestMake', model: 'TestModel' } });
// The Edit page's save: the contract's own form, the spa section and a
// page-side change (make / model / colours the page fills in from a picked spa).
const save = (agent, id, spa, change = () => {}) => {
  const form = JSON.parse(row(id).data);
  change(form);
  form.spa = spa;
  return agent.post(`/api/contracts/${id}/edit`).send({ form, reason: 'Customer changed their mind' });
};
const fromUnit = serial => form => {
  const u = unit(serial);
  Object.assign(form.product, { make: u.make, model: u.model, shellColor: u.shell_color, cabinetColor: u.cabinet_color });
};
const log = id => ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='CONTRACT_EDITED' ORDER BY id DESC").get(id)?.detail;

describe('In Stock: another spa', () => {
  test('a free In-stock spa asks first, then is linked; the old spa goes back; the card stays Assigned', async () => {
    const { contractId, contractNumber } = await inStock('ES-A');
    addStock('ES-B', { model: 'OtherModel', shell: 'Silver', location: 'Back Room' });
    const ask = await save(admin, contractId, { status: 'instock', serial: 'ES-B' });
    expect(ask.status).toBe(409);
    expect(ask.body).toEqual({ needsConfirm: true, message: `ES-B is in Inventory (TestMake OtherModel, Back Room). ${contractNumber} will be linked to it and it will be marked Sold.`
      + '\n\nContract spa details change: Model TestModel → OtherModel, Shell Grey → Silver.\n\nES-A goes back to stock.' });
    expect(unit('ES-A').contract_id).toBe(contractId); // nothing changed yet

    const res = await save(admin, contractId, { status: 'instock', serial: 'ES-B', confirmed: true }, fromUnit('ES-B'));
    expect(res.status).toBe(200);
    expect(res.body.movedTo).toBeNull();
    expect(row(contractId)).toMatchObject({ status: 'assigned', product_status: 'instock', serial_number: 'ES-B', model: 'OtherModel' });
    expect(unit('ES-B')).toMatchObject({ availability: 'Sold', contract_id: contractId });
    expect(unit('ES-A')).toMatchObject({ availability: 'In-stock', contract_id: null });
    expect(JSON.parse(row(contractId).data).product).toMatchObject({ serialNumber: 'ES-B', model: 'OtherModel', shellColor: 'Silver' });
    expect(log(contractId)).toBe('Serial ES-A → ES-B · ES-B linked from Inventory and marked Sold · Spa details: Model TestModel → OtherModel, Shell Grey → Silver'
      + ' · Returned to stock: ES-A — Reason: Customer changed their mind');
    expect(drive.updateInventoryItemField).toHaveBeenCalledWith('ES-B', 'availability', 'Sold');
    expect(drive.updateInventoryItemField).toHaveBeenCalledWith('ES-A', 'availability', 'In-stock');
  });

  test('not in Inventory: refused unless Add to Inventory was chosen, then added as Sold', async () => {
    const { contractId } = await inStock('NF-OLD');
    const no = await save(admin, contractId, { status: 'instock', serial: 'NF-NEW' });
    expect(no.status).toBe(400);
    expect(no.body).toEqual({ notFound: true, error: 'Serial NF-NEW isn\'t in Inventory — choose Add to Inventory, re-enter it, or switch to To Be Ordered.' });

    const res = await save(admin, contractId, { status: 'instock', serial: 'NF-NEW', confirmed: true, addToInventory: true, finance: 'Bank Owned' });
    expect(res.status).toBe(200);
    expect(unit('NF-NEW')).toMatchObject({ availability: 'Sold', contract_id: contractId, created_by_contract_id: contractId, finance: 'Bank Owned', model: 'TestModel' });
    expect(unit('NF-OLD')).toMatchObject({ availability: 'In-stock', contract_id: null });
    expect(drive.appendInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: 'NF-NEW', availability: 'Sold', finance: 'Bank Owned' }));
    expect(log(contractId)).toMatch(/^Serial NF-OLD → NF-NEW · NF-NEW added to Inventory as Sold \(Bank Owned\) · Returned to stock: NF-OLD/);
  });

  test('a spa sold to another contract, or not In-stock, is refused', async () => {
    const other = await inStock('SOLD-ELSE');
    const { contractId } = await inStock('MINE-1');
    expect((await save(admin, contractId, { status: 'instock', serial: 'sold-else', confirmed: true })).body.error)
      .toBe(`Serial SOLD-ELSE is already sold to ${other.contractNumber}.`);
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('TestMake','TestModel','DMG-1','Damaged')").run();
    expect((await save(admin, contractId, { status: 'instock', serial: 'DMG-1', confirmed: true })).body.error)
      .toBe('Spa DMG-1 is "Damaged" in Inventory, not In-stock — it can\'t be sold.');
    expect(row(contractId).serial_number).toBe('MINE-1');
  });
});

describe('switching In Stock ↔ To Be Ordered', () => {
  test('In Stock → To Be Ordered: the spa goes back, the serial is cleared, the card moves to To Be Ordered', async () => {
    drive.moveContractRowForSwitch.mockClear();
    const { contractId, contractNumber } = await inStock('SW-1');
    const res = await save(admin, contractId, { status: 'tbo', serial: '' }, f => { f.product.model = 'Bigger Model'; });
    expect(res.status).toBe(200);
    expect(res.body.movedTo).toBe('To Be Ordered');
    expect(row(contractId)).toMatchObject({ status: 'tbo', product_status: 'tbo', serial_number: null, model: 'Bigger Model' });
    expect(JSON.parse(row(contractId).data).product).toMatchObject({ status: 'tbo', serialNumber: '' });
    expect(unit('SW-1')).toMatchObject({ availability: 'In-stock', contract_id: null });
    expect(drive.moveContractRowForSwitch).toHaveBeenCalledWith(contractNumber, false, expect.objectContaining({ model: 'Bigger Model' }));
    expect(log(contractId)).toBe('In Stock → To Be Ordered (card Assigned → To Be Ordered) · Serial SW-1 → — · Returned to stock: SW-1'
      + ' · Model TestModel → Bigger Model — Reason: Customer changed their mind');
  });

  test('To Be Ordered → In Stock with a floor spa: linked, the card moves to Assigned', async () => {
    drive.moveContractRowForSwitch.mockClear();
    addStock('SW-FLOOR', { shell: 'Silver' });
    const { contractId, contractNumber } = await toBeOrdered(admin, 'wants blue');
    const ask = await save(admin, contractId, { status: 'instock', serial: 'SW-FLOOR' });
    expect(ask.body.message).toMatch(/The contract becomes In Stock and its card moves to Assigned\./);
    const res = await save(admin, contractId, { status: 'instock', serial: 'SW-FLOOR', confirmed: true }, fromUnit('SW-FLOOR'));
    expect(res.status).toBe(200);
    expect(res.body.movedTo).toBe('Assigned');
    expect(row(contractId)).toMatchObject({ status: 'assigned', product_status: 'instock', serial_number: 'SW-FLOOR' });
    expect(unit('SW-FLOOR')).toMatchObject({ availability: 'Sold', contract_id: contractId });
    expect(drive.moveContractRowForSwitch).toHaveBeenCalledWith(contractNumber, true, expect.objectContaining({ serialNumber: 'SW-FLOOR' }));
    expect(log(contractId)).toMatch(/^To Be Ordered → In Stock \(card To Be Ordered → Assigned\) · Serial wants blue → SW-FLOOR · SW-FLOOR linked from Inventory/);
  });

  test('Order Placed with a typed Web Order # and truck: the factory spa stays as on-order stock, the order numbers are cleared', async () => {
    addStock('OP-FLOOR');
    const { contractId } = await toBeOrdered();
    ctx.db.prepare("UPDATE contracts SET status='order_placed', web_order_number='WO-77', truck_number='T-9' WHERE id=?").run(contractId);
    const res = await save(admin, contractId, { status: 'instock', serial: 'OP-FLOOR', confirmed: true }, fromUnit('OP-FLOOR'));
    expect(res.status).toBe(200);
    expect(row(contractId)).toMatchObject({ status: 'assigned', product_status: 'instock', web_order_number: null, truck_number: null });
    expect(ctx.db.prepare("SELECT * FROM inventory WHERE web_order_number='WO-77'").get())
      .toMatchObject({ availability: 'Ordered', contract_id: null, truck_number: 'T-9', model: 'TestModel' });
    expect(log(contractId)).toMatch(/Factory spa kept as on-order stock \(Web Order # WO-77\) · Web Order # WO-77 \/ Truck # T-9 cleared/);
  });

  test('Order Placed with reserved on-order stock: the unit goes back to unreserved on-order stock', async () => {
    addStock('RES-FLOOR');
    const { contractId } = await toBeOrdered();
    const res0 = ctx.db.prepare("INSERT INTO inventory (make, model, availability, web_order_number, truck_number, contract_id) VALUES ('TestMake','TestModel','Ordered','WO-88','T-1',?)").run(contractId);
    ctx.db.prepare("UPDATE contracts SET status='order_placed', web_order_number='WO-88', truck_number='T-1' WHERE id=?").run(contractId);
    const res = await save(admin, contractId, { status: 'instock', serial: 'RES-FLOOR', confirmed: true }, fromUnit('RES-FLOOR'));
    expect(res.status).toBe(200);
    expect(ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(res0.lastInsertRowid)).toMatchObject({ availability: 'Ordered', contract_id: null });
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM inventory WHERE web_order_number='WO-88'").get().n).toBe(1); // no second unit
    expect(log(contractId)).toMatch(/Returned to stock: on-order stock \(Web Order # WO-88\)/);
  });

  test('In Stock without a spa is refused', async () => {
    const { contractId } = await toBeOrdered();
    const res = await save(admin, contractId, { status: 'instock', serial: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs its spa/);
    expect(row(contractId).status).toBe('tbo');
  });
});

describe('linking on-order stock (a spa on a truck)', () => {
  const addOrdered = (wo, truck, extra = {}) => ctx.db.prepare(`INSERT INTO inventory (make, model, shell_color, cabinet_color, availability, web_order_number, truck_number)
    VALUES (?,?,?,?,'Ordered',?,?)`).run(extra.make || 'TestMake', extra.model || 'TestModel', extra.shell || 'Grey', 'Espresso', wo, truck).lastInsertRowid;
  const ordered = id => ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
  const fromOrdered = id => form => { const u = ordered(id); Object.assign(form.product, { make: u.make, model: u.model, shellColor: u.shell_color, cabinetColor: u.cabinet_color }); };

  test('To Be Ordered: asks first, then the spa is reserved and the card moves to Order Placed with its numbers', async () => {
    drive.moveToOrderPlaced.mockClear();
    const unitId = addOrdered('WO-301', 'Truck-23', { shell: 'Silver' });
    const { contractId, contractNumber } = await toBeOrdered(admin, 'wants silver');
    const ask = await save(admin, contractId, { status: 'tbo', serial: '', orderedUnitId: unitId });
    expect(ask.status).toBe(409);
    expect(ask.body.message).toBe(`Reserve the on-order TestMake TestModel (Truck Truck-23, Web Order # WO-301) for ${contractNumber}?`
      + '\n\nThe contract takes its Web Order # and Truck # and its card moves to Order Placed.\n\nContract spa details change: Shell — → Silver, Cabinet — → Espresso.');
    expect(ordered(unitId).contract_id).toBeNull();

    const res = await save(admin, contractId, { status: 'tbo', serial: '', orderedUnitId: unitId, confirmed: true }, fromOrdered(unitId));
    expect(res.status).toBe(200);
    expect(res.body.movedTo).toBe('Order Placed');
    expect(row(contractId)).toMatchObject({ status: 'order_placed', product_status: 'tbo', web_order_number: 'WO-301', truck_number: 'Truck-23' });
    expect(ordered(unitId)).toMatchObject({ availability: 'Ordered', contract_id: contractId });
    expect(JSON.parse(row(contractId).data).product.orderedUnitId).toBe(Number(unitId));
    expect(drive.moveToOrderPlaced).toHaveBeenCalledWith(contractNumber, 'WO-301', 'Truck-23', expect.any(Object));
    expect(ctx.db.prepare("SELECT message FROM notifications WHERE contract_id=? AND event_type='ORDER_PLACED'").get(contractId).message)
      .toMatch(/order placed \(Web Order #WO-301\)/);
    expect(log(contractId)).toMatch(/^On-order stock reserved: Truck Truck-23 \/ Web Order # WO-301 \(card To Be Ordered → Order Placed\) · Serial wants silver → — · Spa details: Shell — → Silver/);
  });

  test('Order Placed with typed numbers (DHT2611GY00087): the picked spa replaces them — no extra on-order unit', async () => {
    const unitId = addOrdered('WO-302', 'Truck-23');
    const { contractId } = await toBeOrdered();
    ctx.db.prepare("UPDATE contracts SET status='order_placed', web_order_number='WO-302', truck_number='23' WHERE id=?").run(contractId);
    const res = await save(admin, contractId, { status: 'tbo', serial: '', orderedUnitId: unitId, confirmed: true }, fromOrdered(unitId));
    expect(res.status).toBe(200);
    expect(res.body.movedTo).toBeNull();
    expect(row(contractId)).toMatchObject({ status: 'order_placed', web_order_number: 'WO-302', truck_number: 'Truck-23' });
    expect(ordered(unitId).contract_id).toBe(contractId);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM inventory WHERE web_order_number='WO-302'").get().n).toBe(1);
    expect(log(contractId)).toMatch(/^On-order stock reserved: Truck Truck-23 \/ Web Order # WO-302 \(was Web Order # WO-302 \/ Truck # 23\)/);
  });

  test('Order Placed with a reserved spa: the old one goes back to on-order stock', async () => {
    const oldId = addOrdered('WO-303', 'T-1'), newId = addOrdered('WO-304', 'T-2');
    const { contractId } = await toBeOrdered();
    ctx.db.prepare('UPDATE inventory SET contract_id=? WHERE id=?').run(contractId, oldId);
    ctx.db.prepare("UPDATE contracts SET status='order_placed', web_order_number='WO-303', truck_number='T-1' WHERE id=?").run(contractId);
    const res = await save(admin, contractId, { status: 'tbo', serial: '', orderedUnitId: newId, confirmed: true }, fromOrdered(newId));
    expect(res.status).toBe(200);
    expect(ordered(oldId)).toMatchObject({ availability: 'Ordered', contract_id: null });
    expect(ordered(newId).contract_id).toBe(contractId);
    expect(row(contractId)).toMatchObject({ web_order_number: 'WO-304', truck_number: 'T-2' });
    expect(log(contractId)).toMatch(/Returned to stock: on-order stock \(Web Order # WO-303\)/);
  });

  test('refused on an In Stock or Received contract, for a spa already reserved, and for a salesperson', async () => {
    const unitId = addOrdered('WO-305', 'T-5');
    const assigned = await inStock('OO-INSTOCK');
    expect((await save(admin, assigned.contractId, { status: 'instock', serial: 'OO-INSTOCK', orderedUnitId: unitId, confirmed: true })).body.error)
      .toBe(`On-order stock can only be linked to a To Be Ordered or Order Placed contract — ${assigned.contractNumber} is Assigned.`);
    const other = await toBeOrdered();
    expect((await save(admin, other.contractId, { status: 'tbo', serial: '', orderedUnitId: unitId, confirmed: true })).status).toBe(200);
    const late = await toBeOrdered();
    expect((await save(admin, late.contractId, { status: 'tbo', serial: '', orderedUnitId: unitId, confirmed: true })).body.error)
      .toBe('That on-order spa isn\'t free on-order stock any more — search again.');
    const own = await toBeOrdered(sales);
    const unit2 = addOrdered('WO-306', 'T-6');
    expect((await save(sales, own.contractId, { status: 'tbo', serial: '', orderedUnitId: unit2, confirmed: true })).body.error).toBe('Nothing was changed.');
    expect(ordered(unit2).contract_id).toBeNull();
  });
});

describe('To Be Ordered serial box', () => {
  test('a remark is saved as typed; one naming a spa in Inventory is refused', async () => {
    const { contractId } = await toBeOrdered();
    const res = await save(admin, contractId, { status: 'tbo', serial: 'Customer wants Jan delivery' });
    expect(res.status).toBe(200);
    expect(row(contractId)).toMatchObject({ status: 'tbo', serial_number: 'Customer wants Jan delivery' });
    addStock('REMARK-SPA');
    expect((await save(admin, contractId, { status: 'tbo', serial: 'REMARK-SPA' })).body.error)
      .toBe('REMARK-SPA is a spa in Inventory (In-stock) — choose In Stock to sell it, or type something else.');
  });
});

describe('Received and Scheduled', () => {
  test('no switching, but a Scheduled contract can take another spa (Add to Inventory needed for a new serial)', async () => {
    const { contractId, contractNumber } = await inStock('SCH-1');
    ctx.db.prepare("UPDATE contracts SET status='scheduled' WHERE id=?").run(contractId);
    expect((await save(admin, contractId, { status: 'tbo', serial: '' })).body.error)
      .toBe(`${contractNumber} is Scheduled — In Stock / To Be Ordered can only be switched while it's Assigned, To Be Ordered or Order Placed.`);
    expect((await save(admin, contractId, { status: 'instock', serial: 'SCH-NEW' })).body.error)
      .toBe('Serial SCH-NEW isn\'t in Inventory — choose Add to Inventory, re-enter it.');
    addStock('SCH-2');
    const res = await save(admin, contractId, { status: 'instock', serial: 'SCH-2', confirmed: true });
    expect(res.status).toBe(200);
    expect(row(contractId)).toMatchObject({ status: 'scheduled', serial_number: 'SCH-2' });
    expect(unit('SCH-1')).toMatchObject({ availability: 'In-stock', contract_id: null });
  });

  test('Delivered: the spa can\'t be changed', async () => {
    const { contractId, contractNumber } = await inStock('DLV-1');
    ctx.db.prepare("UPDATE contracts SET status='delivered' WHERE id=?").run(contractId);
    expect((await save(admin, contractId, { status: 'instock', serial: 'DLV-2' })).body.error).toBe(`${contractNumber} is Delivered — its spa can't be changed.`);
  });
});

describe('a salesperson', () => {
  test('can\'t change the spa — the spa section is ignored', async () => {
    addStock('SALES-OWN');
    const { contractId } = await createContract(sales, { product: { status: 'instock', serialNumber: 'SALES-OWN', make: 'TestMake', model: 'TestModel', shellColor: 'Grey', cabinetColor: 'Espresso' } });
    const res = await save(sales, contractId, { status: 'tbo', serial: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing was changed.');
    expect(row(contractId)).toMatchObject({ status: 'assigned', serial_number: 'SALES-OWN' });
    expect(unit('SALES-OWN').contract_id).toBe(contractId);
  });
});

describe('images on the Edit page', () => {
  test('added with a label, saved into the contract folder and logged', async () => {
    const { contractId, contractNumber } = await toBeOrdered();
    const jpg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#88aacc' } }).jpeg().toBuffer();
    const payload = { form: JSON.parse(row(contractId).data), reason: 'Waiver signed later', newImageLabels: ['Waiver'] };
    const noLabel = await admin.post(`/api/contracts/${contractId}/edit`)
      .field('payload', JSON.stringify({ ...payload, newImageLabels: [''] })).attach('newImages', jpg, 'w.jpg');
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.error).toBe('Every new image needs a label.');

    const res = await admin.post(`/api/contracts/${contractId}/edit`).field('payload', JSON.stringify(payload)).attach('newImages', jpg, 'w.jpg');
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    const extras = JSON.parse(row(contractId).extra_images); // the signature is one of them
    expect(extras.map(e => e.label)).toEqual(['Customer Signature', 'Waiver']);
    const added = extras[1];
    expect(path.basename(added.path)).toBe('extra-2-Waiver.jpg');
    expect(path.dirname(added.path)).toBe(path.join(process.env.UPLOADS_DIR, 'contracts', contractNumber));
    expect(fs.existsSync(added.path)).toBe(true);
    expect(log(contractId)).toBe('Images added: Waiver — Reason: Waiver signed later');
    // Nothing left behind in the upload folder.
    expect(fs.readdirSync(path.join(process.env.UPLOADS_DIR, 'contracts')).filter(f => /newImages/.test(f))).toEqual([]);
  });
});

describe('the pages', () => {
  const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
  test('Edit in the card ⋮ menus (not on Delivered / Cancelled), and "Serial at receiving" on To Be Ordered / Order Placed', () => {
    const status = page('status.html');
    expect(status).toMatch(/const canEdit = canEditContract\(c\) && !isDelivered && !isCancelled;/);
    expect(status).toMatch(/if \(canEdit\)\n\s+menuItems\.push\('<a href="\/contracts\/'\+c\.id\+'\/edit">/);
    expect(status).toMatch(/const needsSerial = !c\.serial_number && \(isAssigned \|\| isReceived \|\| isScheduled\);/);
    expect(status).toMatch(/const serialLater = !c\.serial_number && \(isTBO \|\| isOrderPlaced\);/);
    expect(page('view-contracts.html')).toMatch(/\$\{canEditContract\(c\)&&!\['delivered','cancelled'\]\.includes\(c\.status\)\?`<a href="\/contracts\/\$\{c\.id\}\/edit">/);
  });
});
