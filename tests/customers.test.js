'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx, drive, admin;

beforeAll(async () => {
  ctx = createTestApp();
  drive = require('../services/driveInventory'); // the jest mock from createTestApp
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});

afterAll(() => {
  destroyTestApp(ctx);
});

/** TBO contract (no inventory side effects) for the given customer fields. */
function newContract(customer, extra = {}) {
  const base = contractFormData().customer;
  return createContract(admin, {
    customer: { ...base, ...customer },
    product: { status: 'ordered', serialNumber: '', make: 'Caldera', model: 'Utopia' },
    ...extra,
  });
}

function customerOf(contractId) {
  return ctx.db.prepare('SELECT cu.* FROM contracts c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?').get(contractId);
}

function postRaw(customer) {
  const formData = contractFormData({ customer: { ...contractFormData().customer, ...customer } });
  return admin.post('/api/contracts').send({ data: JSON.stringify(formData) });
}

describe('Phone numbers', () => {
  test('any typed format is stored as 602-112-2111', async () => {
    const { contractId } = await newContract({ phone: { cell: '(602) 112 2111', home: '+1 480.555.0000' } });
    const cu = customerOf(contractId);
    expect(cu.phone_cell).toBe('602-112-2111');
    expect(cu.phone_home).toBe('480-555-0000');
    const snap = JSON.parse(ctx.db.prepare('SELECT data FROM contracts WHERE id=?').get(contractId).data);
    expect(snap.customer.phone.cell).toBe('602-112-2111');
  });

  test('rejects a number that is not 10 digits', async () => {
    const res = await postRaw({ phone: { cell: '602-112-21111' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cell phone must be a 10-digit number/);
  });

  test('requires at least one of Cell, Home or Work', async () => {
    const none = await postRaw({ phone: {} });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/At least one phone number/);

    const workOnly = await postRaw({ phone: { work: '6021122111' } });
    expect(workOnly.status).toBe(200);
  });
});

describe('Customer number and linking', () => {
  test('each new customer gets the next DHT-C number', async () => {
    const a = customerOf((await newContract({ name: 'Num A', email: 'a@x.com' })).contractId);
    const b = customerOf((await newContract({ name: 'Num B', email: 'b@x.com' })).contractId);
    expect(a.customer_number).toMatch(/^DHT-C\d{5}$/);
    expect(parseInt(b.customer_number.slice(5), 10)).toBe(parseInt(a.customer_number.slice(5), 10) + 1);
  });

  test('a shared email no longer merges two different people', async () => {
    const one = await newContract({ name: 'Roger Smith', email: 'family@x.com' });
    const two = await newContract({ name: 'Mark Smith',  email: 'family@x.com' });
    expect(customerOf(one.contractId).id).not.toBe(customerOf(two.contractId).id);
    expect(customerOf(one.contractId).name).toBe('Roger Smith');
  });

  test('linking to an existing customer updates contact details but keeps the name', async () => {
    const first = await newContract({ name: 'Link Me', email: 'old@x.com', phone: { cell: '602-000-1111' } });
    const cust  = customerOf(first.contractId);

    const second = await newContract({
      existingCustomerId: cust.id, name: 'Typo Name', email: 'new@x.com', phone: { cell: '602-000-2222' },
      address: '9 Second Home Rd',
    });

    const linked = customerOf(second.contractId);
    expect(linked.id).toBe(cust.id);
    expect(linked.name).toBe('Link Me');
    expect(linked.email).toBe('new@x.com');
    expect(linked.phone_cell).toBe('602-000-2222');
    const log = ctx.db.prepare(`SELECT detail FROM activity_log WHERE contract_id=? AND event_type='CUSTOMER_LINKED'`).get(second.contractId);
    expect(log.detail).toContain(cust.customer_number);
    expect(log.detail).toContain('602-000-1111');

    // Each contract keeps its own delivery address in the list.
    const list = (await admin.get('/api/contracts')).body;
    expect(list.find(c => c.id === second.contractId).address).toBe('9 Second Home Rd');
    expect(list.find(c => c.id === first.contractId).address).toBe('123 Test St');
  });
});

describe('GET /api/customers/search', () => {
  test('matches by phone (any format) or email; the name only confirms a match', async () => {
    const { contractId } = await newContract({ name: 'Search Target', email: 'Target@X.com', phone: { home: '623-777-8888' } });
    const id = customerOf(contractId).id;

    const byPhone = (await admin.get('/api/customers/search').query({ phone: '(623) 777 8888' })).body.matches;
    expect(byPhone.find(m => m.id === id)).toMatchObject({ matchedOn: ['phone'], contractCount: 1 });

    const byEmail = (await admin.get('/api/customers/search').query({ email: 'target@x.com' })).body.matches;
    expect(byEmail.find(m => m.id === id).matchedOn).toEqual(['email']);

    const all = (await admin.get('/api/customers/search').query({ phone: '6237778888', email: 'target@x.com', name: ' search  TARGET ' })).body.matches;
    expect(all[0]).toMatchObject({ id, matchedOn: ['phone', 'email', 'name'] });

    const nameOnly = (await admin.get('/api/customers/search').query({ name: 'Search Target' })).body.matches;
    expect(nameOnly).toEqual([]);
  });

  test('returns at most 5 matches', async () => {
    for (let i = 0; i < 7; i++) await newContract({ name: 'Shared Phone ' + i, email: `shared${i}@x.com`, phone: { cell: '480-999-0000' } });
    const matches = (await admin.get('/api/customers/search').query({ phone: '4809990000' })).body.matches;
    expect(matches).toHaveLength(5);
  });

  test('is not available to warehouse users', async () => {
    ctx.db.prepare(`INSERT INTO users (username,password_hash,role) VALUES ('wh1', ?, 'warehouse')`)
      .run(require('bcryptjs').hashSync('wh123', 4));
    const wh = await loginAgent(ctx.app, { username: 'wh1', password: 'wh123' });
    const res = await wh.get('/api/customers/search').query({ name: 'anyone' });
    expect(res.status).toBe(403);
  });
});

describe('Deleting contracts', () => {
  test("deleting a customer's last contract deletes the customer; numbers are not reused", async () => {
    const { contractId } = await newContract({ name: 'Delete Me', email: 'del@x.com' });
    const cust = customerOf(contractId);

    const res = await admin.delete(`/api/contracts/${contractId}`);
    expect(res.body.customerDeleted).toBe(true);
    expect(ctx.db.prepare('SELECT id FROM customers WHERE id=?').get(cust.id)).toBeUndefined();

    const next = customerOf((await newContract({ name: 'After Delete', email: 'after@x.com' })).contractId);
    expect(next.customer_number).not.toBe(cust.customer_number);
  });

  test('a customer with another contract is kept', async () => {
    const first = await newContract({ name: 'Keep Me', email: 'keep@x.com' });
    const cust  = customerOf(first.contractId);
    const second = await newContract({ existingCustomerId: cust.id, name: 'Keep Me' });

    const res = await admin.delete(`/api/contracts/${second.contractId}`);
    expect(res.body.customerDeleted).toBe(false);
    expect(customerOf(first.contractId).id).toBe(cust.id);
  });
});

describe('Customer Record sheet tab', () => {
  test('a new contract writes its row; a status change updates it; delete removes it', async () => {
    drive.upsertCustomerRecordRow.mockClear();
    const { contractId, contractNumber } = await newContract({ name: 'Sheet Row', phone: { cell: '', home: '480-111-2222' }, city: 'Mesa' });
    const cust = customerOf(contractId);

    expect(drive.upsertCustomerRecordRow).toHaveBeenLastCalledWith({
      customerNumber: cust.customer_number, contractNumber, name: 'Sheet Row', phone: '480-111-2222',
      address: '123 Test St', city: 'Mesa', brand: 'Caldera', model: 'Utopia',
      serialNumber: '', deliveryDate: '', salesman: 'Michael Ioli', status: 'To Be Ordered',
    });

    await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });
    expect(drive.upsertCustomerRecordRow.mock.calls.at(-1)[0].status).toBe('Cancelled');

    await admin.delete(`/api/contracts/${contractId}`);
    expect(drive.deleteCustomerRecordRow).toHaveBeenLastCalledWith(contractNumber);
  });
});
