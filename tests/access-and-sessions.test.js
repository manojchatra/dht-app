'use strict';
// Oct 2026 review: who can see contracts (#7), logins re-checked and kept in
// the database (#8), deleting a salesperson with contracts (#9), "not
// delivered" alerts (#18), leftovers (#31), email certificate check (#32),
// serial numbers matched whatever the capitals and unique (#33).
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx, admin, sales, deliveryA, warehouse;
const userId = username => ctx.db.prepare('SELECT id FROM users WHERE username=?').get(username).id;

beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
  await admin.post('/api/users').send({ username: 'drv-a', password: 'Secret123', role: 'delivery', team: 'team_a', name: 'Driver A', email: 'a@example.com' });
  await admin.post('/api/users').send({ username: 'wh-1', password: 'Secret123', role: 'warehouse', name: 'WH', email: 'w@example.com' });
  deliveryA = await loginAgent(ctx.app, { username: 'drv-a', password: 'Secret123' });
  warehouse = await loginAgent(ctx.app, { username: 'wh-1', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

describe('#7 contracts are for admin and sales only', () => {
  test('delivery and warehouse can\'t list, open or create contracts, or use the spa search', async () => {
    const { contractId } = await createContract(admin);
    for (const agent of [deliveryA, warehouse]) {
      expect((await agent.get('/api/contracts')).status).toBe(403);
      expect((await agent.get(`/api/contracts/${contractId}`)).status).toBe(403);
      expect((await agent.post('/api/contracts').send({ data: JSON.stringify(contractFormData()) })).status).toBe(403);
      expect((await agent.get('/api/inventory/search').query({ q: 'x' })).status).toBe(403);
    }
    expect((await sales.get('/api/contracts')).status).toBe(200);
  });

  test('email recipients and review links in Settings are admin only; tax rates stay readable', async () => {
    expect((await sales.get('/api/settings/email-recipients')).status).toBe(403);
    expect((await deliveryA.get('/api/settings/review-urls')).status).toBe(403);
    expect((await sales.get('/api/settings/tax-rates')).status).toBe(200);
    expect((await admin.get('/api/settings/email-recipients')).status).toBe(200);
  });

  test('the delivery calendar lists the team\'s bookings (and unassigned ones) without prices', async () => {
    const mk = async (team, slot) => {
      const { contractId } = await createContract(admin);
      ctx.db.prepare("UPDATE contracts SET status='scheduled', delivery_team=?, scheduled_datetime=? WHERE id=?").run(team, slot, contractId);
      return contractId;
    };
    const mine = await mk('team_a', '2026-12-01T09:00'), theirs = await mk('team_b', '2026-12-01T11:00'), open = await mk(null, '2026-12-01T13:00');
    const res = await deliveryA.get('/api/delivery/calendar');
    expect(res.status).toBe(200);
    const ids = res.body.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining([mine, open]));
    expect(ids).not.toContain(theirs);
    const row = res.body.find(c => c.id === mine);
    expect(row).toMatchObject({ customer_name: 'Jane Test', city: 'Phoenix', delivery_team: 'team_a' });
    for (const k of ['grand_total', 'paid_amount', 'due_prior', 'total_paid', 'data']) expect(row).not.toHaveProperty(k);
    expect((await admin.get('/api/delivery/calendar')).body.map(c => c.id)).toContain(theirs);
  });
});

describe('#8 logins', () => {
  test('a deactivated account is logged out on its next request; a role change applies at once', async () => {
    await admin.post('/api/sales').send({ username: 'sales-x', password: 'Secret123', name: 'Sales X', email: 'x@example.com' });
    const x = await loginAgent(ctx.app, { username: 'sales-x', password: 'Secret123' });
    expect((await x.get('/api/contracts')).status).toBe(200);
    expect((await x.get('/api/users')).status).toBe(403);

    ctx.db.prepare("UPDATE users SET role='admin' WHERE username='sales-x'").run();
    expect((await x.get('/api/users')).status).toBe(200);
    ctx.db.prepare("UPDATE users SET role='sales' WHERE username='sales-x'").run();

    await admin.patch(`/api/sales/${userId('sales-x')}/active`).send({ active: 0 });
    expect((await x.get('/api/contracts')).status).toBe(401);
    expect((await x.get('/auth/me')).status).toBe(401);
  });

  test('logins are stored in the database, so a restart keeps them', async () => {
    const id = userId('sales');
    const rows = ctx.db.prepare("SELECT expires FROM sessions WHERE json_extract(data,'$.userId')=?").all(id);
    expect(rows.length).toBeGreaterThan(0);
    // ~6 hours from login, not from the last click.
    expect(rows[0].expires - Date.now()).toBeLessThanOrEqual(6 * 3600000);
    // A fresh store on the same database (what a restart creates) still finds it.
    const { SqliteSessionStore } = require('../utils/sqliteSessionStore');
    const sid = ctx.db.prepare('SELECT sid FROM sessions LIMIT 1').get().sid;
    const found = await new Promise(r => new SqliteSessionStore(ctx.db).get(sid, (e, s) => r(s)));
    expect(found).toHaveProperty('userId');
  });
});

describe('#9 deleting a salesperson who has contracts', () => {
  test('asks first, then deletes; the contracts stay with the name, unlinked', async () => {
    await admin.post('/api/sales').send({ username: 'sales-gone', password: 'Secret123', name: 'Gone Person', email: 'g@example.com' });
    const gone = await loginAgent(ctx.app, { username: 'sales-gone', password: 'Secret123' });
    const { contractId } = await createContract(gone, { salesman: 'Gone Person' });
    const id = userId('sales-gone');

    const ask = await admin.delete(`/api/users/${id}`);
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ needsConfirm: true, contracts: 1 });
    expect(ask.body.message).toMatch(/^Gone Person has 1 contract\. They are kept and still show Gone Person/);

    const res = await admin.delete(`/api/users/${id}?confirm=1`);
    expect(res.status).toBe(200);
    expect(ctx.db.prepare('SELECT id FROM users WHERE id=?').get(id)).toBeUndefined();
    expect(ctx.db.prepare('SELECT salesman, salesman_user_id FROM contracts WHERE id=?').get(contractId))
      .toEqual({ salesman: 'Gone Person', salesman_user_id: null });
    expect((await gone.get('/api/contracts')).status).toBe(401);
  });

  test('a user with no contracts is deleted straight away', async () => {
    await admin.post('/api/sales').send({ username: 'sales-none', password: 'Secret123', name: 'No Deals', email: 'n@example.com' });
    expect((await admin.delete(`/api/users/${userId('sales-none')}`)).status).toBe(200);
  });
});

describe('#18 "not delivered" alerts', () => {
  test('stay above the 10 normal notifications, aren\'t recreated, and go once the delivery is dealt with', async () => {
    const { addNotification } = require('../utils/activityLogger');
    const { contractId } = await createContract(admin);
    ctx.db.prepare("UPDATE contracts SET status='scheduled', scheduled_datetime='2020-01-01T09:00' WHERE id=?").run(contractId);
    const failedFor = list => list.filter(n => n.event_type === 'FAILED_DELIVERY' && n.contract_id === contractId);

    expect(failedFor((await admin.get('/api/notifications')).body)).toHaveLength(1);
    for (let i = 0; i < 15; i++) addNotification(ctx.db, { eventType: 'PAYMENT', message: `x${i}` });
    const list = (await admin.get('/api/notifications')).body;
    expect(list[0]).toMatchObject({ event_type: 'FAILED_DELIVERY', contract_id: contractId });
    expect(list.filter(n => n.event_type !== 'FAILED_DELIVERY')).toHaveLength(10);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM notifications WHERE contract_id=? AND event_type='FAILED_DELIVERY'").get(contractId).n).toBe(1);

    // Rescheduled and missed again → a new alert for the new slot.
    ctx.db.prepare("UPDATE contracts SET scheduled_datetime='2020-02-01T09:00' WHERE id=?").run(contractId);
    expect(failedFor((await admin.get('/api/notifications')).body)).toHaveLength(1);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM notifications WHERE contract_id=? AND event_type='FAILED_DELIVERY'").get(contractId).n).toBe(2);

    // Delivered → the alert goes.
    ctx.db.prepare("UPDATE contracts SET status='delivered' WHERE id=?").run(contractId);
    expect(failedFor((await admin.get('/api/notifications')).body)).toHaveLength(0);
  });
});

describe('#31 leftovers', () => {
  test('the hard-coded salesperson list route is gone; /calendar serves the calendar', async () => {
    expect((await admin.get('/api/contracts/meta/salesmen')).status).not.toBe(200);
    const page = await admin.get('/calendar');
    expect(page.status).not.toBe(302);
  });
});

describe('#32 email certificate check', () => {
  test('on for a real mail server, off only for a relay on this machine', () => {
    const { getTransporter } = jest.requireActual('../utils/emailSender');
    const saved = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT };
    try {
      Object.assign(process.env, { SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587' });
      expect(getTransporter().options.tls.rejectUnauthorized).toBe(true);
      process.env.SMTP_HOST = 'localhost';
      expect(getTransporter().options.tls.rejectUnauthorized).toBe(false);
    } finally {
      for (const [k, v] of [['SMTP_HOST', saved.host], ['SMTP_PORT', saved.port]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe('#33 serial numbers', () => {
  test('match whatever the capitals, and can\'t be on two inventory units', async () => {
    const add = serial => admin.post('/api/inventory-items').field('make', 'HotSpring').field('model', 'Envoy').field('serialNumber', serial);
    expect((await add('CASE-33A')).status).toBe(200);
    const again = await add(' case-33a ');
    expect(again.status).toBe(409);
    expect((await admin.get('/api/inventory/serial-exists').query({ serial: 'case-33a' })).body.exists).toBe(true);
    expect(() => ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('X','Y','Case-33a','In-stock')").run())
      .toThrow(/UNIQUE/);
    // Blank serials (on-order stock) are fine more than once.
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('X','Y','','Ordered')").run();
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('X','Y',NULL,'Ordered')").run();
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('X','Y','','Ordered')").run();
  });
});
