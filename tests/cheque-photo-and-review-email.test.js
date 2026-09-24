'use strict';
const fs      = require('fs');
const path    = require('path');
const sharp   = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

async function unpaidContract(agent) {
  return createContract(agent, { payment: {}, costing: { grandTotal: '5000' } });
}

async function jpegBuffer() {
  return sharp({ create: { width: 200, height: 120, channels: 3, background: '#888' } }).jpeg().toBuffer();
}

describe('cheque photo on POST /api/payments', () => {
  test('saves the photo as cheque-<paymentId>.jpg, records its path, and emails it', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId, contractNumber } = await unpaidContract(agent);
    const { notifyPaymentRecorded } = require('../utils/emailSender');
    notifyPaymentRecorded.mockClear();

    const res = await agent.post('/api/payments')
      .field('contractId', String(contractId)).field('amount', '1000').field('method', 'cheque')
      .field('chequeNumber', '4521')
      .attach('chequePhoto', await jpegBuffer(), { filename: 'cheque.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    const row = ctx.db.prepare('SELECT * FROM payments WHERE id=?').get(res.body.paymentId);
    expect(path.basename(row.cheque_image_path)).toBe(`cheque-${res.body.paymentId}.jpg`);
    expect(fs.existsSync(row.cheque_image_path)).toBe(true);
    expect(row.cheque_image_path).toContain(contractNumber);
    expect(notifyPaymentRecorded).toHaveBeenCalledWith(expect.objectContaining({ chequeImagePath: row.cheque_image_path }));
  });

  test('a cheque payment with no photo still works (photo is optional)', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);

    const res = await agent.post('/api/payments').send({ contractId, amount: 500, method: 'cheque', chequeNumber: '1' });

    expect(res.status).toBe(200);
    expect(ctx.db.prepare('SELECT cheque_image_path FROM payments WHERE id=?').get(res.body.paymentId).cheque_image_path).toBeNull();
  });

  test('a photo sent with a non-cheque method is ignored', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);

    const res = await agent.post('/api/payments')
      .field('contractId', String(contractId)).field('amount', '300').field('method', 'cash')
      .attach('chequePhoto', await jpegBuffer(), { filename: 'x.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(ctx.db.prepare('SELECT cheque_image_path FROM payments WHERE id=?').get(res.body.paymentId).cheque_image_path).toBeNull();
  });

  test('a rejected payment (exceeds balance) leaves no temp upload behind and records nothing', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    const tmpDir = path.join(process.env.UPLOADS_DIR, 'payment-tmp');
    const before = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).length : 0;

    const res = await agent.post('/api/payments')
      .field('contractId', String(contractId)).field('amount', '999999').field('method', 'cheque')
      .attach('chequePhoto', await jpegBuffer(), { filename: 'c.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds remaining balance/);
    expect(fs.readdirSync(tmpDir).length).toBe(before);
  });

  test('GET /api/contracts/:id exposes cheque_image_url for the payment', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    const pay = await agent.post('/api/payments')
      .field('contractId', String(contractId)).field('amount', '700').field('method', 'cheque')
      .attach('chequePhoto', await jpegBuffer(), { filename: 'c.jpg', contentType: 'image/jpeg' });

    const res = await agent.get(`/api/contracts/${contractId}`);

    const p = res.body.payments.find(x => x.id === pay.body.paymentId);
    expect(p.cheque_image_url).toMatch(new RegExp(`^/uploads/contracts/.+/cheque-${pay.body.paymentId}\\.jpg$`));
  });
});

describe('delivery queues the review email', () => {
  const dueAt = id => ctx.db.prepare('SELECT review_email_due_at FROM contracts WHERE id=?').get(id).review_email_due_at;
  const paidInStock = (agent, serial) => createContract(agent, {
    product: { status: 'instock', serialNumber: serial, make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
    payment: { cheque: { selected: true, number: '1001', amount: '5000' } },
    costing: { grandTotal: '5000' },
  });

  test('marking a contract delivered from the status route queues it', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await paidInStock(agent, 'ZZREVIEW-1');
    expect(dueAt(contractId)).toBeNull();

    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' });

    expect(res.status).toBe(200);
    expect(dueAt(contractId)).toBeTruthy();
  });

  test('a contract auto-delivered at creation (delivery date in the past) is never queued', async () => {
    const agent = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
    const { contractId } = await createContract(agent, {
      deliveryDate: '2020-01-15',
      product: { status: 'instock', serialNumber: 'ZZREVIEW-HIST', make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
      payment: { cheque: { selected: true, number: '1002', amount: '5000' } },
      costing: { grandTotal: '5000' },
    });

    expect(ctx.db.prepare('SELECT status FROM contracts WHERE id=?').get(contractId).status).toBe('delivered');
    expect(dueAt(contractId)).toBeNull();
  });
});

describe('google review email queue', () => {
  const reviewEmail = () => require('../utils/reviewEmail');
  const emailSender = () => require('../utils/emailSender');
  const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
  const makeDue = id => ctx.db.prepare("UPDATE contracts SET review_email_due_at=datetime('now','-1 minute') WHERE id=?").run(id);

  test('queueReviewEmail stamps a due time ~24h out, once', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);

    reviewEmail().queueReviewEmail(contractId);
    const first = row(contractId).review_email_due_at;
    expect(first).toBeTruthy();
    const hours = (new Date(first.replace(' ', 'T') + 'Z') - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);

    reviewEmail().queueReviewEmail(contractId); // e.g. acknowledgement re-submitted
    expect(row(contractId).review_email_due_at).toBe(first);
  });

  test('a contract that was never queued is never emailed (historical auto-delivered entries)', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    emailSender().sendReviewRequestEmail.mockClear();

    await reviewEmail().processDueReviewEmails();

    expect(emailSender().sendReviewRequestEmail.mock.calls.some(c => c[0].customerEmail === 'jane.test@example.com' && row(contractId).review_email_sent_at)).toBe(false);
    expect(row(contractId).review_email_sent_at).toBeNull();
  });

  test('a due contract gets the email with its store link, and is marked sent exactly once', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    reviewEmail().queueReviewEmail(contractId);
    makeDue(contractId);
    const { sendReviewRequestEmail, getStoreReviewUrl } = emailSender();
    sendReviewRequestEmail.mockClear();

    await reviewEmail().processDueReviewEmails();
    await reviewEmail().processDueReviewEmails();

    expect(getStoreReviewUrl).toHaveBeenCalledWith('Phoenix');
    const mine = sendReviewRequestEmail.mock.calls.filter(c => c[0].reviewUrl === 'https://g.page/r/test/review' && c[0].customerEmail === 'jane.test@example.com');
    expect(mine).toHaveLength(1);
    expect(row(contractId).review_email_sent_at).toBeTruthy();
  });

  test('a not-yet-due contract is left alone', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    reviewEmail().queueReviewEmail(contractId);

    await reviewEmail().processDueReviewEmails();

    expect(row(contractId).review_email_sent_at).toBeNull();
  });

  test('no link configured for the store: not sent, attempt counted, retried later', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    reviewEmail().queueReviewEmail(contractId);
    makeDue(contractId);
    emailSender().getStoreReviewUrl.mockReturnValueOnce('');

    await reviewEmail().processDueReviewEmails();

    const r = row(contractId);
    expect(r.review_email_sent_at).toBeNull();
    expect(r.review_email_attempts).toBe(1);
    expect(new Date(r.review_email_due_at.replace(' ', 'T') + 'Z').getTime()).toBeGreaterThan(Date.now());
  });

  test('gives up after 3 failed attempts', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);
    reviewEmail().queueReviewEmail(contractId);
    emailSender().sendReviewRequestEmail.mockRejectedValue(new Error('smtp down'));

    for (let i = 0; i < 5; i++) { makeDue(contractId); await reviewEmail().processDueReviewEmails(); }
    emailSender().sendReviewRequestEmail.mockResolvedValue(null);

    const r = row(contractId);
    expect(r.review_email_attempts).toBe(3);
    expect(r.review_email_sent_at).toBeNull();
  });

  test('a customer with no email on file is skipped, not retried', async () => {
    const agent = await loginAgent(ctx.app);
    const base = await createContract(agent, { payment: {}, costing: { grandTotal: '5000' }, customer: { name: 'No Email', email: '', zip: '85099', phone: { cell: '5551112222' }, address: '1 A St', city: 'Phoenix', state: 'AZ' } });
    reviewEmail().queueReviewEmail(base.contractId);
    makeDue(base.contractId);
    emailSender().sendReviewRequestEmail.mockClear();

    await reviewEmail().processDueReviewEmails();

    expect(row(base.contractId).review_email_sent_at).toBeNull();
    expect(row(base.contractId).review_email_attempts).toBe(3);
  });
});
