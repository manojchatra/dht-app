'use strict';
// Fixes from the Oct 2026 review: request-supplied file paths (#1), a spa sold
// twice (#2/#3), "10,000" read as 10 (#4), the acknowledgement rules (#6), and
// who may open a contract's PDF / images / history / uploaded files.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const sharp = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract, SIGNATURE_PNG } = require('./helpers/fixtures');

let ctx, admin, sales, salesB, deliveryA, deliveryB, warehouse;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app); // seeded "sales"
  const mk = (role, username, team) => admin.post('/api/users').send({ username, password: 'Secret123', role, team, name: username, email: `${username}@example.com` });
  await mk('delivery', 'drv-a', 'team_a');
  await mk('delivery', 'drv-b', 'team_b');
  await mk('warehouse', 'wh-1');
  await admin.post('/api/sales').send({ username: 'sales-b', password: 'Secret123', name: 'Sales B', email: 'sb@example.com' });
  deliveryA = await loginAgent(ctx.app, { username: 'drv-a', password: 'Secret123' });
  deliveryB = await loginAgent(ctx.app, { username: 'drv-b', password: 'Secret123' });
  warehouse = await loginAgent(ctx.app, { username: 'wh-1', password: 'Secret123' });
  salesB    = await loginAgent(ctx.app, { username: 'sales-b', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const post = (agent, overrides) => agent.post('/api/contracts').send({ data: JSON.stringify(contractFormData(overrides)) });
const unit = serial => ctx.db.prepare('SELECT * FROM inventory WHERE serial_number=?').get(serial);
const addStock = (serial, availability = 'In-stock') =>
  ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('HotSpring','Envoy',?,?)").run(serial, availability).lastInsertRowid;
const product = serial => ({ status: 'instock', serialNumber: serial, make: 'HotSpring', model: 'Envoy' });
let n = 0;

describe('#1 file paths sent by the browser', () => {
  test('a path outside the upload holding area is ignored — the file is not moved', async () => {
    const outside = path.join(os.tmpdir(), `dht-secret-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret');
    const res = await post(admin, { _uploadedPaths: { contractImagePath: outside, extraImages: [{ path: outside, label: 'x' }] } });
    expect(res.status).toBe(200);
    expect(fs.existsSync(outside)).toBe(true);
    const c = ctx.db.prepare('SELECT contract_image_path, extra_images FROM contracts WHERE id=?').get(res.body.contractId);
    expect(c.contract_image_path).toBeNull();
    expect(c.extra_images || '').not.toContain('dht-secret');
    fs.unlinkSync(outside);
  });
});

describe('#2 a spa can only be sold once', () => {
  test('a serial already sold to another contract is refused, naming that contract', async () => {
    const serial = `TWICE-${++n}`;
    addStock(serial);
    const first = await createContract(admin, { product: product(serial) });
    const res = await post(admin, { product: product(serial) });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(first.contractNumber);
    expect(unit(serial).contract_id).toBe(first.contractId);
  });

  test('a spa on Hold is refused for an In Stock sale', async () => {
    const serial = `HOLD-${++n}`;
    addStock(serial, 'Hold');
    const res = await post(admin, { product: product(serial) });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/"Hold"/);
  });

  test('a typed serial not in inventory creates its unit; the same serial again is refused', async () => {
    const serial = `NEW-TYPED-${++n}`;
    const first = await createContract(admin, { product: product(serial) });
    expect(unit(serial)).toMatchObject({ availability: 'Sold', contract_id: first.contractId });
    expect((await post(admin, { product: product(serial) })).status).toBe(409);
  });

  test('two saves of the same spa at the same moment: only one gets it', async () => {
    const serial = `RACE-${++n}`;
    addStock(serial);
    const [a, b] = await Promise.all([post(admin, { product: product(serial) }), post(admin, { product: product(serial) })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM contracts WHERE serial_number=?').get(serial).c).toBe(1);
  });
});

describe('#3 a linked spa keeps its availability', () => {
  test('changing it is refused with the contract number; the search never offers it', async () => {
    const serial = `LINKED-${++n}`;
    const id = addStock(serial);
    const { contractNumber, contractId } = await createContract(admin, { product: product(serial) });
    const res = await admin.patch(`/api/inventory-items/${id}`).send({ availability: 'In-stock' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Linked to ${contractNumber} — cancel the contract to release it.`);

    // Even if a linked unit somehow says In-stock, New Contract's search skips it.
    ctx.db.prepare("UPDATE inventory SET availability='In-stock' WHERE id=?").run(id);
    const found = (await admin.get('/api/inventory/search').query({ q: serial })).body.results;
    expect(found).toEqual([]);
    expect(unit(serial).contract_id).toBe(contractId);
  });
});

describe('#4 money typed with commas', () => {
  test('"10,000" at signing is a $10,000 payment, and the Grand Total "12,500" is 12500', async () => {
    const { contractId } = await createContract(admin, {
      costing: { grandTotal: '12,500' }, details: { spaPrice: '12,500' },
      payment: { cash: { selected: true, amount: '10,000' } },
    });
    const pays = ctx.db.prepare('SELECT amount FROM payments WHERE contract_id=?').all(contractId);
    expect(pays.map(p => p.amount)).toEqual([10000]);
    expect(ctx.db.prepare('SELECT due_prior FROM contracts WHERE id=?').get(contractId).due_prior).toBe('2500');

    const res = await admin.post('/api/payments').send({ contractId, amount: '$1,500', method: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.totalPaid).toBe(11500);
  });
});

describe('#6 delivery acknowledgement', () => {
  const sig = SIGNATURE_PNG;
  const jpeg = () => sharp({ create: { width: 60, height: 40, channels: 3, background: '#777' } }).jpeg().toBuffer();
  const ack = async (agent, id) => agent.post(`/api/delivery/acknowledgement/${id}`)
    .field('customerNameTyped', 'Jane').field('deliveredBy', 'Crew')
    .field('formDataJson', JSON.stringify({ customerSig: sig.padEnd(120, 'A'), teamSig: sig.padEnd(120, 'A') }))
    .attach('deliveryPhotos', await jpeg(), 'p.jpg');
  const schedule = (id, team = 'team_a', extra = {}) =>
    ctx.db.prepare(`UPDATE contracts SET status='scheduled', delivery_team=?, calendar_event_id=? WHERE id=?`).run(team, extra.eventId || null, id);

  test('a To Be Ordered contract is refused, and the form says why up front', async () => {
    const { contractId, contractNumber } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'HotSpring', model: 'Envoy' } });
    const res = await ack(admin, contractId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${contractNumber} is To Be Ordered, not scheduled — check the contract number.`);
    expect(ctx.db.prepare('SELECT status FROM contracts WHERE id=?').get(contractId).status).toBe('tbo');
    expect((await admin.get(`/api/delivery/contract/${contractId}`)).body.ack_blocked_reason).toMatch(/not scheduled/);
  });

  test('another team is refused; the team it is booked for can save it', async () => {
    const { contractId } = await createContract(admin);
    schedule(contractId, 'team_a', { eventId: 'evt-ack-1' });
    expect((await deliveryB.get(`/api/delivery/contract/${contractId}`)).status).toBe(403);
    const wrong = await ack(deliveryB, contractId);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/another delivery team/);

    const { deleteCalendarEvent } = require('../services/googleCalendar');
    deleteCalendarEvent.mockClear();
    const ok = await ack(deliveryA, contractId);
    expect(ok.status).toBe(200);
    const c = ctx.db.prepare('SELECT status, calendar_event_id FROM contracts WHERE id=?').get(contractId);
    expect(c).toEqual({ status: 'delivered', calendar_event_id: null });
    expect(deleteCalendarEvent).toHaveBeenCalledWith('evt-ack-1');
  });

  test('a scheduled contract with no serial is refused', async () => {
    const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'HotSpring', model: 'Envoy' } });
    schedule(contractId);
    const res = await ack(admin, contractId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no serial number/);
  });
});

describe('who may open a contract\'s documents', () => {
  let mine, theirs;
  beforeAll(async () => {
    mine   = await createContract(sales);   // owned by "sales"
    theirs = await createContract(salesB);  // owned by "sales-b"
  });

  test('contract PDF: own contract yes, another salesperson\'s no, delivery/warehouse no', async () => {
    expect((await sales.get(`/api/contracts/${theirs.contractId}/pdf`)).status).toBe(403);
    expect((await warehouse.get(`/api/contracts/${mine.contractId}/pdf`)).status).toBe(403);
    expect((await deliveryA.get(`/api/contracts/${mine.contractId}/pdf`)).status).toBe(403);
    expect((await sales.get(`/api/contracts/${mine.contractId}/pdf`)).status).toBe(200);
  });

  test('Add Image: not on another salesperson\'s contract', async () => {
    const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const res = await sales.post(`/api/contracts/${theirs.contractId}/images`).field('label', 'x').attach('image', img, 'x.jpg');
    expect(res.status).toBe(403);
  });

  test('activity log: admins only', async () => {
    expect((await sales.get(`/api/activity/${mine.contractId}`)).status).toBe(403);
    expect((await deliveryA.get(`/api/activity/${mine.contractId}`)).status).toBe(403);
    expect((await admin.get(`/api/activity/${mine.contractId}`)).status).toBe(200);
  });

  test('uploaded contract files: owner, admin, the delivery team it is booked for — nobody else', async () => {
    // A missing file: 404 means the access check let the request through, 403 means it didn't.
    const url = c => `/uploads/contracts/${c.contractNumber}/no-such-file.jpg`;
    expect((await sales.get(url(mine))).status).toBe(404);
    expect((await admin.get(url(theirs))).status).toBe(404);
    expect((await sales.get(url(theirs))).status).toBe(403);
    expect((await warehouse.get(url(mine))).status).toBe(403);
    expect((await deliveryA.get(url(mine))).status).toBe(403);
    ctx.db.prepare("UPDATE contracts SET status='scheduled', delivery_team='team_a' WHERE id=?").run(mine.contractId);
    expect((await deliveryA.get(url(mine))).status).toBe(404);
    expect((await deliveryB.get(url(mine))).status).toBe(403);
    const anon = await require('supertest')(ctx.app).get(url(mine));
    expect([302, 401]).toContain(anon.status);
  });
});
