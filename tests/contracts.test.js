'use strict';
const request  = require('supertest');
const bcrypt   = require('bcryptjs');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData }  = require('./helpers/fixtures');

let ctx; // { app, db, tmpDir } — fresh SQLite DB + uploads dir for this whole file

beforeAll(() => {
  ctx = createTestApp();
});

afterAll(() => {
  destroyTestApp(ctx);
});

describe('POST /api/contracts', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(ctx.app)
      .post('/api/contracts')
      .send({ data: JSON.stringify(contractFormData()) });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  test('creates an in-stock contract and auto-seeds the cheque payment', async () => {
    const agent = await loginAgent(ctx.app); // default seeded 'sales' user

    const formData = contractFormData();
    const res = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.contractNumber).toMatch(/^DHT\d{4}PH\d{5}$/);

    const contract = ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(res.body.contractId);
    expect(contract.status).toBe('assigned');       // in-stock => assigned, not tbo
    expect(contract.due_prior).toBe('0');            // fully paid by the seeded cheque

    const payments = ctx.db.prepare('SELECT * FROM payments WHERE contract_id=?').all(res.body.contractId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'cheque', amount: 5000, cheque_number: '1001' });
  });

  test('rejects a cheque payment with no cheque number', async () => {
    const agent = await loginAgent(ctx.app);

    const formData = contractFormData();
    formData.payment.cheque.number = '';

    const res = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cheque number is required');
  });

  test('a non-in-stock product starts life as To Be Ordered (tbo)', async () => {
    const agent = await loginAgent(ctx.app);

    const formData = contractFormData();
    formData.product.status = 'ordered';
    formData.product.serialNumber = '';

    const res = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });

    expect(res.status).toBe(200);
    const contract = ctx.db.prepare('SELECT status FROM contracts WHERE id=?').get(res.body.contractId);
    expect(contract.status).toBe('tbo');
  });

  test('a sales user cannot attribute a contract to someone else', async () => {
    const agent = await loginAgent(ctx.app);
    const salesUser = ctx.db.prepare("SELECT id FROM users WHERE username='sales'").get();

    const formData = contractFormData();
    formData.salesmanUserId = 999999; // spoofed — should be ignored server-side

    const res = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });

    expect(res.status).toBe(200);
    const contract = ctx.db.prepare('SELECT salesman_user_id FROM contracts WHERE id=?').get(res.body.contractId);
    expect(contract.salesman_user_id).toBe(salesUser.id);
  });
});

describe('GET /api/contracts (role scoping)', () => {
  test('a sales user only sees their own contracts', async () => {
    // A second sales user, created directly in the DB.
    ctx.db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
      .run('sales2', bcrypt.hashSync('sales2pass', 10), 'sales');

    const agent1 = await loginAgent(ctx.app, { username: 'sales' });
    const agent2 = await loginAgent(ctx.app, { username: 'sales2', password: 'sales2pass' });

    const created = await agent1.post('/api/contracts').send({ data: JSON.stringify(contractFormData()) });
    expect(created.status).toBe(200);

    const asOwner   = await agent1.get('/api/contracts');
    const asOther   = await agent2.get('/api/contracts');

    expect(asOwner.body.some(c => c.id === created.body.contractId)).toBe(true);
    expect(asOther.body.some(c => c.id === created.body.contractId)).toBe(false);
  });
});

describe('DELETE /api/contracts/:id', () => {
  test('is forbidden for a sales user and allowed for an admin', async () => {
    const salesAgent = await loginAgent(ctx.app, { username: 'sales' });
    const adminAgent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });

    const created = await salesAgent.post('/api/contracts').send({ data: JSON.stringify(contractFormData()) });
    const contractId = created.body.contractId;

    const deniedRes = await salesAgent.delete(`/api/contracts/${contractId}`);
    expect(deniedRes.status).toBe(403);

    const okRes = await adminAgent.delete(`/api/contracts/${contractId}`);
    expect(okRes.status).toBe(200);

    const gone = ctx.db.prepare('SELECT id FROM contracts WHERE id=?').get(contractId);
    expect(gone).toBeUndefined();
  });
});
