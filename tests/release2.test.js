'use strict';
// Release 2 (Nov 2026): Mark Delivered needs $0 balance (the crew's
// acknowledgement isn't blocked — the office is told), no payments on a
// cancelled contract, an Order Placed spa stays in inventory when its contract
// is cancelled or deleted, card thumbnails, Status search and 50-at-a-time lists.
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const express = require('express');
const request = require('supertest');
const sharp   = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, crew;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  await admin.post('/api/users').send({ username: 'crew-r2', password: 'Secret123', role: 'delivery', team: 'team_a', name: 'Crew', email: 'crew-r2@example.com' });
  crew = await loginAgent(ctx.app, { username: 'crew-r2', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const setStatus = (id, s, extra = '') => ctx.db.prepare(`UPDATE contracts SET status=?${extra} WHERE id=?`).run(s, id);
const owing = () => createContract(admin, { costing: { grandTotal: '10000' } }); // $5,000 cheque paid → owes $5,000
const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

describe('Mark Delivered needs the balance paid', () => {
  test('refused from Assigned and Received while money is owed; allowed once paid', async () => {
    const { contractId, contractNumber } = await owing();
    const res = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${contractNumber} still owes $5,000.00 — record the payment before marking it Delivered.`);

    setStatus(contractId, 'received');
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' })).status).toBe(400);
    expect(row(contractId).status).toBe('received');

    expect((await admin.post('/api/payments').send({ contractId, amount: '5000', method: 'cash' })).status).toBe(200);
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' })).status).toBe(200);
    expect(row(contractId).status).toBe('delivered');
  });

  test('the crew\'s acknowledgement still goes through; the office is notified of the balance', async () => {
    const { contractId, contractNumber } = await owing();
    setStatus(contractId, 'scheduled', ", delivery_team='team_a'");
    const img = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
    const sig = 'data:image/png;base64,' + img.toString('base64');
    const photo = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#468' } }).jpeg().toBuffer();
    const res = await crew.post(`/api/delivery/acknowledgement/${contractId}`)
      .field('customerNameTyped', 'Jane Test').field('deliveredBy', 'Crew')
      .field('formDataJson', JSON.stringify({ customerSig: sig, teamSig: sig, exceptions: '' }))
      .attach('deliveryPhotos', photo, 'p.jpg');
    expect(res.status).toBe(200);
    expect(row(contractId).status).toBe('delivered');
    const note = ctx.db.prepare("SELECT message, color FROM notifications WHERE contract_id=? AND event_type='DELIVERED_OWING'").get(contractId);
    expect(note).toEqual({ message: `${contractNumber} delivered with $5,000.00 still owed`, color: 'red' });
  });

  test('the Status page checks before opening the Deliver form', () => {
    expect(page('status.html')).toMatch(/record the payment before marking it Delivered/);
  });
});

describe('no payments on a cancelled contract', () => {
  test('refused by the server; Record Payment hidden when cancelled or fully paid', async () => {
    const { contractId, contractNumber } = await owing();
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' })).status).toBe(200);
    const res = await admin.post('/api/payments').send({ contractId, amount: '100', method: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${contractNumber} is cancelled — payments can't be recorded on it.`);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM payments WHERE contract_id=?').get(contractId).n).toBe(1);

    const cards = page('view-contracts.html');
    expect(cards).toMatch(/function isOwing\(c\)\{return c\.status!=='cancelled'&&/);
    expect(cards).toMatch(/\$\{hasPending\?`<button onclick="openPaymentModal/);
    expect(page('contract-detail.html')).toMatch(/balDue>0 && c\.status!=='cancelled' \? '<button class="btn btn-success" onclick="openPaymentModal\(\)"/);
  });
});

describe('an Order Placed spa stays in inventory when its contract goes', () => {
  async function orderPlaced(webOrder, truck) {
    const { contractId, contractNumber } = await createContract(admin, {
      product: { status: 'tbo', serialNumber: '', make: 'Caldera', model: 'Vanto', year: '2026', shellColor: 'Pearl', cabinetColor: 'Java', included: { speaker: true } },
    });
    const res = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'order_placed', webOrderNumber: webOrder, truckNumber: truck });
    expect(res.status).toBe(200);
    return { contractId, contractNumber };
  }
  const unitsFor = webOrder => ctx.db.prepare('SELECT * FROM inventory WHERE web_order_number=?').all(webOrder);

  test('cancelling adds it as unreserved on-order stock, on the warehouse list without a customer', async () => {
    const { contractId } = await orderPlaced('WO-KEEP-1', 'TRK-77');
    expect(unitsFor('WO-KEEP-1')).toHaveLength(0); // nothing in inventory while the contract is open
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' })).status).toBe(200);

    const units = unitsFor('WO-KEEP-1');
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ availability: 'Ordered', contract_id: null, make: 'Caldera', model: 'Vanto', truck_number: 'TRK-77',
      shell_color: 'Pearl', cabinet_color: 'Java', speaker: 'Yes', year: '2026', serial_number: null });
    const log = ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='INVENTORY_RELEASED'").get(contractId);
    expect(log.detail).toBe('Returned to stock: on-order stock (Web Order # WO-KEEP-1)');
    expect(require('../services/driveInventory').appendInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ availability: 'Ordered', webOrderNumber: 'WO-KEEP-1' }));

    const wh = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const queue = (await wh.get('/api/warehouse/queue')).body;
    expect(queue.filter(q => q.web_order_number === 'WO-KEEP-1')).toEqual([expect.objectContaining({ type: 'inventory', customer_name: '', id: units[0].id })]);
  });

  test('deleting does the same', async () => {
    const { contractId } = await orderPlaced('WO-KEEP-2', 'TRK-78');
    expect((await admin.delete(`/api/contracts/${contractId}`)).status).toBe(200);
    expect(unitsFor('WO-KEEP-2')).toEqual([expect.objectContaining({ availability: 'Ordered', contract_id: null, truck_number: 'TRK-78' })]);
  });

  test('a contract that reserved on-order stock just releases it — no second unit', async () => {
    const id = ctx.db.prepare(`INSERT INTO inventory (make, model, availability, web_order_number, truck_number)
      VALUES ('Caldera','Vanto','Ordered','WO-KEEP-3','TRK-79')`).run().lastInsertRowid;
    const { contractId } = await createContract(admin, { product: { status: 'tbo', orderedUnitId: id, serialNumber: '', make: 'Caldera', model: 'Vanto' } });
    expect(row(contractId).status).toBe('order_placed');
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' })).status).toBe(200);
    expect(unitsFor('WO-KEEP-3')).toEqual([expect.objectContaining({ id, availability: 'Ordered', contract_id: null })]);
  });

  test('a To Be Ordered contract (not ordered yet) adds nothing', async () => {
    const { contractId } = await createContract(admin, { product: { status: 'tbo', serialNumber: '', make: 'Caldera', model: 'Vanto' } });
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM inventory').get().n;
    expect((await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'cancelled' })).status).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM inventory').get().n).toBe(before);
  });
});

describe('card thumbnails (?thumb=1)', () => {
  let dir, app;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dht-thumbs-'));
    fs.mkdirSync(path.join(dir, 'contracts', 'DHT1'), { recursive: true });
    await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#468' } }).jpeg().toFile(path.join(dir, 'contracts', 'DHT1', 'photo.jpg'));
    fs.writeFileSync(path.join(dir, 'contracts', 'DHT1', 'contract.pdf'), '%PDF-1.4');
    const { thumbnails } = require('../middleware/thumbnails');
    app = express().use('/uploads', thumbnails(dir), express.static(dir));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a photo comes back 160 px, made once and kept', async () => {
    const res = await request(app).get('/uploads/contracts/DHT1/photo.jpg?thumb=1').buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    expect(await sharp(res.body).metadata()).toMatchObject({ width: 160, height: 160 });
    const kept = path.join(dir, '.thumbs', 'contracts', 'DHT1', 'photo.jpg');
    expect(fs.existsSync(kept)).toBe(true);
    const full = await request(app).get('/uploads/contracts/DHT1/photo.jpg').buffer(true);
    expect((await sharp(full.body).metadata()).width).toBe(1600); // without ?thumb the full photo, as before
  });

  test('not a photo, a missing file, or a path outside uploads → the normal route', async () => {
    const pdf = await request(app).get('/uploads/contracts/DHT1/contract.pdf?thumb=1').buffer(true).parse((res, cb) => {
      const parts = []; res.on('data', d => parts.push(d)); res.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(pdf.body.toString()).toBe('%PDF-1.4');
    expect((await request(app).get('/uploads/contracts/DHT1/nope.jpg?thumb=1')).status).toBe(404);
    expect((await request(app).get('/uploads/..%2f..%2fetc%2fx.jpg?thumb=1')).status).toBe(404);
  });

  test('the thumbnail folder itself is never served (it would skip the contract access check)', async () => {
    await request(app).get('/uploads/contracts/DHT1/photo.jpg?thumb=1');
    expect(fs.existsSync(path.join(dir, '.thumbs', 'contracts', 'DHT1', 'photo.jpg'))).toBe(true);
    for (const p of ['/uploads/.thumbs/contracts/DHT1/photo.jpg', '/uploads/.thumbs/contracts/DHT1/photo.jpg?thumb=1', '/uploads/%2Ethumbs/contracts/DHT1/photo.jpg']) {
      expect((await request(app).get(p)).status).toBe(404);
    }
  });

  test('deleting a contract removes its thumbnails', async () => {
    const { contractId, contractNumber } = await createContract(admin);
    const thumbDir = path.join(process.env.UPLOADS_DIR, '.thumbs', 'contracts', contractNumber);
    fs.mkdirSync(thumbDir, { recursive: true });
    fs.writeFileSync(path.join(thumbDir, 'x.jpg'), 'x');
    expect((await admin.delete(`/api/contracts/${contractId}`)).status).toBe(200);
    expect(fs.existsSync(thumbDir)).toBe(false);
  });

  test('the server and the pages use it', () => {
    expect(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8')).toMatch(/thumbnails'\)\.thumbnails\(uploadsDir\), express\.static\(uploadsDir\)/);
    expect(page('view-contracts.html')).toMatch(/src="\$\{thumbUrl\(u\)\}" loading="lazy"/);
    expect(page('inventory-list.html')).toMatch(/loading="lazy" src="'\+thumbUrl\(it\.sku_photo_url\)/);
  });
});

describe('lists: 50 at a time, Status search', () => {
  // util.js runs in the browser; load it here to check the footer it draws.
  const util = (() => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/util.js'), 'utf8');
    return new Function(src + '; return { listFooter, thumbUrl, LIST_PAGE };')();
  })();
  const el = () => ({ style: {}, innerHTML: '', querySelector: () => null });

  test('the footer: hidden for a short list, "Show 50 more" / "Show all" for a long one', () => {
    expect(util.LIST_PAGE).toBe(50);
    const short = el(); util.listFooter(short, 50, 40, 'contracts');
    expect(short.style.display).toBe('none');
    const long = el(); util.listFooter(long, 50, 263, 'contracts');
    expect(long.innerHTML).toMatch(/Showing <b>50<\/b> of <b>263<\/b> contracts/);
    expect(long.innerHTML).toMatch(/Show 50 more/);
    expect(long.innerHTML).toMatch(/Show all/);
    const nearEnd = el(); util.listFooter(nearEnd, 250, 263, 'contracts');
    expect(nearEnd.innerHTML).toMatch(/Show 13 more/);
    expect(nearEnd.innerHTML).not.toMatch(/Show all/);
    const done = el(); util.listFooter(done, 263, 263, 'contracts');
    expect(done.innerHTML).toMatch(/All <b>263<\/b> contracts shown/);
    expect(util.thumbUrl('/uploads/a.jpg')).toBe('/uploads/a.jpg?thumb=1');
  });

  test('View Contracts, Inventory and Status show the first 50; Status has a search with per-tab counts', () => {
    expect(page('view-contracts.html')).toMatch(/contracts\.slice\(0,shownCount\)/);
    expect(page('inventory-list.html')).toMatch(/all\.slice\(0,shownCount\)/);
    const status = page('status.html');
    expect(status).toMatch(/id="statusSearch"/);
    expect(status).toMatch(/c\.status===currentTab&&matchesFilters\(c,q,r\)/); // search + date filter (Nov 2026)
    expect(status).toMatch(/function updateTabCounts\(q,r,active\)/);
  });
});
