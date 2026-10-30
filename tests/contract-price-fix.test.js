'use strict';
// scripts/fix-contract-price.js — DHT2610PH00066: spa "20,0300" read as $200,300.
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');
const { planPriceFix, applyPriceFix } = require('../services/contractPriceFix');

let ctx, admin;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

test('recalculates subtotal, tax, Grand Total and balance; serial in capitals', async () => {
  const { contractId, contractNumber } = await createContract(admin, {
    product: { status: 'instock', serialNumber: 'geb25d2251040', make: 'Caldera', model: 'Geneva' },
    details: { spaPrice: '20,0300' },
    costing: { subtotal: '200300', taxPercent: '8.1', taxAmount: '16224.30', productTotal: '216524.30', grandTotal: '216524.3' },
    payment: { creditCard: { selected: true, lastFour: '1234', amount: '10962' } },
  });
  const plan = planPriceFix(ctx.db, contractNumber, 20300);
  expect(plan.after).toMatchObject({ spaPrice: '20300', subtotal: '20300', taxAmount: '1644.30',
    productTotal: '21944.30', grandTotal: '21944.30', balance: '10982.30', serial: 'GEB25D2251040' });

  applyPriceFix(ctx.db, plan);
  const c = ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);
  expect(c).toMatchObject({ grand_total: '21944.30', due_prior: '10982.30', paid_amount: '10962', serial_number: 'GEB25D2251040' });
  const d = JSON.parse(c.data);
  expect(d.details.spaPrice).toBe('20300');
  expect(d.costing.grandTotal).toBe('21944.30');
  expect(d.product.serialNumber).toBe('GEB25D2251040');

  // Payments now check against the corrected balance.
  const over = await admin.post('/api/payments').send({ contractId, amount: '11000', method: 'cash' });
  expect(over.body.error).toMatch(/exceeds remaining balance of \$10982\.30/);
});

test('refuses a contract whose subtotal doesn\'t contain the spa price', async () => {
  const { contractNumber } = await createContract(admin, { costing: { subtotal: '100', grandTotal: '5000' }, details: { spaPrice: '5000' } });
  expect(() => planPriceFix(ctx.db, contractNumber, 4000)).toThrow(/check this contract by hand/);
});
