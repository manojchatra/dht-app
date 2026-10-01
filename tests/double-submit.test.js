'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract, contractFormData } = require('./helpers/fixtures');
const { withLock } = require('../utils/asyncLock');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

describe('withLock', () => {
  test('two calls for the same key run strictly one after the other', async () => {
    const order = [];
    const a = withLock('k', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end'); return 'a'; });
    const b = withLock('k', async () => { order.push('b-start'); order.push('b-end'); return 'b'; });
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('calls for different keys are not serialized against each other', async () => {
    const order = [];
    const a = withLock('k1', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end'); });
    const b = withLock('k2', async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([a, b]);
    // b (no delay) finishes well before a's delayed resolution, proving they ran concurrently.
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  test('a rejection does not break the chain for the next call on the same key', async () => {
    const first = withLock('k3', async () => { throw new Error('boom'); });
    await expect(first).rejects.toThrow('boom');
    const second = await withLock('k3', async () => 'ok');
    expect(second).toBe('ok');
  });
});

describe('contract creation idempotency', () => {
  test('two POSTs with the same idempotencyKey create only one contract', async () => {
    const agent = await loginAgent(ctx.app);
    const formData = contractFormData({ idempotencyKey: 'idem-contract-1' });

    const r1 = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });
    const r2 = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });

    expect(r1.body.success).toBe(true);
    expect(r2.body.success).toBe(true);
    expect(r2.body.contractId).toBe(r1.body.contractId);
    expect(r2.body.contractNumber).toBe(r1.body.contractNumber);

    const rows = ctx.db.prepare('SELECT id FROM contracts WHERE idempotency_key=?').all('idem-contract-1');
    expect(rows).toHaveLength(1);
  });

  test('two POSTs with different (or no) idempotencyKey create two separate contracts, as before', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId: id1 } = await createContract(agent, { product: { status: 'instock', serialNumber: 'ZZDUP-A', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' } });
    const { contractId: id2 } = await createContract(agent, { product: { status: 'instock', serialNumber: 'ZZDUP-B', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' } });
    expect(id2).not.toBe(id1);
  });
});

describe('payment idempotency', () => {
  async function unpaidContract(agent, serial) {
    return createContract(agent, {
      product: { status: 'instock', serialNumber: serial, make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
      payment: {}, costing: { grandTotal: '5000' },
    });
  }

  test('two payment posts with the same idempotencyKey (a partial amount) record only one payment', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent, 'ZZPAY-IDEM-1');

    const body = { contractId, amount: 500, method: 'cash', idempotencyKey: 'idem-pay-1' };
    const r1 = await agent.post('/api/payments').send(body);
    const r2 = await agent.post('/api/payments').send(body);

    expect(r1.body.success).toBe(true);
    expect(r2.body.success).toBe(true);
    expect(r2.body.paymentId).toBe(r1.body.paymentId);
    expect(r2.body.totalPaid).toBe(500); // not 1000 — the second call did not insert again

    const rows = ctx.db.prepare('SELECT id FROM payments WHERE idempotency_key=?').all('idem-pay-1');
    expect(rows).toHaveLength(1);
  });

  test('two DIFFERENT partial payments (no idempotencyKey) for the same contract both record, as before', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent, 'ZZPAY-DIFF-1');

    const r1 = await agent.post('/api/payments').send({ contractId, amount: 500, method: 'cash' });
    const r2 = await agent.post('/api/payments').send({ contractId, amount: 300, method: 'cash' });

    expect(r1.body.success).toBe(true);
    expect(r2.body.success).toBe(true);
    expect(r2.body.paymentId).not.toBe(r1.body.paymentId);
    expect(r2.body.totalPaid).toBe(800);
  });

  test('concurrent requests for the same contract are serialized — two partial payments that together exceed balance: one succeeds, one is correctly rejected', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent, 'ZZPAY-RACE-1'); // $5000 balance

    const [r1, r2] = await Promise.all([
      agent.post('/api/payments').send({ contractId, amount: 3000, method: 'cash' }),
      agent.post('/api/payments').send({ contractId, amount: 3000, method: 'cash' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);
    const okRes = r1.status === 200 ? r1 : r2;
    expect(okRes.body.totalPaid).toBe(3000);

    const total = ctx.db.prepare('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE contract_id=?').get(contractId).t;
    expect(total).toBe(3000); // not 6000 — the lock prevented both from landing
  });
});

describe('status-change repeat guards', () => {
  async function receivedContract(agent, serial) {
    const { contractId } = await createContract(agent, {
      product: { status: 'ordered', serialNumber: '', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
      payment: { cheque: { selected: true, number: '1', amount: '5000' } }, costing: { grandTotal: '5000' },
    });
    await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'order_placed', webOrderNumber: 'WO-' + serial, truckNumber: 'TR-' + serial });
    const recv = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'received' });
    expect(recv.status).toBe(200);
    return contractId;
  }

  test('marking an already-received contract received again is rejected', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const contractId = await receivedContract(agent, 'ZZRECV-1');

    const again = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'received' });

    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already marked received/i);
  });

  test('cancelling an already-cancelled contract again is rejected', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createContract(agent, {
      product: { status: 'instock', serialNumber: 'ZZCANCEL-1', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
    });
    const first = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });
    expect(first.status).toBe(200);

    const again = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });

    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already cancelled/i);
  });

  test('two concurrent scheduling requests for the same contract do not both create a calendar event', async () => {
    const { createCalendarEvent } = require('../services/googleCalendar');
    createCalendarEvent.mockClear();
    createCalendarEvent.mockResolvedValue('evt-123');
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createContract(agent, {
      product: { status: 'instock', serialNumber: 'ZZSCHED-RACE-1', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
    });

    const body = { status: 'scheduled', scheduledDatetime: '2026-10-10T10:00', scheduledDuration: 120, deliveryTeam: 'team_a' };
    const [r1, r2] = await Promise.all([
      agent.patch(`/api/contracts/${contractId}/status`).send(body),
      agent.patch(`/api/contracts/${contractId}/status`).send({ ...body, scheduledDatetime: '2026-10-11T10:00' }),
    ]);

    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(createCalendarEvent).toHaveBeenCalledTimes(1); // not 2 — the lock serialized create-vs-update
    const row = ctx.db.prepare('SELECT calendar_event_id FROM contracts WHERE id=?').get(contractId);
    expect(row.calendar_event_id).toBe('evt-123');
  });
});
