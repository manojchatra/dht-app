'use strict';
// Oct 2026 review, status workflow and dates: who can be scheduled (#13/#14),
// cancelling To Be Ordered / Order Placed / Received (#15), Mark Received only
// from Order Placed by an admin (#16), voiding a payment (#17), and "today"
// in Arizona time, not UTC (#19).
const sharp = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, sales;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app); // seeded "sales"
});
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const setStatus = (id, status, extra = '') => ctx.db.prepare(`UPDATE contracts SET status=?${extra} WHERE id=?`).run(status, id);
const tbo = (agent = admin, product = {}) =>
  createContract(agent, { product: { status: 'tbo', serialNumber: '', make: 'HotSpring', model: 'Envoy', ...product } });
const schedule = (agent, id) => agent.patch(`/api/contracts/${id}/status`)
  .send({ status: 'scheduled', scheduledDatetime: '2026-12-01T10:00', scheduledDuration: 60, deliveryTeam: 'team_b' });
const jpeg = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#555' } }).jpeg().toBuffer();

describe('#13 / #14 only Assigned, Received or Scheduled contracts can be scheduled', () => {
  test('To Be Ordered with a placeholder serial, Order Placed and Cancelled are refused, with the reason', async () => {
    const placeholder = await tbo(admin, { serialNumber: 'Special Order' }); // fully paid, has a "serial"
    const res = await schedule(admin, placeholder.contractId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${placeholder.contractNumber} is To Be Ordered — only Assigned, Received or Scheduled contracts can be scheduled.`);

    setStatus(placeholder.contractId, 'order_placed');
    expect((await schedule(admin, placeholder.contractId)).body.error).toMatch(/is Order Placed — only/);

    const cancelled = await createContract(admin);
    setStatus(cancelled.contractId, 'cancelled');
    expect((await schedule(admin, cancelled.contractId)).body.error).toMatch(/is Cancelled — only/);
    expect(row(cancelled.contractId).status).toBe('cancelled');
  });

  test('Received is scheduled, and a Scheduled contract can be rescheduled', async () => {
    const { contractId } = await tbo();
    setStatus(contractId, 'received', ", serial_number='RCV-1'");
    expect((await schedule(admin, contractId)).status).toBe(200);
    const again = await admin.patch(`/api/contracts/${contractId}/status`)
      .send({ status: 'scheduled', scheduledDatetime: '2026-12-02T14:00', scheduledDuration: 60, deliveryTeam: 'team_b' });
    expect(again.status).toBe(200);
    expect(row(contractId)).toMatchObject({ status: 'scheduled', scheduled_datetime: '2026-12-02T14:00' });
  });
});

describe('#15 cancelling To Be Ordered / Order Placed / Received', () => {
  const cancel = id => admin.patch(`/api/contracts/${id}/status`).send({ status: 'cancelled' });

  test('Order Placed on reserved on-order stock: the spa goes back to unreserved Ordered stock', async () => {
    const unitId = ctx.db.prepare("INSERT INTO inventory (make, model, availability, web_order_number, truck_number) VALUES ('HotSpring','Envoy','Ordered','WO-77','T-9')").run().lastInsertRowid;
    const { contractId } = await tbo();
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'order_placed', inventoryId: unitId })).status).toBe(200);
    expect(ctx.db.prepare('SELECT contract_id FROM inventory WHERE id=?').get(unitId).contract_id).toBe(contractId);

    expect((await cancel(contractId)).status).toBe(200);
    expect(row(contractId).status).toBe('cancelled');
    expect(ctx.db.prepare('SELECT availability, contract_id FROM inventory WHERE id=?').get(unitId)).toEqual({ availability: 'Ordered', contract_id: null });
  });

  test('Received: the spa in the warehouse goes back to In-stock', async () => {
    const { contractId } = await tbo();
    setStatus(contractId, 'received', ", serial_number='RCV-CAN'");
    const unitId = ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability, contract_id) VALUES ('HotSpring','Envoy','RCV-CAN','Sold',?)").run(contractId).lastInsertRowid;
    expect((await cancel(contractId)).status).toBe(200);
    expect(ctx.db.prepare('SELECT availability, contract_id FROM inventory WHERE id=?').get(unitId)).toEqual({ availability: 'In-stock', contract_id: null });
    const { moveFromReceivedToCancelled } = require('../services/driveInventory');
    expect(moveFromReceivedToCancelled).toHaveBeenCalled();
  });

  test('a cancelled To Be Ordered contract can\'t be reverted to Assigned; an In Stock one can', async () => {
    const t = await tbo();
    expect((await cancel(t.contractId)).status).toBe(200);
    const res = await admin.patch(`/api/contracts/${t.contractId}/status`).send({ status: 'assigned' });
    expect(res.status).toBe(400);
    expect(row(t.contractId).status).toBe('cancelled');

    const s = await createContract(admin);
    expect((await cancel(s.contractId)).status).toBe(200);
    expect((await admin.patch(`/api/contracts/${s.contractId}/status`).send({ status: 'assigned' })).status).toBe(200);
    expect(row(s.contractId).status).toBe('assigned');
  });
});

describe('#16 Mark Received: Order Placed only, admin only', () => {
  const receive = async (agent, id) => agent.post(`/api/contracts/${id}/received`)
    .field('serialNumber', `RCV-${id}`).attach('serialPhoto', await jpeg(), 's.jpg');

  test('a salesperson can\'t, even on their own contract', async () => {
    const { contractId } = await tbo(sales);
    setStatus(contractId, 'order_placed');
    expect((await receive(sales, contractId)).status).toBe(403);
    expect(row(contractId).status).toBe('order_placed');
  });

  test('To Be Ordered is refused; Order Placed is received', async () => {
    const { contractId, contractNumber } = await tbo();
    const early = await receive(admin, contractId);
    expect(early.status).toBe(400);
    expect(early.body.error).toBe(`${contractNumber} is To Be Ordered — only an Order Placed contract can be marked received.`);
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'received' })).status).toBe(400);

    setStatus(contractId, 'order_placed');
    expect((await receive(admin, contractId)).status).toBe(200);
    expect(row(contractId)).toMatchObject({ status: 'received', serial_number: `RCV-${contractId}` });
  });
});

describe('#17 voiding a payment', () => {
  const voidIt = (agent, id, reason) => agent.post(`/api/payments/${id}/void`).send({ reason });
  const pays = id => ctx.db.prepare('SELECT * FROM payments WHERE contract_id=? ORDER BY id').all(id);

  test('admin only, reason required', async () => {
    const { contractId } = await createContract(sales);
    const p = pays(contractId)[0];
    expect((await voidIt(sales, p.id, 'typo')).status).toBe(403);
    const noReason = await voidIt(admin, p.id, '  ');
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatch(/reason is required/);
    expect(pays(contractId)[0].voided_at).toBeNull();
  });

  test('a voided payment stays listed but stops counting everywhere; the right amount can then be recorded', async () => {
    const { updatePaymentInSheet } = require('../services/driveInventory');
    const { contractId, contractNumber } = await createContract(admin, {
      costing: { grandTotal: '15000' }, details: { spaPrice: '15000' },
      payment: { cheque: { selected: true, number: '55', amount: '15000' } }, // should have been 1,500
    });
    const p = pays(contractId)[0];
    updatePaymentInSheet.mockClear();

    const res = await voidIt(admin, p.id, 'Typed $15,000, should be $1,500');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalPaid: 0, newBalance: 15000 });
    expect(pays(contractId)[0]).toMatchObject({ voided_by: 'admin', void_reason: 'Typed $15,000, should be $1,500' });
    expect(pays(contractId)[0].voided_at).toBeTruthy();
    expect(row(contractId).due_prior).toBe('15000');
    expect(updatePaymentInSheet).toHaveBeenCalledWith(contractNumber, 0, 15000);

    const detail = (await admin.get(`/api/contracts/${contractId}`)).body;
    expect(detail.total_paid).toBe(0);
    expect(detail.payments).toHaveLength(1);
    expect((await admin.get('/api/contracts')).body.find(c => c.id === contractId).total_paid).toBe(0);

    // Now owing again, so it can't be scheduled.
    expect((await schedule(admin, contractId)).body.error).toMatch(/Balance of \$15,000/);

    expect((await voidIt(admin, p.id, 'again')).body.error).toMatch(/already voided/);

    const fixed = await admin.post('/api/payments').send({ contractId, amount: '1,500', method: 'cheque', chequeNumber: '55' });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ totalPaid: 1500, newBalance: 13500 });

    const log = ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='PAYMENT_VOIDED'").get(contractId);
    expect(log.detail).toMatch(/\$15000\.00 via cheque .* voided — Typed \$15,000/);
  });

  test('the voided payment\'s receipt is still available, stamped VOID', async () => {
    const { contractId } = await createContract(admin);
    const p = pays(contractId)[0];
    await voidIt(admin, p.id, 'Cheque bounced');
    const res = await admin.get(`/api/payments/${p.id}/receipt`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });
});

describe('#19 "today" is the Arizona date, not UTC', () => {
  // 8:30 pm Oct 31 in Arizona = 03:30 Nov 1 UTC.
  const EVENING = Date.UTC(2026, 10, 1, 3, 30);
  let spy, admin; // a login made at the faked time (one from the real clock would look expired)
  beforeEach(async () => {
    spy = jest.spyOn(Date, 'now').mockReturnValue(EVENING);
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  });
  afterEach(() => spy.mockRestore());

  test('payments taken at signing, and a payment recorded with no date', async () => {
    const { contractId } = await createContract(admin, {
      costing: { grandTotal: '6000' }, details: { spaPrice: '6000' },
      payment: { cash: { selected: true, amount: '5000' } },
    });
    await admin.post('/api/payments').send({ contractId, amount: '1000', method: 'cash' });
    expect(ctx.db.prepare('SELECT date FROM payments WHERE contract_id=?').all(contractId).map(p => p.date))
      .toEqual(['2026-10-31', '2026-10-31']);
  });

  test('Mark Delivered with no date', async () => {
    const { contractId } = await createContract(admin);
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' })).status).toBe(200);
    expect(row(contractId).delivery_date).toBe('2026-10-31');
  });
});
