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

/** Adds an In-stock DB inventory unit and returns its serial. */
function addStockUnit() {
  const serial = 'ZZTEST-REL-' + (nextSerial++);
  ctx.db.prepare(`INSERT INTO inventory (make, model, serial_number, availability) VALUES ('TestMake','TestModel',?,'In-stock')`).run(serial);
  return serial;
}

function unit(serial) {
  return ctx.db.prepare('SELECT availability, contract_id FROM inventory WHERE serial_number=?').get(serial);
}

/** Admin agent + an in-stock contract that picked `serial` (which marks the unit Sold). */
async function sellUnit(serial) {
  const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  const { contractId } = await createContract(agent, {
    product: { status: 'instock', serialNumber: serial, make: 'TestMake', model: 'TestModel' },
  });
  return { agent, contractId };
}

describe('Inventory release on cancel / delete', () => {
  test('picking an in-stock unit marks it Sold and links it', async () => {
    const serial = addStockUnit();
    const { contractId } = await sellUnit(serial);
    expect(unit(serial)).toEqual({ availability: 'Sold', contract_id: contractId });
  });

  test('cancelling the contract returns the unit to In-stock', async () => {
    const serial = addStockUnit();
    const { agent, contractId } = await sellUnit(serial);

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    expect(unit(serial)).toEqual({ availability: 'In-stock', contract_id: null });
  });

  test('reverting a cancellation re-claims the unit if it is still free', async () => {
    const serial = addStockUnit();
    const { agent, contractId } = await sellUnit(serial);
    await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' });

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'assigned' });

    expect(res.status).toBe(200);
    expect(unit(serial)).toEqual({ availability: 'Sold', contract_id: contractId });
  });

  test('reverting does not steal a unit that was sold to someone else meanwhile', async () => {
    const serial = addStockUnit();
    const first = await sellUnit(serial);
    await first.agent.patch(`/api/contracts/${first.contractId}/status`).send({ status: 'cancelled' });
    const second = await sellUnit(serial);

    const res = await first.agent.patch(`/api/contracts/${first.contractId}/status`).send({ status: 'assigned' });

    expect(res.status).toBe(200);
    expect(unit(serial)).toEqual({ availability: 'Sold', contract_id: second.contractId });
    const log = ctx.db.prepare(`SELECT detail FROM activity_log WHERE contract_id=? AND event_type='INVENTORY_RECLAIM'`).get(first.contractId);
    expect(log.detail).toMatch(/no longer available/);
  });

  test('deleting an undelivered contract returns the unit to In-stock', async () => {
    const serial = addStockUnit();
    const { agent, contractId } = await sellUnit(serial);

    const res = await agent.delete(`/api/contracts/${contractId}`);

    expect(res.status).toBe(200);
    expect(unit(serial)).toEqual({ availability: 'In-stock', contract_id: null });
  });

  test('deleting a delivered contract leaves the unit Sold (it is at the customer)', async () => {
    const serial = addStockUnit();
    const { agent, contractId } = await sellUnit(serial);
    await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' });

    const res = await agent.delete(`/api/contracts/${contractId}`);

    expect(res.status).toBe(200);
    expect(unit(serial)).toEqual({ availability: 'Sold', contract_id: null });
  });
});
