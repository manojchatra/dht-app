'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT due_prior, paid_amount FROM contracts WHERE id=?').get(id);

describe('balances are saved rounded to cents', () => {
  test('a deposit leaving cents stores 0.09, not 0.0900000000000145', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createContract(agent, {
      payment: { cheque: { selected: true, number: '77', amount: '8767' } },
      costing: { grandTotal: '8767.09' },
    });
    expect(row(contractId).due_prior).toBe('0.09');
  });

  test('a later payment leaving cents stores the rounded balance', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createContract(agent, { payment: {}, costing: { grandTotal: '1000.3' } });

    const res = await agent.post('/api/payments').send({ contractId, amount: 1000.1, method: 'cash' });

    expect(res.status).toBe(200);
    expect(row(contractId).due_prior).toBe('0.2');
    const { updatePaymentInSheet } = require('../services/driveInventory');
    expect(updatePaymentInSheet).toHaveBeenLastCalledWith(expect.any(String), 1000.1, 0.2);
  });
});
