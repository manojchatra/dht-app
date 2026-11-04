'use strict';
// Release 1 review fixes (Nov 2026): status moves, payment vs edit, Mark
// Received (lock, serial checks, inventory, remark kept), acknowledgement,
// who can email an acknowledgement, image file names.
const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, warehouse, crewA, crewB, withLock;
beforeAll(async () => {
  ctx = createTestApp();
  // After the app loads (createTestApp resets the module registry), so this is
  // the same lock the routes use.
  withLock = require('../utils/asyncLock').withLock;
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  const user = (username, role, team) => admin.post('/api/users').send({ username, password: 'Secret123', role, team, name: username, email: `${username}@example.com` });
  await user('wh-r1', 'warehouse'); await user('crew-a', 'delivery', 'team_a'); await user('crew-b', 'delivery', 'team_b');
  warehouse = await loginAgent(ctx.app, { username: 'wh-r1', password: 'Secret123' });
  crewA = await loginAgent(ctx.app, { username: 'crew-a', password: 'Secret123' });
  crewB = await loginAgent(ctx.app, { username: 'crew-b', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const setStatus = (id, s, extra = '') => ctx.db.prepare(`UPDATE contracts SET status=?${extra} WHERE id=?`).run(s, id);
const jpeg = () => sharp({ create: { width: 60, height: 40, channels: 3, background: '#468' } }).jpeg().toBuffer();
const tbo = (serialNumber = '') => createContract(admin, { product: { status: 'tbo', serialNumber, make: 'HotSpring', model: 'Envoy' } });
const lastLog = (id, type) => ctx.db.prepare('SELECT detail FROM activity_log WHERE contract_id=? AND event_type=? ORDER BY id DESC').get(id, type)?.detail;

describe('#1 / #3 only the status moves the screens offer', () => {
  test('Scheduled can\'t go back to Assigned; nothing moves to To Be Ordered', async () => {
    const { contractId } = await createContract(admin);
    setStatus(contractId, 'scheduled', ", scheduled_datetime='2026-12-01T09:00', calendar_event_id='evt-1'");
    const back = await admin.patch(`/api/contracts/${contractId}/status`).send({ status: 'assigned' });
    expect(back.status).toBe(400);
    expect(back.body.error).toMatch(/can't go back to Assigned — use Reschedule, or Cancel/);
    expect(row(contractId)).toMatchObject({ status: 'scheduled', calendar_event_id: 'evt-1' });

    const { contractId: other, contractNumber } = await createContract(admin);
    const toTbo = await admin.patch(`/api/contracts/${other}/status`).send({ status: 'tbo' });
    expect(toTbo.body.error).toBe(`${contractNumber} can't be changed from Assigned to To Be Ordered.`);
  });

  test('the Status page no longer offers Assigned on a Scheduled card', () => {
    const page = fs.readFileSync(path.join(__dirname, '../public/status.html'), 'utf8');
    expect(page).toMatch(/isAssigned \? \{v:'assigned', l:'Assigned'\} : null/);
  });
});

describe('#2 a payment waiting behind an edit uses the edited Grand Total', () => {
  test('refused against the new, lower total', async () => {
    const { contractId } = await createContract(admin, { costing: { grandTotal: '10000' }, payment: {} });
    let release;
    const held = withLock('contract-payment:' + contractId, () => new Promise(r => { release = r; }));
    const pay = admin.post('/api/payments').send({ contractId, amount: '9000', method: 'cash' }).then(r => r);
    await new Promise(r => setTimeout(r, 150)); // the payment is now waiting for the lock
    // What an edit saves meanwhile: Grand Total 10,000 → 8,000.
    const d = JSON.parse(row(contractId).data); d.costing.grandTotal = '8000';
    ctx.db.prepare("UPDATE contracts SET data=?, grand_total='8000', due_prior='8000' WHERE id=?").run(JSON.stringify(d), contractId);
    release(); await held;
    const res = await pay;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Amount exceeds remaining balance of $8000.00');
    expect(row(contractId).due_prior).toBe('8000');
  });
});

describe('#4 / #9 / #10 Mark Received', () => {
  const adminReceive = async (id, serial) => admin.post(`/api/contracts/${id}/received`)
    .field('serialNumber', serial).attach('serialPhoto', await jpeg(), 's.jpg');
  const warehouseReceive = async (id, serial) => warehouse.post(`/api/warehouse/${id}/receive`)
    .field('serialNumber', serial).attach('serialPhoto', await jpeg(), 's.jpg').attach('skuPhoto', await jpeg(), 'k.jpg');

  test('a double-tap receives once; the second is told it\'s already received', async () => {
    const { contractId, contractNumber } = await tbo();
    setStatus(contractId, 'order_placed');
    const [a, b] = await Promise.all([warehouseReceive(contractId, 'DBL-RCV-1'), warehouseReceive(contractId, 'DBL-RCV-1')]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect([a.body.error, b.body.error].filter(Boolean)[0]).toBe(`${contractNumber} is already received.`);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE contract_id=? AND event_type='MARK_RECEIVED'").get(contractId).n).toBe(1);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM inventory WHERE upper(serial_number)='DBL-RCV-1'").get().n).toBe(1);
  });

  test('a serial sold to another contract is refused (it used to be taken from that contract)', async () => {
    const sold = await createContract(admin, { product: { status: 'instock', serialNumber: 'TAKEN-SN-1', make: 'HotSpring', model: 'Envoy' } });
    for (const receive of [warehouseReceive, adminReceive]) {
      const { contractId } = await tbo();
      setStatus(contractId, 'order_placed');
      const res = await receive(contractId, 'taken-sn-1');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(`Serial TAKEN-SN-1 is already sold to ${sold.contractNumber}.`);
      expect(row(contractId).status).toBe('order_placed');
    }
    expect(ctx.db.prepare("SELECT contract_id FROM inventory WHERE serial_number='TAKEN-SN-1'").get().contract_id).toBe(sold.contractId);
  });

  test('admin Mark Received adds the spa to inventory and keeps the salesperson\'s remark in the log', async () => {
    const { contractId } = await tbo('Customer wants January delivery');
    setStatus(contractId, 'order_placed');
    expect((await adminReceive(contractId, 'ADM-RCV-1')).status).toBe(200);
    expect(ctx.db.prepare("SELECT availability, contract_id FROM inventory WHERE serial_number='ADM-RCV-1'").get())
      .toEqual({ availability: 'Sold', contract_id: contractId });
    expect(row(contractId)).toMatchObject({ status: 'received', serial_number: 'ADM-RCV-1' });
    expect(lastLog(contractId, 'MARK_RECEIVED')).toBe('order_placed → received — Serial ADM-RCV-1 | Serial was: Customer wants January delivery');
  });

  test('a free In-stock spa with the scanned serial is linked, not duplicated', async () => {
    ctx.db.prepare("INSERT INTO inventory (make, model, serial_number, availability) VALUES ('HotSpring','Envoy','FREE-RCV-1','In-stock')").run();
    const { contractId } = await tbo();
    setStatus(contractId, 'order_placed');
    expect((await warehouseReceive(contractId, 'FREE-RCV-1')).status).toBe(200);
    expect(ctx.db.prepare("SELECT availability, contract_id FROM inventory WHERE serial_number='FREE-RCV-1'").all())
      .toEqual([{ availability: 'Sold', contract_id: contractId }]);
  });
});

describe('#5 / #6 acknowledgement', () => {
  async function ack(agent, contractId, photos = 1) {
    setStatus(contractId, 'scheduled', ", delivery_team='team_a'");
    const sig = 'data:image/png;base64,' + (await sharp({ create: { width: 300, height: 100, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64');
    let req = agent.post(`/api/delivery/acknowledgement/${contractId}`).field('customerNameTyped', 'Jane Test').field('deliveredBy', 'Crew')
      .field('formDataJson', JSON.stringify({ customerSig: sig, teamSig: sig, exceptions: '' }));
    for (let i = 0; i < photos; i++) req = req.attach('deliveryPhotos', await jpeg(), `p${i}.jpg`);
    return req;
  }

  test('a delivery photo is required by the server too', async () => {
    const { contractId } = await createContract(admin);
    const res = await ack(crewA, contractId, 0);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('At least 1 delivery photo is required');
    expect(row(contractId).status).toBe('scheduled');
  });

  test('saves the contract as it is when the acknowledgement runs, not as it was read before waiting', async () => {
    const { contractId } = await createContract(admin);
    ctx.db.prepare("UPDATE contracts SET extra_images=? WHERE id=?").run(JSON.stringify([{ path: '/x/old.jpg', label: 'Old' }]), contractId);
    let release;
    const held = withLock('contract-status:' + contractId, () => new Promise(r => { release = r; }));
    const pending = ack(crewA, contractId).then(r => r);
    await new Promise(r => setTimeout(r, 150));
    ctx.db.prepare('UPDATE contracts SET extra_images=NULL WHERE id=?').run(contractId); // an edit removed the image meanwhile
    release(); await held;
    expect((await pending).status).toBe(200);
    expect(JSON.parse(row(contractId).extra_images).map(i => i.label)).not.toContain('Old');
  });

  test('recipients: admin or the team it\'s scheduled for; resending is admin only', async () => {
    const { contractId } = await createContract(admin);
    setStatus(contractId, 'scheduled', ", delivery_team='team_a'");
    expect((await crewA.get(`/api/delivery/email-recipients/${contractId}`)).status).toBe(200);
    expect((await crewB.get(`/api/delivery/email-recipients/${contractId}`)).status).toBe(403);
    expect((await admin.get(`/api/delivery/email-recipients/${contractId}`)).status).toBe(200);
    const resend = await crewA.post(`/api/delivery/send-ack/${contractId}`).send({ recipients: ['someone@example.com'] });
    expect(resend.status).toBe(403);
  });
});

describe('#8 adding an image never overwrites another one', () => {
  test('after a removal, the new file gets an unused number', async () => {
    const { contractId, contractNumber } = await createContract(admin);
    const folder = path.join(process.env.UPLOADS_DIR, 'contracts', contractNumber);
    fs.mkdirSync(folder, { recursive: true });
    // Three images were added, then the first was removed on the Edit page.
    const keep = path.join(folder, 'extra-3-Cover.jpg');
    fs.writeFileSync(path.join(folder, 'extra-2-Steps.jpg'), 'x'); fs.writeFileSync(keep, 'KEEP');
    ctx.db.prepare('UPDATE contracts SET extra_images=? WHERE id=?')
      .run(JSON.stringify([{ path: path.join(folder, 'extra-2-Steps.jpg'), label: 'Steps' }, { path: keep, label: 'Cover' }]), contractId);
    const res = await admin.post(`/api/contracts/${contractId}/images`).field('label', 'Cover').attach('image', await jpeg(), 'c.jpg');
    expect(res.status).toBe(200);
    expect(fs.readFileSync(keep, 'utf8')).toBe('KEEP');
    expect(res.body.url).toMatch(/extra-4-Cover\.jpg$/);
  });
});
