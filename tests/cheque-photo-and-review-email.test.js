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

  test('a non-image file sent as the cheque photo is rejected with a visible error, not silently dropped', async () => {
    const agent = await loginAgent(ctx.app);
    const { contractId } = await unpaidContract(agent);

    const res = await agent.post('/api/payments')
      .field('contractId', String(contractId)).field('amount', '300').field('method', 'cheque')
      .attach('chequePhoto', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an image file/);
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM payments WHERE contract_id=?').get(contractId).c).toBe(0);
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

describe('Google review email — sent from the post-delivery feedback form', () => {
  const emailSender = () => require('../utils/emailSender');
  const reviewEmail = () => require('../utils/reviewEmail');
  const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
  const feedback = id => ctx.db.prepare('SELECT * FROM post_delivery_feedback WHERE contract_id=?').get(id);
  const makeDue = id => ctx.db.prepare("UPDATE contracts SET review_email_due_at=datetime('now','-1 minute') WHERE id=?").run(id);
  let serialNo = 0;

  async function deliveredContract(agent, overrides = {}) {
    const { contractId } = await createContract(agent, {
      product: { status: 'instock', serialNumber: `ZZREVIEW-${++serialNo}`, make: 'TestMake', model: 'TestModel', year: '2026', shellColor: 'Grey', cabinetColor: 'Espresso' },
      payment: { cheque: { selected: true, number: '1001', amount: '5000' } },
      costing: { grandTotal: '5000' },
      ...overrides,
    });
    const res = await agent.patch(`/api/contracts/${contractId}/status`).send({ status: 'delivered' });
    expect(res.status).toBe(200);
    return contractId;
  }
  const answers = (sendReviewEmail) => ({
    contacted: 1, send_review_email: sendReviewEmail,
    rating_delivery: 5, rating_installation: 5, rating_explanation: 4, rating_confidence: 5, rating_overall: 5,
  });
  const admin = () => loginAgent(ctx.app, { username: 'admin', password: 'admin123' });

  beforeEach(() => {
    emailSender().sendReviewRequestEmail.mockReset().mockResolvedValue(null);
    emailSender().getStoreReviewUrl.mockReset().mockReturnValue('https://g.page/r/test/review');
  });

  test('delivering a contract no longer schedules a review email', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    expect(row(id).review_email_due_at).toBeNull();
    expect(emailSender().sendReviewRequestEmail).not.toHaveBeenCalled();
  });

  test('the form is told the email is available when the showroom has a link and the customer an email', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    const res = await agent.get(`/api/post-delivery/contract/${id}`);
    expect(res.body.review_email_available).toBe(true);
  });

  test('no review link for the showroom: the form gets the reason, so Yes can be disabled', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    emailSender().getStoreReviewUrl.mockReturnValue('');
    const res = await agent.get(`/api/post-delivery/contract/${id}`);
    expect(res.body.review_email_available).toBe(false);
    expect(res.body.review_email_unavailable_reason).toMatch(/No Google review link is set for Phoenix/);
  });

  test('answering Yes sends the email straight away with the store link', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);

    const res = await agent.post(`/api/post-delivery/feedback/${id}`).send(answers(1));

    expect(res.status).toBe(200);
    expect(res.body.reviewEmail).toEqual({ sent: true });
    expect(emailSender().sendReviewRequestEmail).toHaveBeenCalledWith(expect.objectContaining({
      customerEmail: 'jane.test@example.com', reviewUrl: 'https://g.page/r/test/review',
    }));
    expect(row(id).review_email_sent_at).toBeTruthy();
    expect(feedback(id).send_review_email).toBe(1);
  });

  test('answering No sends nothing', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);

    const res = await agent.post(`/api/post-delivery/feedback/${id}`).send(answers(0));

    expect(res.status).toBe(200);
    expect(res.body.reviewEmail).toBeNull();
    expect(emailSender().sendReviewRequestEmail).not.toHaveBeenCalled();
    expect(feedback(id).send_review_email).toBe(0);
  });

  test('Yes without a review link: feedback is saved, no email, reason returned', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    emailSender().getStoreReviewUrl.mockReturnValue('');

    const res = await agent.post(`/api/post-delivery/feedback/${id}`).send(answers(1));

    expect(res.status).toBe(200);
    expect(res.body.reviewEmail.sent).toBe(false);
    expect(res.body.reviewEmail.reason).toMatch(/No Google review link/);
    expect(emailSender().sendReviewRequestEmail).not.toHaveBeenCalled();
    expect(feedback(id).status).toBe('submitted');
  });

  test('the question must be answered', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    const body = answers(1); delete body.send_review_email;
    const res = await agent.post(`/api/post-delivery/feedback/${id}`).send(body);
    expect(res.status).toBe(400);
  });

  test('a failed send is retried by the poller, and given up after 3 attempts', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    emailSender().sendReviewRequestEmail.mockRejectedValue(new Error('smtp down'));

    const res = await agent.post(`/api/post-delivery/feedback/${id}`).send(answers(1));
    expect(res.status).toBe(200);
    expect(res.body.reviewEmail.sent).toBe(false);
    expect(row(id).review_email_attempts).toBe(1);
    expect(row(id).review_email_due_at).toBeTruthy();

    for (let i = 0; i < 4; i++) { makeDue(id); await reviewEmail().processDueReviewEmails(); }
    expect(row(id).review_email_attempts).toBe(3);
    expect(row(id).review_email_sent_at).toBeNull();
  });

  test('a retry that succeeds marks the email sent', async () => {
    const agent = await admin();
    const id = await deliveredContract(agent);
    emailSender().sendReviewRequestEmail.mockRejectedValueOnce(new Error('smtp down'));

    await agent.post(`/api/post-delivery/feedback/${id}`).send(answers(1));
    makeDue(id);
    await reviewEmail().processDueReviewEmails();

    expect(row(id).review_email_sent_at).toBeTruthy();
    expect(emailSender().sendReviewRequestEmail).toHaveBeenCalledTimes(2);
  });
});
