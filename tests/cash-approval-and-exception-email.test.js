'use strict';
// Nov 2026: cash recorded by a salesperson (contract page, View Contracts or a
// New Contract deposit) waits for admin approval — photo required on the
// contract page, not counted until approved, approved / rejected from the
// Dashboard bell (payment notifications only, Clear all) or the contract page,
// salesperson emailed either way. And the "Delivery exception" email to the
// Settings list, with the exception photos.
const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, sales, mail, sheet;
beforeAll(async () => {
  ctx = createTestApp();
  mail = require('../utils/emailSender');
  sheet = require('../services/driveInventory');
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
});
afterAll(() => { destroyTestApp(ctx); });
beforeEach(() => { jest.clearAllMocks(); });

const jpeg = () => sharp({ create: { width: 120, height: 80, channels: 3, background: '#5a5' } }).jpeg().toBuffer();
const pay = id => ctx.db.prepare('SELECT * FROM payments WHERE id=?').get(id);
const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
// $5,000 contract, nothing paid
const unpaid = async (agent = sales) => (await createContract(agent, { payment: {} })).contractId;
const cash = async (agent, contractId, amount, withPhoto = true) => {
  let r = agent.post('/api/payments').field('contractId', String(contractId)).field('amount', String(amount)).field('method', 'cash').field('notes', 'Deposit');
  if (withPhoto) r = r.attach('cashPhoto', await jpeg(), { filename: 'cash.jpg', contentType: 'image/jpeg' });
  return r;
};

describe('a salesperson records cash', () => {
  test('a photo is required', async () => {
    const id = await unpaid();
    const r = await cash(sales, id, 500, false);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Add a photo of the cash/);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM payments WHERE contract_id=?').get(id).n).toBe(0);
  });

  test('saved as waiting: not counted, no receipt or Sheet change; photo filed; admin emailed with it', async () => {
    const id = await unpaid();
    const r = await cash(sales, id, 500);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pending: true, totalPaid: 0, newBalance: 5000, fullyPaid: false });
    const p = pay(r.body.paymentId);
    expect(p).toMatchObject({ approval: 'pending', method: 'cash', amount: 500, recorded_by: 'sales' });
    expect(p.cash_image_path).toMatch(/cash-\d+\.jpg$/);
    expect(fs.existsSync(p.cash_image_path)).toBe(true);
    expect(row(id).due_prior).toBe('5000');
    expect(sheet.updatePaymentInSheet).not.toHaveBeenCalled();
    expect(mail.notifyPaymentRecorded).not.toHaveBeenCalled();
    expect(mail.notifyCashPending).toHaveBeenCalledWith(expect.objectContaining({ amount: 500, photoPath: p.cash_image_path, notes: 'Deposit' }));
    expect((await sales.get(`/api/payments/${p.id}/receipt`)).status).toBe(400);
    const c = (await sales.get(`/api/contracts/${id}`)).body;
    expect(c).toMatchObject({ total_paid: 0, pending_paid: 500 });
    expect(c.payments[0].cash_image_url).toMatch(/^\/uploads\/contracts\/.*cash-\d+\.jpg$/);
  });

  test('waiting cash is counted when checking an amount: nothing can take the total past the Grand Total', async () => {
    const id = await unpaid();
    await cash(sales, id, 3000);
    const over = await sales.post('/api/payments').send({ contractId: id, amount: 2500, method: 'credit_card' });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/exceeds remaining balance of \$2000\.00 \(after \$3,000\.00 cash awaiting approval\)/);
    expect((await admin.post('/api/payments').send({ contractId: id, amount: 2001, method: 'cash' })).status).toBe(400);
    expect((await sales.post('/api/payments').send({ contractId: id, amount: 2000, method: 'credit_card' })).status).toBe(200);
  });

  test('cheque, card, finance and admin\'s own cash count straight away, as before', async () => {
    const id = await unpaid();
    for (const method of ['cheque', 'credit_card', 'finance']) {
      const r = await sales.post('/api/payments').send({ contractId: id, amount: 100, method });
      expect(r.body).toMatchObject({ success: true });
      expect(r.body.pending).toBeFalsy();
    }
    const a = await admin.post('/api/payments').send({ contractId: id, amount: 100, method: 'cash' });
    expect(a.body.pending).toBeFalsy();
    expect(row(id).paid_amount).toBe('400');
  });

  test('a New Contract cash deposit by a salesperson waits (no photo); by admin it counts', async () => {
    const both = { cheque: { selected: true, number: '77', amount: '600' }, cash: { selected: true, amount: '400' } };
    const s = await createContract(sales, { payment: both, costing: { grandTotal: '1000' } });
    expect(s.pendingCash).toBe(true);
    const ps = ctx.db.prepare('SELECT method, approval FROM payments WHERE contract_id=? ORDER BY id').all(s.contractId);
    expect(ps).toEqual([{ method: 'cheque', approval: null }, { method: 'cash', approval: 'pending' }]);
    expect(row(s.contractId)).toMatchObject({ paid_amount: '600', due_prior: '400' });
    expect(mail.notifyCashPending).toHaveBeenCalledWith(expect.objectContaining({ amount: 400, photoPath: null }));

    const a = await createContract(admin, { payment: both, costing: { grandTotal: '1000' } });
    expect(a.pendingCash).toBe(false);
    expect(row(a.contractId)).toMatchObject({ paid_amount: '1000', due_prior: '0' });
  });
});

describe('the bell and approving', () => {
  test('the bell lists waiting cash (admin only); payment notifications are out of the Dashboard cards', async () => {
    const id = await unpaid();
    const { paymentId } = (await cash(sales, id, 250)).body;
    expect((await sales.get('/api/notifications/payments')).status).toBe(403);
    const bell = (await admin.get('/api/notifications/payments')).body;
    expect(bell.pending.find(p => p.id === paymentId)).toMatchObject({ contract_id: id, amount: 250, notes: 'Deposit',
      customer_name: 'Jane Test', recorded_by: 'sales', photo_url: expect.stringMatching(/cash-\d+\.jpg$/) });
    await admin.post('/api/payments').send({ contractId: id, amount: 50, method: 'cheque' });
    expect((await admin.get('/api/notifications/payments')).body.items.some(n => n.event_type === 'PAYMENT')).toBe(true);
    expect((await admin.get('/api/notifications')).body.some(n => n.event_type === 'PAYMENT')).toBe(false);
  });

  test('approve: counts, photo into the gallery, receipt, Sheet, emails; only once, admin only', async () => {
    const id = await unpaid();
    const { paymentId } = (await cash(sales, id, 500)).body;
    const photo = pay(paymentId).cash_image_path;
    expect((await sales.post(`/api/payments/${paymentId}/approve`)).status).toBe(403);
    expect((await admin.post(`/api/payments/${paymentId}/void`).send({ reason: 'x' })).body.error).toMatch(/approve or reject it instead/);

    const r = await admin.post(`/api/payments/${paymentId}/approve`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approved: true, totalPaid: 500, newBalance: 4500 });
    expect(pay(paymentId)).toMatchObject({ approval: 'approved', approved_by: 'admin', cash_image_path: photo });
    expect(row(id)).toMatchObject({ paid_amount: '500', due_prior: '4500' });
    expect(JSON.parse(row(id).extra_images)).toContainEqual({ path: photo, label: expect.stringMatching(/^Cash payment \$500\.00 — /) });
    expect(fs.existsSync(path.join(path.dirname(photo), `receipt-${paymentId}.pdf`))).toBe(true);
    expect(sheet.updatePaymentInSheet).toHaveBeenCalledWith(row(id).contract_number, 500, 4500);
    expect(mail.notifyPaymentRecorded).toHaveBeenCalledWith(expect.objectContaining({ amount: 500, method: 'cash', chequeImagePath: photo }));
    expect(mail.notifyCashDecision).toHaveBeenCalledWith(expect.objectContaining({ approved: true, amount: 500, by: 'admin', totalPaid: 500, balance: 4500 }));
    const bell = (await admin.get('/api/notifications/payments')).body;
    expect(bell.pending.some(p => p.id === paymentId)).toBe(false);
    expect(bell.items[0]).toMatchObject({ event_type: 'CASH_APPROVED', color: 'green' });
    expect((await admin.post(`/api/payments/${paymentId}/approve`)).body.error).toMatch(/already approved/);
    expect((await sales.get(`/api/payments/${paymentId}/receipt`)).status).toBe(200);
  }, 30000);

  test('reject: a reason is required; voided, never counts, photo deleted, salesperson told', async () => {
    const id = await unpaid();
    const { paymentId } = (await cash(sales, id, 700)).body;
    const photo = pay(paymentId).cash_image_path;
    expect((await admin.post(`/api/payments/${paymentId}/reject`).send({ reason: ' ' })).status).toBe(400);
    const r = await admin.post(`/api/payments/${paymentId}/reject`).send({ reason: 'Cash not received at the office' });
    expect(r.status).toBe(200);
    expect(pay(paymentId)).toMatchObject({ approval: 'rejected', voided_by: 'admin', void_reason: 'Rejected: Cash not received at the office', cash_image_path: null });
    expect(fs.existsSync(photo)).toBe(false);
    expect(row(id).paid_amount).not.toBe('700');
    expect((await sales.get(`/api/contracts/${id}`)).body).toMatchObject({ total_paid: 0, pending_paid: 0 });
    expect(mail.notifyCashDecision).toHaveBeenCalledWith(expect.objectContaining({ approved: false, reason: 'Cash not received at the office' }));
    expect((await admin.get('/api/notifications/payments')).body.items[0]).toMatchObject({ event_type: 'CASH_REJECTED', color: 'red' });
    // its amount is free again
    expect((await sales.post('/api/payments').send({ contractId: id, amount: 5000, method: 'credit_card' })).status).toBe(200);
  });

  test('approval is refused if it would now overpay (the Grand Total was lowered meanwhile)', async () => {
    const id = await unpaid();
    const { paymentId } = (await cash(sales, id, 3000)).body;
    const d = JSON.parse(row(id).data); d.costing.grandTotal = '2000';
    ctx.db.prepare('UPDATE contracts SET data=? WHERE id=?').run(JSON.stringify(d), id);
    const r = await admin.post(`/api/payments/${paymentId}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/past the Grand Total/);
    expect(pay(paymentId).approval).toBe('pending');
  });

  test('Clear all removes payment notifications, not waiting cash', async () => {
    const id = await unpaid();
    const { paymentId } = (await cash(sales, id, 100)).body;
    await admin.post('/api/payments').send({ contractId: id, amount: 10, method: 'cheque' });
    expect((await admin.post('/api/notifications/payments/clear')).body.cleared).toBeGreaterThan(0);
    const bell = (await admin.get('/api/notifications/payments')).body;
    expect(bell.items).toEqual([]);
    expect(bell.pending.map(p => p.id)).toContain(paymentId);
  });
});

describe('pages', () => {
  const page = n => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
  test('Dashboard bell; contract page and View Contracts take the cash photo; contract page approves', () => {
    const dash = page('dashboard.html');
    expect(dash).toMatch(/id="bellBtn"[^>]*aria-label="Payment notifications"/);
    expect(dash).toMatch(/fetch\('\/api\/notifications\/payments'\)/);
    expect(dash).toMatch(/onclick="clearBell\(\)">Clear all</);
    expect(dash).toMatch(/fetch\('\/api\/payments\/'\+id\+'\/'\+\(approve\?'approve':'reject'\)/);
    for (const f of ['contract-detail.html', 'view-contracts.html']) {
      const src = page(f);
      expect(src).toMatch(/id="cashCam" accept="image\/\*" capture="environment"/);
      expect(src).toMatch(/append\('cashPhoto',\s?cashPhoto\)/);
      expect(src).toMatch(/cashNeedsApproval ?= ?\(\) ?=> ?document\.getElementById\('payMethod'\)\.value ?=== ?'cash' ?&& ?window\._userRole ?=== ?'sales'/);
    }
    const cd = page('contract-detail.html');
    expect(cd).toMatch(/Awaiting approval<\/span>/);
    expect(cd).toMatch(/onclick="decideCashPay\(' \+ p\.id \+ ',true,this\)"/);
  });
});

describe('delivery exception email', () => {
  test('Settings list: admin only, addresses checked and tidied', async () => {
    expect((await sales.get('/api/settings/exception-emails')).status).toBe(403);
    expect((await admin.put('/api/settings/exception-emails').send({ emails: ['not-an-email'] })).status).toBe(400);
    const r = await admin.put('/api/settings/exception-emails').send({ emails: [' Barbara@DesertHotTubs.com ', 'barbara@deserthottubs.com', 'ops@example.com'] });
    expect(r.body.emails).toEqual(['barbara@deserthottubs.com', 'ops@example.com']);
    expect((await admin.get('/api/settings/exception-emails')).body).toEqual(['barbara@deserthottubs.com', 'ops@example.com']);
  });

  const sig = async () => 'data:image/png;base64,' + (await sharp({ create: { width: 300, height: 100, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64');
  const ack = async (contractId, exceptions, photos) => {
    ctx.db.prepare("UPDATE contracts SET status='scheduled', delivery_team='team_b', scheduled_datetime='2026-11-20T08:00', scheduled_duration=120 WHERE id=?").run(contractId);
    const s = await sig();
    let r = admin.post(`/api/delivery/acknowledgement/${contractId}`).field('customerNameTyped', 'Jane Test').field('deliveredBy', 'Dave and Sam')
      .field('formDataJson', JSON.stringify({ customerSig: s, teamSig: s, exceptions }))
      .attach('deliveryPhotos', await jpeg(), { filename: 'd.jpg', contentType: 'image/jpeg' });
    for (let i = 0; i < photos; i++) r = r.attach('exceptionImages', await jpeg(), { filename: `e${i}.jpg`, contentType: 'image/jpeg' });
    return r;
  };

  test('an exception noted: emailed with the exception photos, what was written, the slot and team', async () => {
    const { contractId } = await createContract(admin);
    const r = await ack(contractId, 'Scratch on the cabinet, left corner', 2);
    expect(r.status).toBe(200);
    expect(mail.notifyDeliveryException).toHaveBeenCalledTimes(1);
    const arg = mail.notifyDeliveryException.mock.calls[0][0];
    expect(arg).toMatchObject({ exceptions: 'Scratch on the cabinet, left corner', deliveredBy: 'Dave and Sam', teamName: 'Installation Team',
      slot: 'Fri, Nov 20, 2026, 8:00 AM – 10:00 AM', submittedBy: expect.stringMatching(/admin/) });
    expect(arg.contract.id).toBe(contractId);
    expect(arg.photoPaths).toHaveLength(2);
    arg.photoPaths.forEach(p => { expect(p).toMatch(/exception-\d\.jpg$/); expect(fs.existsSync(p)).toBe(true); });
  }, 30000);

  test('no exception: no email', async () => {
    const { contractId } = await createContract(admin);
    expect((await ack(contractId, '', 0)).status).toBe(200);
    expect(mail.notifyDeliveryException).not.toHaveBeenCalled();
  }, 30000);

  test('the email itself: its subject, and sent to the Settings list', async () => {
    const real = jest.requireActual('../utils/emailSender');
    const src = fs.readFileSync(path.join(__dirname, '../utils/emailSender.js'), 'utf8');
    expect(src).toMatch(/subject = `Delivery exception — \$\{contract\.contract_number\} — \$\{custName\}`/);
    expect(src).toMatch(/key='exception_email_recipients'/);
    expect(typeof real.notifyDeliveryException).toBe('function');
  });
});
