'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const admin = () => loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
let n = 0;
const product = () => ({ status: 'instock', serialNumber: `ZZBACK-${++n}`, make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' });
const feedback = { contacted: 1, send_review_email: 0, rating_delivery: 5, rating_installation: 5, rating_explanation: 5, rating_confidence: 5, rating_overall: 5 };

describe('back-entered contracts need no post-delivery follow-up', () => {
  let backId, normalId;

  beforeAll(async () => {
    const agent = await admin();
    // Contract date Jun 1, delivery date Jun 30 — entered afterwards, so saved straight to Delivered.
    backId = (await createContract(agent, { date: '2026-06-01', deliveryDate: '2026-06-30', product: product() })).contractId;
    // Contract date in the past but delivery still ahead — a normal sale, delivered later.
    normalId = (await createContract(agent, { date: '2026-06-01', product: product() })).contractId;
    await agent.patch(`/api/contracts/${normalId}/status`).send({ status: 'delivered' });
  });

  test('a contract saved with a past delivery date is flagged back-entered', () => {
    expect(ctx.db.prepare('SELECT status, back_entered FROM contracts WHERE id=?').get(backId)).toEqual({ status: 'delivered', back_entered: 1 });
    expect(ctx.db.prepare('SELECT back_entered FROM contracts WHERE id=?').get(normalId).back_entered).toBe(0);
  });

  test('it is left out of the follow-up lists; the normal delivery is in them', async () => {
    const agent = await admin();
    for (const url of ['/api/post-delivery/contracts', '/api/post-delivery/admin/list']) {
      const ids = (await agent.get(url)).body.map(r => r.id);
      expect(ids).not.toContain(backId);
      expect(ids).toContain(normalId);
    }
  });

  test('its feedback form and feedback submission are refused', async () => {
    const agent = await admin();
    expect((await agent.get(`/api/post-delivery/contract/${backId}`)).status).toBe(400);
    const res = await agent.post(`/api/post-delivery/feedback/${backId}`).send(feedback);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/back-entered/);
  });

  test('the normal delivery still accepts feedback', async () => {
    const agent = await admin();
    expect((await agent.get(`/api/post-delivery/contract/${normalId}`)).status).toBe(200);
    expect((await agent.post(`/api/post-delivery/feedback/${normalId}`).send(feedback)).status).toBe(200);
  });

  test('list rows carry the showroom and salesperson for the filters', async () => {
    const agent = await admin();
    const row = (await agent.get('/api/post-delivery/admin/list')).body.find(r => r.id === normalId);
    expect(row.store).toBe('Phoenix');
    expect(row.salesman_name).toBeTruthy();
  });
});
