'use strict';
const bcrypt = require('bcryptjs');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

function makeUser(username, password, role) {
  ctx.db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
    .run(username, bcrypt.hashSync(password, 4), role);
}

async function ownedContractAndPayment(agent) {
  const { contractId } = await createContract(agent, { payment: {}, costing: { grandTotal: '5000' } });
  const pay = await agent.post('/api/payments').send({ contractId, amount: 1000, method: 'cash' });
  return { contractId, paymentId: pay.body.paymentId };
}

describe('routes/payments.js access control', () => {
  beforeAll(() => {
    makeUser('sales2', 'sales2pass', 'sales');
    makeUser('wh1', 'wh1pass', 'warehouse');
    makeUser('dl1', 'dl1pass', 'delivery');
  });

  test('a sales user cannot view, pay, or get a receipt for another salesman\'s contract', async () => {
    const owner = await loginAgent(ctx.app); // default sales
    const other = await loginAgent(ctx.app, { username: 'sales2', password: 'sales2pass' });
    const { contractId, paymentId } = await ownedContractAndPayment(owner);

    const list = await other.get(`/api/payments/contract/${contractId}`);
    expect(list.status).toBe(403);

    const pay = await other.post('/api/payments').send({ contractId, amount: 500, method: 'cash' });
    expect(pay.status).toBe(403);

    const receipt = await other.get(`/api/payments/${paymentId}/receipt`);
    expect(receipt.status).toBe(403);
  });

  test('warehouse and delivery roles are blocked from all payments routes', async () => {
    const owner = await loginAgent(ctx.app);
    const { contractId, paymentId } = await ownedContractAndPayment(owner);

    const wh = await loginAgent(ctx.app, { username: 'wh1', password: 'wh1pass' });
    const dl = await loginAgent(ctx.app, { username: 'dl1', password: 'dl1pass' });

    for (const agent of [wh, dl]) {
      expect((await agent.get(`/api/payments/contract/${contractId}`)).status).toBe(403);
      expect((await agent.post('/api/payments').send({ contractId, amount: 500, method: 'cash' })).status).toBe(403);
      expect((await agent.get(`/api/payments/${paymentId}/receipt`)).status).toBe(403);
    }
  });

  test('admin can view and pay across salesmen', async () => {
    const owner = await loginAgent(ctx.app);
    const admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId, paymentId } = await ownedContractAndPayment(owner);

    expect((await admin.get(`/api/payments/contract/${contractId}`)).status).toBe(200);
    expect((await admin.post('/api/payments').send({ contractId, amount: 500, method: 'cash' })).status).toBe(200);
    expect((await admin.get(`/api/payments/${paymentId}/receipt`)).status).toBe(200);
  });

  test('the owning sales user can still view, pay, and get a receipt for their own contract', async () => {
    const owner = await loginAgent(ctx.app);
    const { contractId, paymentId } = await ownedContractAndPayment(owner);

    expect((await owner.get(`/api/payments/contract/${contractId}`)).status).toBe(200);
    expect((await owner.post('/api/payments').send({ contractId, amount: 500, method: 'cash' })).status).toBe(200);
    expect((await owner.get(`/api/payments/${paymentId}/receipt`)).status).toBe(200);
  });

  test('receipt route 404s for a nonexistent payment id', async () => {
    const owner = await loginAgent(ctx.app);
    const res = await owner.get('/api/payments/999999/receipt');
    expect(res.status).toBe(404);
  });
});
