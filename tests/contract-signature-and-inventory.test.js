'use strict';
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const admin = () => loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
const unit = serial => ctx.db.prepare('SELECT * FROM inventory WHERE serial_number=?').get(serial);
const post = (agent, overrides) => agent.post('/api/contracts').send({ data: JSON.stringify(contractFormData(overrides)) });
let n = 0;
const product = (extra = {}) => ({ status: 'instock', serialNumber: `ZZSIG-${++n}`, make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso', ...extra });

describe('customer signature on a new contract', () => {
  test('is saved as a file in the contract folder, recorded in the contract, and listed with its images', async () => {
    const agent = await admin();
    const res = await post(agent, { product: product() });

    expect(res.status).toBe(200);
    const c = ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(res.body.contractId);
    const data = JSON.parse(c.data);
    expect(data.signature.file).toBe('sig-contract-customer.png');
    expect(data.signature.signedAt).toBeTruthy();
    expect(data.customerSignature).toBeUndefined(); // the image itself is not kept in the data blob
    const file = path.join(process.env.UPLOADS_DIR, 'contracts', c.contract_number, 'sig-contract-customer.png');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(c.extra_images).some(i => i.label === 'Customer Signature')).toBe(true);
  });

  test('is required for a new sale', async () => {
    const agent = await admin();
    const res = await post(agent, { product: product(), customerSignature: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Customer signature is required');
  });

  test('is not required for a back-entered contract (delivery date already past)', async () => {
    const agent = await admin();
    const res = await post(agent, { product: product(), deliveryDate: '2020-01-15', customerSignature: undefined });
    expect(res.status).toBe(200);
  });

  test('rejects anything that is not a PNG image', async () => {
    const agent = await admin();
    const notPng = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
    const res = await post(agent, { product: product(), customerSignature: notPng });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid signature image');
  });

  test('the contract PDF generates with the signature', async () => {
    const agent = await admin();
    const { contractId } = await createContract(agent, { product: product() });
    const res = await agent.get(`/api/contracts/${contractId}/pdf`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('inventory unit for a serial typed on the contract', () => {
  test('a serial not in inventory creates a Sold unit linked to the contract, with Finance', async () => {
    const agent = await admin();
    const p = product({ finance: 'Bank Owned' });
    const { contractId } = await createContract(agent, { product: p });

    const u = unit(p.serialNumber);
    expect(u).toMatchObject({ availability: 'Sold', contract_id: contractId, created_by_contract_id: contractId, finance: 'Bank Owned', make: 'TestMake' });
    expect(require('../services/driveInventory').appendInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: p.serialNumber, availability: 'Sold' }));
  });

  test('an unknown Finance value is ignored', async () => {
    const agent = await admin();
    const p = product({ finance: 'Something else' });
    await createContract(agent, { product: p });
    expect(unit(p.serialNumber).finance).toBeNull();
  });

  test('a back-entered To Be Ordered contract with a serial also gets its unit', async () => {
    const agent = await admin();
    const p = product({ status: 'tbo' });
    const { contractId } = await createContract(agent, { product: p, deliveryDate: '2020-02-01' });
    expect(unit(p.serialNumber)).toMatchObject({ availability: 'Sold', contract_id: contractId });
  });

  test('a current To Be Ordered contract does not (the warehouse creates it on receipt)', async () => {
    const agent = await admin();
    const p = product({ status: 'tbo' });
    await createContract(agent, { product: p });
    expect(unit(p.serialNumber)).toBeUndefined();
  });

  test('a serial already in inventory is linked, not duplicated', async () => {
    const agent = await admin();
    const serial = `ZZSIG-EXIST-${++n}`;
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability, finance) VALUES ('M','X',?, 'In-stock', 'DHT Owned')").run(serial);
    const { contractId } = await createContract(agent, { product: product({ serialNumber: serial }) });

    const rows = ctx.db.prepare('SELECT * FROM inventory WHERE serial_number=?').all(serial);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ availability: 'Sold', contract_id: contractId, created_by_contract_id: null, finance: 'DHT Owned' });
  });

  test('deleting the contract removes the unit it created', async () => {
    const agent = await admin();
    const p = product();
    const { contractId } = await createContract(agent, { product: p, deliveryDate: '2020-03-01' });
    expect(unit(p.serialNumber)).toBeTruthy();

    const res = await agent.delete(`/api/contracts/${contractId}`);

    expect(res.status).toBe(200);
    expect(unit(p.serialNumber)).toBeUndefined();
    expect(require('../services/driveInventory').deleteInventoryItem).toHaveBeenCalledWith(p.serialNumber);
  });

  test('deleting a contract keeps a unit that existed before it (back to In-stock if undelivered)', async () => {
    const agent = await admin();
    const serial = `ZZSIG-KEEP-${++n}`;
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('M','X',?, 'In-stock')").run(serial);
    const { contractId } = await createContract(agent, { product: product({ serialNumber: serial }) });

    await agent.delete(`/api/contracts/${contractId}`);

    expect(unit(serial)).toMatchObject({ availability: 'In-stock', contract_id: null });
  });

  test('a created unit released by a cancellation is kept when the contract is later deleted', async () => {
    const agent = await admin();
    const p = product();
    const { contractId } = await createContract(agent, { product: p });
    await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });
    expect(unit(p.serialNumber)).toMatchObject({ availability: 'In-stock', contract_id: null });

    await agent.delete(`/api/contracts/${contractId}`);

    expect(unit(p.serialNumber)).toBeTruthy();
  });

  test('serial-exists tells the form whether to ask for Finance', async () => {
    const agent = await admin();
    const p = product();
    await createContract(agent, { product: p });
    expect((await agent.get('/api/inventory/serial-exists').query({ serial: p.serialNumber })).body).toEqual({ exists: true });
    expect((await agent.get('/api/inventory/serial-exists').query({ serial: 'NOPE-123' })).body).toEqual({ exists: false });
  });
});
