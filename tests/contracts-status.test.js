'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
let nextSerial = 1;

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(() => {
  destroyTestApp(ctx);
});

/** In-stock contract (has a serial number from creation), $5000 grand total. */
function createInStockContract(agent, { paid = true } = {}) {
  return createContract(agent, {
    product: {
      status: 'instock', serialNumber: 'ZZTEST-SERIAL-' + (nextSerial++),
      make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso',
    },
    payment: paid ? { cheque: { selected: true, number: '1001', amount: '5000' } } : {},
    costing: { grandTotal: '5000' },
  });
}

/** To-Be-Ordered contract (no serial number yet), $5000 grand total. */
function createTBOContract(agent, { paid = true } = {}) {
  return createContract(agent, {
    product: {
      status: 'ordered', serialNumber: '',
      make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso',
    },
    payment: paid ? { cheque: { selected: true, number: '2002', amount: '5000' } } : {},
    costing: { grandTotal: '5000' },
  });
}

describe('PATCH /api/contracts/:id/status', () => {
  test('rejects an unrecognized status value', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createInStockContract(agent);

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'not-a-real-status' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid status');
  });

  test('a sales user can only move a contract to "scheduled", nothing else', async () => {
    const agent = await loginAgent(ctx.app); // default seeded 'sales' user
    const { contractId } = await createInStockContract(agent);

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only scheduling is allowed/);
  });

  test('blocks scheduling while a balance is still owed', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createInStockContract(agent, { paid: false }); // has a serial, $5000 unpaid

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({
      status: 'scheduled', scheduledDatetime: '2026-10-01T10:00',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Balance of \$5,000 must be cleared before scheduling/);
  });

  test('requires a serial number before scheduling, even with a zero balance', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createTBOContract(agent, { paid: true }); // fully paid, no serial yet

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({
      status: 'scheduled', scheduledDatetime: '2026-10-01T10:00',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Serial number required before scheduling/);
  });

  test('requires scheduledDatetime once balance and serial checks pass', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createInStockContract(agent, { paid: true });

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'scheduled' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Schedule date and time is required.');
  });

  test('successfully schedules a fully-paid, serialed contract', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await createInStockContract(agent, { paid: true });

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({
      status: 'scheduled', scheduledDatetime: '2026-10-01T10:00', scheduledDuration: 120, deliveryTeam: 'team_a',
    });

    expect(res.status).toBe(200);
    const contract = ctx.db.prepare('SELECT status, delivery_team FROM contracts WHERE id=?').get(contractId);
    expect(contract.status).toBe('scheduled');
    expect(contract.delivery_team).toBe('team_a');
  });

  test('rejects a second booking that overlaps an existing team booking', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const first  = await createInStockContract(agent, { paid: true });
    const second = await createInStockContract(agent, { paid: true });

    const bookFirst = await agent.patch(`/api/contracts/${first.contractId}/status`).send({
      status: 'scheduled', scheduledDatetime: '2026-10-02T09:00', scheduledDuration: 120, deliveryTeam: 'team_a',
    });
    expect(bookFirst.status).toBe(200);

    // Overlaps 09:00-11:00 on the same team.
    const bookSecond = await agent.patch(`/api/contracts/${second.contractId}/status`).send({
      status: 'scheduled', scheduledDatetime: '2026-10-02T10:00', scheduledDuration: 60, deliveryTeam: 'team_a',
    });

    expect(bookSecond.status).toBe(400);
    expect(bookSecond.body.error).toMatch(/already booked at this time/);
  });

  test('in-stock contracts cannot be moved to "received"', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createInStockContract(agent, { paid: true });

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'received' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/do not go through Received/);
  });

  test('"order_placed" is only reachable from "tbo", and requires both order fields', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });

    // Wrong originating status: an in-stock contract starts as 'assigned', not 'tbo'.
    const wrongStatus = await createInStockContract(agent, { paid: true });
    const wrongRes = await agent.patch(`/api/contracts/${wrongStatus.contractId}/status`).send({
      status: 'order_placed', webOrderNumber: 'WO-1', truckNumber: 'TR-1',
    });
    expect(wrongRes.status).toBe(400);
    expect(wrongRes.body.error).toMatch(/only reachable from To Be Ordered/);

    // Right originating status (tbo), but missing the required fields.
    const tbo = await createTBOContract(agent, { paid: false });
    const missingFieldsRes = await agent.patch(`/api/contracts/${tbo.contractId}/status`).send({ status: 'order_placed' });
    expect(missingFieldsRes.status).toBe(400);
    expect(missingFieldsRes.body.error).toBe('Web Order Number and Truck Number are required.');

    // Right status, both fields present — succeeds.
    const okRes = await agent.patch(`/api/contracts/${tbo.contractId}/status`).send({
      status: 'order_placed', webOrderNumber: 'WO-42', truckNumber: 'TR-7',
    });
    expect(okRes.status).toBe(200);
    const contract = ctx.db.prepare('SELECT status, web_order_number, truck_number FROM contracts WHERE id=?').get(tbo.contractId);
    expect(contract).toMatchObject({ status: 'order_placed', web_order_number: 'WO-42', truck_number: 'TR-7' });
  });

  test('delivered is a terminal status — no further changes allowed', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createInStockContract(agent, { paid: true });

    const deliver = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' });
    expect(deliver.status).toBe(200);

    const again = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/Delivered contracts cannot be changed/);
  });
});
