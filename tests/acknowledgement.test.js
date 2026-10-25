'use strict';
const fs      = require('fs');
const path    = require('path');
const sharp   = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

async function jpegBuffer(colour) {
  return sharp({ create: { width: 200, height: 120, channels: 3, background: colour } }).jpeg().toBuffer();
}

async function signature() {
  const png = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

async function submitAck(agent, contractId, photos) {
  // Only a Scheduled contract (with a serial) can be acknowledged.
  ctx.db.prepare("UPDATE contracts SET status='scheduled', delivery_team='team_a' WHERE id=? AND status<>'delivered'").run(contractId);
  const sig = await signature();
  let req = agent.post(`/api/delivery/acknowledgement/${contractId}`)
    .field('customerNameTyped', 'Jane Test')
    .field('deliveredBy', 'Clear Choice Team')
    .field('formDataJson', JSON.stringify({ customerSig: sig, teamSig: sig, exceptions: '' }));
  for (const [i, buf] of photos.entries()) {
    req = req.attach('deliveryPhotos', buf, { filename: `photo-${i + 1}.jpg`, contentType: 'image/jpeg' });
  }
  return req;
}

describe('POST /api/delivery/acknowledgement/:id', () => {
  test('saves every delivery photo when several arrive in the same request', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId, contractNumber } = await createContract(agent);
    // Identical tiny files arrive within the same millisecond — the case that
    // used to collide on the temp filename and fail the whole submission.
    const photo = await jpegBuffer('#3a7');

    const res = await submitAck(agent, contractId, [photo, photo, photo]);

    expect(res.status).toBe(200);
    const folder = path.join(process.env.UPLOADS_DIR, 'contracts', contractNumber);
    for (const n of [1, 2, 3]) {
      expect(fs.existsSync(path.join(folder, `delivery-photo-${n}.jpg`))).toBe(true);
    }
    expect(ctx.db.prepare('SELECT status FROM contracts WHERE id=?').get(contractId).status).toBe('delivered');
  });

  test('accepts up to 10 delivery photos, listed in order in the gallery', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId, contractNumber } = await createContract(agent);
    const photo = await jpegBuffer('#a73');

    const res = await submitAck(agent, contractId, Array(10).fill(photo));

    expect(res.status).toBe(200);
    const folder = path.join(process.env.UPLOADS_DIR, 'contracts', contractNumber);
    for (let n = 1; n <= 10; n++) expect(fs.existsSync(path.join(folder, `delivery-photo-${n}.jpg`))).toBe(true);
    const gallery = JSON.parse(ctx.db.prepare('SELECT extra_images FROM contracts WHERE id=?').get(contractId).extra_images);
    expect(gallery.slice(0, 10).map(g => g.label)).toEqual(Array.from({ length: 10 }, (_, i) => `Delivery Photo ${i + 1}`));
    expect(gallery[0].path).toMatch(/delivery-photo-1\.jpg$/);
  });

  test('records the delivery date as today in Arizona time, not UTC', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createContract(agent);

    const res = await submitAck(agent, contractId, [await jpegBuffer('#37a')]);

    expect(res.status).toBe(200);
    const phoenixToday = new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
    expect(ctx.db.prepare('SELECT delivery_date FROM contracts WHERE id=?').get(contractId).delivery_date).toBe(phoenixToday);
    expect(res.body.pdfName).toBe(`acknowledgement-${phoenixToday}.pdf`);
  });
});
