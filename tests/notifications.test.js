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

describe('GET /api/notifications', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(ctx.app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  test('is forbidden for a non-admin user', async () => {
    const agent = await loginAgent(ctx.app); // default seeded 'sales' user
    const res = await agent.get('/api/notifications');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin only');
  });

  test('an admin sees the CONTRACT_CREATED notification from a new contract', async () => {
    const salesAgent = await loginAgent(ctx.app);
    const adminAgent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });

    const { contractNumber } = await createContract(salesAgent);

    const res = await adminAgent.get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.some(n => n.event_type === 'CONTRACT_CREATED' && n.message.includes(contractNumber))).toBe(true);
  });

  test('auto-generates a FAILED_DELIVERY notification for a scheduled contract whose slot has passed', async () => {
    const salesAgent = await loginAgent(ctx.app);
    const adminAgent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });

    // Fully-paid, serialed in-stock contract so it's eligible to be scheduled.
    const { contractId, contractNumber } = await createContract(salesAgent, {
      product: {
        status: 'instock', serialNumber: 'ZZTEST-SERIAL-OVERDUE',
        make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso',
      },
      payment: { cheque: { selected: true, number: '9001', amount: '5000' } },
      costing: { grandTotal: '5000' },
    });

    // Schedule it for a slot safely in the past regardless of when this test runs.
    const schedule = await salesAgent.patch(`/api/contracts/${contractId}/status`).send({
      status: 'scheduled', scheduledDatetime: '2020-01-01T10:00', scheduledDuration: 60,
    });
    expect(schedule.status).toBe(200);

    const first = await adminAgent.get('/api/notifications');
    const overdueEntries = first.body.filter(n => n.event_type === 'FAILED_DELIVERY' && n.contract_num === contractNumber);
    expect(overdueEntries).toHaveLength(1);
    expect(overdueEntries[0].message).toMatch(/not delivered/);

    // A second fetch must not create a duplicate for the same contract.
    const second = await adminAgent.get('/api/notifications');
    const overdueAgain = second.body.filter(n => n.event_type === 'FAILED_DELIVERY' && n.contract_num === contractNumber);
    expect(overdueAgain).toHaveLength(1);
  });
});

describe('POST /api/notifications/:id/dismiss', () => {
  test('is forbidden for a non-admin user', async () => {
    const salesAgent = await loginAgent(ctx.app);
    const res = await salesAgent.post('/api/notifications/1/dismiss');
    expect(res.status).toBe(403);
  });

  test('dismissing a notification removes it from the active list', async () => {
    const salesAgent = await loginAgent(ctx.app);
    const adminAgent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });

    const { contractNumber } = await createContract(salesAgent);
    const before = await adminAgent.get('/api/notifications');
    const target = before.body.find(n => n.message.includes(contractNumber));
    expect(target).toBeDefined();

    const dismiss = await adminAgent.post(`/api/notifications/${target.id}/dismiss`);
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.success).toBe(true);

    const after = await adminAgent.get('/api/notifications');
    expect(after.body.some(n => n.id === target.id)).toBe(false);
  });
});
