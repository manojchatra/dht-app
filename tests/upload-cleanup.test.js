'use strict';
const fs = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData } = require('./helpers/fixtures');

let ctx, img;
beforeAll(async () => {
  ctx = createTestApp();
  img = await require('sharp')({ create: { width: 80, height: 60, channels: 3, background: '#999' } }).jpeg().toBuffer();
}, 30000);
afterAll(() => { destroyTestApp(ctx); });

const settle = () => new Promise(r => setTimeout(r, 100)); // cleanup runs once the response is sent
const contractsDir = () => path.join(ctx.tmpDir, 'uploads', 'contracts');
const looseFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name) : []);
// inventory-items.js writes to the app's own uploads/inventory-tmp (not UPLOADS_DIR)
const invTmp = path.join(__dirname, '../uploads/inventory-tmp');

describe('photos from a rejected save are not left behind', () => {
  test('New Contract rejected (no signature) — its photos are deleted', async () => {
    const agent = await loginAgent(ctx.app);
    const before = looseFiles(contractsDir());
    const res = await agent.post('/api/contracts')
      .field('data', JSON.stringify(contractFormData({ customerSignature: '' })))
      .attach('contractImage', img, { filename: 'c.jpg', contentType: 'image/jpeg' })
      .attach('chequeImage', img, { filename: 'q.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    await settle();
    expect(looseFiles(contractsDir())).toEqual(before);
  });

  test('New Contract saved — its photos are kept in the contract folder', async () => {
    const agent = await loginAgent(ctx.app);
    const res = await agent.post('/api/contracts')
      .field('data', JSON.stringify(contractFormData({ product: { status: 'instock', serialNumber: 'ZZUPC-1', make: 'M', model: 'X' } })))
      .attach('contractImage', img, { filename: 'c.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    await settle();
    const p = ctx.db.prepare('SELECT contract_image_path FROM contracts WHERE id=?').get(res.body.contractId).contract_image_path;
    expect(p).toContain(res.body.contractNumber);
    expect(fs.existsSync(p)).toBe(true);
    expect(looseFiles(contractsDir())).toEqual([]);
  });

  test('Preview & Save uploads are kept for the final save, then moved into the folder', async () => {
    const agent = await loginAgent(ctx.app);
    const up = await agent.post('/api/contracts/upload-temp')
      .attach('contractImage', img, { filename: 'c.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(200);
    await settle();
    expect(fs.existsSync(up.body.contractImagePath)).toBe(true);

    const data = contractFormData({ product: { status: 'instock', serialNumber: 'ZZUPC-2', make: 'M', model: 'X' }, _uploadedPaths: up.body });
    const res = await agent.post('/api/contracts').send({ data: JSON.stringify(data) });
    expect(res.status).toBe(200);
    const p = ctx.db.prepare('SELECT contract_image_path FROM contracts WHERE id=?').get(res.body.contractId).contract_image_path;
    expect(p).toContain(res.body.contractNumber);
    expect(fs.existsSync(p)).toBe(true);
  });

  test('Add Inventory rejected (duplicate serial) and Ordered units — photos are deleted', async () => {
    const admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const add = (fields) => {
      let r = admin.post('/api/inventory-items');
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r.attach('skuPhoto', img, { filename: 's.jpg', contentType: 'image/jpeg' })
              .attach('serialPhoto', img, { filename: 'n.jpg', contentType: 'image/jpeg' });
    };
    const before = looseFiles(invTmp);

    expect((await add({ make: 'M', model: 'X', serialNumber: 'ZZUPC-INV-1' })).status).toBe(200);
    expect((await add({ make: 'M', model: 'X', serialNumber: 'ZZUPC-INV-1' })).status).toBe(409);
    expect((await add({ make: 'M', model: 'X', webOrderNumber: 'W1', truckNumber: 'T1' })).status).toBe(200);
    await settle();
    expect(looseFiles(invTmp)).toEqual(before);

    const row = ctx.db.prepare("SELECT sku_photo_path FROM inventory WHERE serial_number='ZZUPC-INV-1'").get();
    expect(fs.existsSync(row.sku_photo_path)).toBe(true);
    fs.rmSync(path.dirname(row.sku_photo_path), { recursive: true, force: true });
  });
});

describe('stray-upload sweep', () => {
  const old = Date.now() / 1000 - 3 * 86400;
  const put = (rel, mtime) => {
    const p = path.join(ctx.tmpDir, 'uploads', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    if (mtime) fs.utimesSync(p, mtime, mtime);
    return p;
  };

  test('finds only old, unreferenced loose files and deletes them', () => {
    const { findStrayUploads, deleteStrayUploads } = require('../utils/uploadCleanup');
    const stray     = put('contracts/111-aaa-chequeImage.jpg', old);
    const tmpStray  = put('tmp/sub/222-bbb.jpg', old);
    const recent    = put('contracts/333-ccc-contractImage.jpg');
    const inFolder  = put('contracts/DHT0000XX00001/contract.jpg', old);
    const referenced = put('contracts/444-ddd-extraImages.jpg', old);
    const id = ctx.db.prepare('SELECT id FROM contracts LIMIT 1').get().id;
    ctx.db.prepare('UPDATE contracts SET extra_images=? WHERE id=?').run(JSON.stringify([{ path: referenced, label: '' }]), id);

    const found = findStrayUploads(ctx.db).map(s => s.path);
    expect(found).toEqual(expect.arrayContaining([stray, tmpStray]));
    expect(found).not.toContain(recent);
    expect(found).not.toContain(inFolder);
    expect(found).not.toContain(referenced);

    const strays = findStrayUploads(ctx.db);
    expect(deleteStrayUploads(ctx.db, strays).deleted).toBe(strays.length);
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.existsSync(tmpStray)).toBe(false);
    [recent, inFolder, referenced].forEach(p => expect(fs.existsSync(p)).toBe(true));
  });
});
