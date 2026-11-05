'use strict';
// Assign SI. No (Nov 2026): linking an inventory spa also takes its make /
// model / colours; a typed serial not in inventory adds a Sold unit on an
// Assigned or Scheduled contract (serial only on To Be Ordered); refused on
// Delivered / Cancelled. Since 2026-11-05 no page offers it (the spa is
// changed on Edit contract — tests/edit-spa.test.js); the API stays. New
// Contract's Inventory Search has an × that clears the pick.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

const row  = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const unit = serial => ctx.db.prepare('SELECT * FROM inventory WHERE upper(serial_number)=upper(?)').get(serial);
const addStock = (serial, extra = {}) => {
  const u = { make: 'TestMake', model: 'TestModel', shell: 'Grey', cabinet: 'Espresso', year: '', location: 'Phoenix Floor', ...extra };
  ctx.db.prepare(`INSERT INTO inventory (make, model, shell_color, cabinet_color, year, serial_number, availability, location)
    VALUES (?,?,?,?,?,?,'In-stock',?)`).run(u.make, u.model, u.shell, u.cabinet, u.year, serial, u.location);
};
const assign = (id, serialNumber, linkInventory) => admin.patch(`/api/contracts/${id}/serial`).send({ serialNumber, linkInventory });
const lastLog = id => ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='SERIAL_ASSIGNED' ORDER BY id DESC").get(id)?.detail;

describe('swapping the spa on an Assigned contract', () => {
  test('the new spa is linked and Sold, the old one freed, and the contract takes its model and colours', async () => {
    addStock('SWAP-A');
    addStock('SWAP-B', { model: 'OtherModel', shell: 'Silver', location: 'Back Room' });
    const { contractId, contractNumber } = await createContract(admin, { product: {
      status: 'instock', serialNumber: 'SWAP-A', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' } });
    expect(unit('SWAP-A')).toMatchObject({ availability: 'Sold', contract_id: contractId });

    const ask = await assign(contractId, 'swap-b');
    expect(ask.status).toBe(409);
    expect(ask.body.needsConfirm).toBe(true);
    expect(ask.body.message).toBe(`SWAP-B is in inventory (TestMake OtherModel, Back Room). ${contractNumber} will be linked to this inventory item and it will be marked Sold.`
      + '\n\nContract spa details change: Model TestModel → OtherModel, Shell Grey → Silver.'
      + '\n\nSWAP-A goes back to In-stock.');
    expect(row(contractId).serial_number).toBe('SWAP-A'); // nothing changed before Proceed

    const res = await assign(contractId, 'swap-b', true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linked: true, created: false, changed: ['Model', 'Shell'] });
    expect(unit('SWAP-B')).toMatchObject({ availability: 'Sold', contract_id: contractId });
    expect(unit('SWAP-A')).toMatchObject({ availability: 'In-stock', contract_id: null });
    const c = row(contractId), product = JSON.parse(c.data).product;
    expect(c).toMatchObject({ serial_number: 'swap-b', make: 'TestMake', model: 'OtherModel' });
    // Blank in inventory (year) keeps the contract's value; cabinet was the same.
    expect(product).toMatchObject({ serialNumber: 'swap-b', model: 'OtherModel', shellColor: 'Silver', cabinetColor: 'Espresso', year: '2026' });
    expect(lastLog(contractId)).toBe('Serial swap-b | Serial was: SWAP-A — linked to the inventory item and marked Sold'
      + ' | Spa details: Model TestModel → OtherModel, Shell Grey → Silver | Returned to stock: SWAP-A');
    expect(require('../services/driveInventory').updateContractRowInSheet).toHaveBeenCalled();
  });

  test('a spa with the same details links without a details line', async () => {
    addStock('SAME-A'); addStock('SAME-B');
    const { contractId } = await createContract(admin, { product: { status: 'instock', serialNumber: 'SAME-A', make: 'TestMake', model: 'TestModel', shellColor: 'Grey', cabinetColor: 'Espresso' } });
    const ask = await assign(contractId, 'SAME-B');
    expect(ask.body.message).not.toMatch(/details change/);
    expect((await assign(contractId, 'SAME-B', true)).body.changed).toEqual([]);
  });
});

describe('a typed serial that is not in inventory', () => {
  test('Assigned or Scheduled: a Sold unit is added and the old spa freed', async () => {
    addStock('TYPED-OLD');
    const { contractId } = await createContract(admin, { product: { status: 'instock', serialNumber: 'TYPED-OLD', make: 'TestMake', model: 'TestModel', shellColor: 'Grey', cabinetColor: 'Espresso' } });
    const res = await assign(contractId, 'TYPED-NEW-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linked: false, created: true });
    expect(unit('TYPED-NEW-1')).toMatchObject({ availability: 'Sold', contract_id: contractId, created_by_contract_id: contractId,
      make: 'TestMake', model: 'TestModel', shell_color: 'Grey', cabinet_color: 'Espresso' });
    expect(unit('TYPED-OLD')).toMatchObject({ availability: 'In-stock', contract_id: null });
    expect(require('../services/driveInventory').appendInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: 'TYPED-NEW-1', availability: 'Sold' }));

    // Typed again: the unit it added is replaced, not left behind.
    ctx.db.prepare("UPDATE contracts SET status='scheduled' WHERE id=?").run(contractId);
    expect((await assign(contractId, 'TYPED-NEW-2')).body.created).toBe(true);
    expect(unit('TYPED-NEW-1')).toBeUndefined();
    expect(unit('TYPED-NEW-2')).toMatchObject({ contract_id: contractId });
  });

  test('To Be Ordered: only the serial is saved (salespeople type remarks there)', async () => {
    const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'TestMake', model: 'TestModel' } });
    const res = await assign(contractId, 'Customer wants Jan delivery');
    expect(res.body).toMatchObject({ linked: false, created: false });
    expect(row(contractId).serial_number).toBe('Customer wants Jan delivery');
    expect(unit('Customer wants Jan delivery')).toBeUndefined();
  });
});

describe('refused where it would be wrong', () => {
  test('Delivered and Cancelled contracts keep their serial', async () => {
    addStock('CLOSED-FREE');
    for (const status of ['delivered', 'cancelled']) {
      const { contractId, contractNumber } = await createContract(admin);
      ctx.db.prepare('UPDATE contracts SET status=? WHERE id=?').run(status, contractId);
      const res = await assign(contractId, 'CLOSED-FREE', true);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`${contractNumber} is ${status === 'delivered' ? 'Delivered' : 'Cancelled'} — its serial can't be changed.`);
    }
    expect(unit('CLOSED-FREE')).toMatchObject({ availability: 'In-stock', contract_id: null });
  });

  test('a serial sold to another contract is still refused', async () => {
    addStock('TAKEN-X');
    const sold = await createContract(admin, { product: { status: 'instock', serialNumber: 'TAKEN-X', make: 'TestMake', model: 'TestModel' } });
    const { contractId } = await createContract(admin);
    const res = await assign(contractId, 'TAKEN-X', true);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`Serial TAKEN-X is already sold to ${sold.contractNumber}.`);
  });
});

describe('the pages', () => {
  const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

  test('no page offers Assign SI. No any more (Nov 2026 — the spa is changed on Edit contract)', () => {
    for (const name of ['view-contracts.html', 'status.html', 'contract-detail.html', 'js/util.js']) {
      expect(page(name)).not.toMatch(/Assign SI\. No|assignSerial|openDetailSerial|openSerialModal/);
    }
  });

  test('New Contract: the × clears the pick, serial included; the Edit page locks the search row for a salesperson', () => {
    const form = page('create-contract.html');
    expect(form).toMatch(/id="invClear" onclick="clearSpaSelection\(\)"/);
    const fn = form.slice(form.indexOf('function clearSpaSelection'), form.indexOf('function selectUnit'));
    expect(fn).toMatch(/'invTrigger','prodMake','prodSeries','prodModel','prodYear','prodSerial'/);
    expect(fn).toMatch(/confirmedSerial='';/);
    expect(fn).toMatch(/selectedOrderedUnitId=null;/);
    const edit = fs.readFileSync(path.join(__dirname, '../public/js/contract-edit.js'), 'utf8');
    expect(edit).toMatch(/var searchRow = \$\('invTrigger'\) && \$\('invTrigger'\)\.parentElement\.parentElement;/);
    expect(edit).toMatch(/lock\(searchRow, why\); lock\(\$\('prodSerial'\), why\);/);
  });
});
