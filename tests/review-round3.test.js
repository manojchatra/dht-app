'use strict';
// Oct 2026 review, #22–#30: receipts (#22), contract PDF refresh (#23),
// paid_amount (#24), one-at-a-time Sheet changes (#25), Assign SI. No and
// inventory (#26), manual vs nightly backups (#29), store / salesperson (#30).
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Mocked before the app loads, so the tests can see what the PDFs are built from.
jest.doMock('../utils/receiptGenerator', () => ({ generateReceiptPDF: jest.fn(async () => Buffer.from('%PDF-receipt')) }));
jest.doMock('../utils/pdfGenerator', () => ({ generateContractPDF: jest.fn(async () => Buffer.from('%PDF-contract')) }));

const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx, admin, sales;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
});
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const unit = id => ctx.db.prepare('SELECT availability, contract_id FROM inventory WHERE id=?').get(id);
const addStock = (serial, availability = 'In-stock', extra = {}) => ctx.db.prepare(
  'INSERT INTO inventory (make, model, serial_number, availability, location, contract_id, created_by_contract_id) VALUES (?,?,?,?,?,?,?)'
).run('HotSpring', 'Envoy', serial, availability, 'Back Room', extra.contractId || null, extra.createdBy || null).lastInsertRowid;
const tbo = () => createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'HotSpring', model: 'Envoy' } });

describe('#22 receipts', () => {
  test('show the customer name and the totals as of that payment, not today\'s', async () => {
    const { generateReceiptPDF } = require('../utils/receiptGenerator');
    const { contractId } = await createContract(admin, {
      costing: { grandTotal: '6000' }, details: { spaPrice: '6000' },
      payment: { cash: { selected: true, amount: '1000' } },
    });
    const first = ctx.db.prepare('SELECT id FROM payments WHERE contract_id=?').get(contractId).id;
    await admin.post('/api/payments').send({ contractId, amount: '2000', method: 'cash' });

    generateReceiptPDF.mockClear();
    const res = await admin.get(`/api/payments/${first}/receipt`);
    expect(res.status).toBe(200);
    const args = generateReceiptPDF.mock.calls[0][0];
    expect(args.contract.customer_name).toBe('Jane Test');
    expect(args).toMatchObject({ totalPaid: 1000, balance: 5000 }); // as after the first payment
  });
});

describe('#23 contract PDF', () => {
  test('is reused while the contract is unchanged, and rebuilt once it changes', async () => {
    const { generateContractPDF } = require('../utils/pdfGenerator');
    const { contractId } = await createContract(admin);
    // Last changed a while ago (updated_at is to the second; within the same
    // second as a change the PDF is always rebuilt, to be safe).
    ctx.db.prepare("UPDATE contracts SET updated_at=datetime('now','-10 seconds') WHERE id=?").run(contractId);
    generateContractPDF.mockClear();
    expect((await admin.get(`/api/contracts/${contractId}/pdf`)).status).toBe(200);
    expect((await admin.get(`/api/contracts/${contractId}/pdf`)).status).toBe(200);
    expect(generateContractPDF).toHaveBeenCalledTimes(1);

    // A later change (e.g. the serial filled in) — updated_at is after the saved copy.
    ctx.db.prepare("UPDATE contracts SET updated_at=datetime('now','+10 seconds') WHERE id=?").run(contractId);
    expect((await admin.get(`/api/contracts/${contractId}/pdf`)).status).toBe(200);
    expect(generateContractPDF).toHaveBeenCalledTimes(2);
  });
});

describe('#24 paid_amount', () => {
  test('follows every payment and void', async () => {
    const { contractId } = await createContract(admin, {
      costing: { grandTotal: '6000' }, details: { spaPrice: '6000' },
      payment: { cash: { selected: true, amount: '1000' } },
    });
    const pay = await admin.post('/api/payments').send({ contractId, amount: '1,500.50', method: 'cash' });
    expect(row(contractId).paid_amount).toBe('2500.5');
    await admin.post(`/api/payments/${pay.body.paymentId}/void`).send({ reason: 'duplicate' });
    expect(row(contractId)).toMatchObject({ paid_amount: '1000', due_prior: '5000' });
  });
});

describe('#25 Sheet changes run one at a time', () => {
  // The real module (not the app's mock) — loading googleapis can take a while.
  let _oneAtATime;
  beforeAll(() => { ({ _oneAtATime } = jest.requireActual('../services/driveInventory')); }, 60000);

  test('a second change waits for the first to finish', async () => {
    const log = [];
    const slow = _oneAtATime(async function slow(tag, ms) {
      log.push(`start ${tag}`); await new Promise(r => setTimeout(r, ms)); log.push(`end ${tag}`); return tag;
    });
    const failing = _oneAtATime(async function failing() { log.push('fail'); throw new Error('boom'); });
    const results = await Promise.allSettled([slow('a', 30), failing(), slow('b', 5)]);
    expect(log).toEqual(['start a', 'end a', 'fail', 'start b', 'end b']);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']); // one failure doesn't block the rest
  });
});

describe('#26 Assign SI. No checks inventory', () => {
  const assign = (id, serialNumber, linkInventory) => admin.patch(`/api/contracts/${id}/serial`).send({ serialNumber, linkInventory });

  test('a serial sold to another contract, or not In-stock, is refused', async () => {
    const other = await createContract(admin); // In Stock — its serial is linked to it
    const { contractId } = await tbo();
    const sold = await assign(contractId, row(other.contractId).serial_number.toLowerCase());
    expect(sold.status).toBe(409);
    expect(sold.body.error).toBe(`Serial ${row(other.contractId).serial_number} is already sold to ${other.contractNumber}.`);

    addStock('HOLD-26');
    ctx.db.prepare("UPDATE inventory SET availability='Hold' WHERE serial_number='HOLD-26'").run();
    expect((await assign(contractId, 'HOLD-26')).body.error).toMatch(/"Hold" in inventory, not In-stock/);
    expect(row(contractId).serial_number).toBeFalsy();
  });

  test('a free In-stock spa: asks first; Proceed links it and marks it Sold', async () => {
    const { updateTBOSerial, updateInventoryItemField } = require('../services/driveInventory');
    const { contractId, contractNumber } = await tbo();
    const id = addStock('FREE-26');

    const ask = await assign(contractId, 'FREE-26');
    expect(ask.status).toBe(409);
    expect(ask.body.needsConfirm).toBe(true);
    expect(ask.body.message).toBe(`FREE-26 is in inventory (HotSpring Envoy, Back Room). ${contractNumber} will be linked to this inventory item and it will be marked Sold.`);
    expect(unit(id)).toEqual({ availability: 'In-stock', contract_id: null }); // nothing changed yet
    expect(row(contractId).serial_number).toBeFalsy();

    updateTBOSerial.mockClear(); updateInventoryItemField.mockClear();
    const ok = await assign(contractId, 'FREE-26', true);
    expect(ok.status).toBe(200);
    expect(ok.body.linked).toBe(true);
    expect(unit(id)).toEqual({ availability: 'Sold', contract_id: contractId });
    expect(row(contractId).serial_number).toBe('FREE-26');
    expect(updateTBOSerial).toHaveBeenCalledWith(contractNumber, 'FREE-26');
    expect(updateInventoryItemField).toHaveBeenCalledWith('FREE-26', 'availability', 'Sold');
  });

  test('changing to another spa returns the old one to stock and removes a unit made for a typed serial', async () => {
    const { contractId } = await tbo();
    const oldId   = addStock('OLD-26', 'Sold', { contractId });
    const typedId = addStock('TYPO-26', 'Sold', { contractId, createdBy: contractId });
    const newId   = addStock('NEW-26');
    expect((await assign(contractId, 'NEW-26', true)).status).toBe(200);
    expect(unit(oldId)).toEqual({ availability: 'In-stock', contract_id: null });
    expect(unit(typedId)).toBeUndefined();
    expect(unit(newId)).toEqual({ availability: 'Sold', contract_id: contractId });
  });

  test('a serial not in inventory is just recorded, as before', async () => {
    const { contractId } = await tbo();
    const res = await assign(contractId, 'NOT-IN-INV-26');
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(row(contractId).serial_number).toBe('NOT-IN-INV-26');
  });
});

describe('#29 manual backups are kept apart from nightly ones', () => {
  test('each kind keeps its own number of copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dht-bk-'));
    const dbPath = path.join(dir, 'src.db');
    const Database = require('better-sqlite3');
    const src = new Database(dbPath); src.exec('CREATE TABLE t (x)'); src.close(); // a real DB to back up
    const old = Date.now() / 1000 - 86400;
    const touch = (name, i) => { const f = path.join(dir, name); fs.writeFileSync(f, ''); fs.utimesSync(f, old + i, old + i); };
    for (let i = 0; i < 14; i++) touch(`dht-app-2026-01-${String(i + 1).padStart(2, '0')}.db`, i);
    for (let i = 0; i < 10; i++) touch(`dht-app-manual-2026-01-${String(i + 1).padStart(2, '0')}.db`, i);
    const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, '../scripts/backup-db.js'), ...args],
      { env: { ...process.env, DB_PATH: dbPath, DB_BACKUP_DIR: dir }, stdio: 'pipe' });
    const count = manual => fs.readdirSync(dir).filter(f => f.startsWith('dht-app-') && f.startsWith('dht-app-manual-') === manual).length;

    run('--manual');
    expect([count(false), count(true)]).toEqual([14, 10]); // nightly untouched
    run();
    expect([count(false), count(true)]).toEqual([14, 10]);
    expect(fs.existsSync(path.join(dir, 'dht-app-2026-01-01.db'))).toBe(false);        // oldest nightly pruned
    expect(fs.existsSync(path.join(dir, 'dht-app-manual-2026-01-01.db'))).toBe(false); // oldest manual pruned
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('#30 store and salesperson', () => {
  const post = (agent, overrides) => agent.post('/api/contracts').send({ data: JSON.stringify(contractFormData(overrides)) });

  test('no valid store, or no salesperson, is refused', async () => {
    expect((await post(admin, { store: '' })).body.error).toBe('Store is required');
    expect((await post(admin, { store: 'Mesa' })).body.error).toBe('Store is required');
    expect((await post(admin, { salesman: '  ' })).body.error).toBe('Salesperson is required');
  });

  test('a salesperson who leaves it blank is the salesperson', async () => {
    const res = await post(sales, { salesman: '' });
    expect(res.status).toBe(200);
    expect(row(res.body.contractId).salesman).toBeTruthy();
  });

  test('a blank street address doesn\'t become "undefined" in the Sheet', async () => {
    const { writeToAssigned } = require('../services/driveInventory');
    writeToAssigned.mockClear();
    const base = contractFormData();
    const res = await post(admin, { customer: { ...base.customer, address: undefined, city: 'Mesa' } });
    expect(res.status).toBe(200);
    expect(writeToAssigned.mock.calls[0][0].address).toBe('Mesa');
  });
});
