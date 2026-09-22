'use strict';
const request  = require('supertest');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(() => {
  destroyTestApp(ctx);
});

/** A $5000 contract with no payment auto-seeded at creation (payment: {}). */
async function createUnpaidContract(agent) {
  return createContract(agent, { payment: {}, costing: { grandTotal: '5000' } });
}

describe('POST /api/payments', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(ctx.app)
      .post('/api/payments')
      .send({ contractId: 1, amount: 100, method: 'cash' });

    expect(res.status).toBe(401);
  });

  test('rejects a request missing contractId, amount, or method', async () => {
    const agent = await loginAgent(ctx.app);

    const res = await agent.post('/api/payments').send({ amount: 100, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contractId, amount and method are required/);
  });

  test('rejects amount:0 (caught by the required-fields check, since 0 is falsy)', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent);

    const res = await agent.post('/api/payments').send({ contractId, amount: 0, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contractId, amount and method are required/);
  });

  test('rejects a negative amount', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent);

    const res = await agent.post('/api/payments').send({ contractId, amount: -50, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Amount must be a positive number');
  });

  test('rejects an amount that exceeds the remaining balance', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent); // grandTotal 5000, nothing paid yet

    // The route allows a 1-cent floating-point tolerance over the balance,
    // so use an overage well past that to actually trigger the rejection.
    const res = await agent.post('/api/payments').send({ contractId, amount: 5001, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds remaining balance/);
  });

  test('records a partial payment and recalculates the remaining balance', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent);

    const res = await agent.post('/api/payments').send({ contractId, amount: 2000, method: 'cash' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalPaid).toBe(2000);
    expect(res.body.newBalance).toBe(3000);
    expect(res.body.fullyPaid).toBe(false);

    const contract = ctx.db.prepare('SELECT due_prior FROM contracts WHERE id=?').get(contractId);
    expect(contract.due_prior).toBe('3000');
  });

  test('a second payment that clears the balance sets fullyPaid=true', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent);

    await agent.post('/api/payments').send({ contractId, amount: 2000, method: 'cash' });
    const res = await agent.post('/api/payments').send({ contractId, amount: 3000, method: 'cheque', chequeNumber: '77' });

    expect(res.status).toBe(200);
    expect(res.body.totalPaid).toBe(5000);
    expect(res.body.newBalance).toBe(0);
    expect(res.body.fullyPaid).toBe(true);

    const contract = ctx.db.prepare('SELECT due_prior FROM contracts WHERE id=?').get(contractId);
    expect(contract.due_prior).toBe('0');
  });

  test('a payment that would exceed the balance after a prior payment is rejected', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent);

    await agent.post('/api/payments').send({ contractId, amount: 4000, method: 'cash' }); // balance now 1000

    const res = await agent.post('/api/payments').send({ contractId, amount: 1500, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds remaining balance of \$1000/);
  });
});

describe('GET /api/payments/contract/:contractId', () => {
  test('lists recorded payments and the running total', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createUnpaidContract(agent);

    await agent.post('/api/payments').send({ contractId, amount: 1200, method: 'cash' });
    await agent.post('/api/payments').send({ contractId, amount: 800,  method: 'cheque', chequeNumber: '42' });

    const res = await agent.get(`/api/payments/contract/${contractId}`);

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.totalPaid).toBe(2000);
  });
});
