'use strict';
// Contract edit — the Edit contract page (New Contract's form in edit mode) saves
// the whole form to POST /api/contracts/:id/edit (services/contractEdit.js).
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');
const { computeTotals } = require('../utils/contractTotals');
const { moneyOk } = require('../utils/money');

let ctx, admin, sales, salesB;
beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  sales = await loginAgent(ctx.app);
  await admin.post('/api/sales').send({ username: 'sales-e2', password: 'Secret123', name: 'Other Seller', email: 'e2@example.com' });
  salesB = await loginAgent(ctx.app, { username: 'sales-e2', password: 'Secret123' });
});
afterAll(() => { destroyTestApp(ctx); });

const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const data = id => JSON.parse(row(id).data);
// The example from the plan: spa $9,000 + steps $500 (not included), 8.1% tax, $5,000 paid.
const example = agent => createContract(agent, {
  details: { spaPrice: '9000', steps: { type: 'HLStep', price: '500', included: false } },
  costing: { subtotal: '9500', taxPercent: '8.1', taxAmount: '769.50', productTotal: '10269.50', grandTotal: '10269.50' },
  payment: { cheque: { selected: true, number: '77', amount: '5000' } },
});
// Save the page's form: the saved contract with `change` applied to it. When a
// price changed, the page shows the new Grand Total (recalcAll) and sends it.
const save = (agent, id, change = () => {}, extra = {}) => {
  const form = data(id); const before = JSON.stringify([form.details, form.service, form.costing?.taxPercent]);
  change(form);
  if (form.costing && JSON.stringify([form.details, form.service, form.costing.taxPercent]) !== before) {
    form.costing.grandTotal = String(computeTotals(form.details, form.service, form.costing.taxPercent).grandTotal);
  }
  return agent.post(`/api/contracts/${id}/edit`).send({ form, reason: 'Fix from handwritten contract', ...extra });
};
const log = id => ctx.db.prepare("SELECT actor, detail FROM activity_log WHERE contract_id=? AND event_type='CONTRACT_EDITED' ORDER BY id DESC").get(id);

describe('totals and money format', () => {
  test('worked out as New Contract does', () => {
    expect(computeTotals({ spaPrice: '9000', steps: { price: '500', included: false } }, {}, '8.1'))
      .toMatchObject({ subtotal: 9500, tax: 769.5, grandTotal: 10269.5 });
    const t = computeTotals({ spaPrice: '9,000', steps: { price: '500', included: true }, cover: { price: '1,200' },
      coolZone: { yes: true, price: '300' }, discount: { yes: true, amount: '100' }, spaRemoval: { yes: true, price: '250' } },
      { crane: true, craneFee: '400', outOfTownDelivery: false, outOfTownDeliveryFee: '999', outOfTownWarranty: true, outOfTownWarrantyFee: '50' }, '8.1');
    expect(t).toMatchObject({ subtotal: 10500, tax: 850.5, productTotal: 11350.5, serviceTotal: 650, grandTotal: 11900.5 });
  });
  test('commas in the right place only', () => {
    for (const ok of ['', '20300', '20,300', '$20,300.50', '1,234,567', '0.5']) expect(moneyOk(ok)).toBe(true);
    for (const bad of ['20,0300', '2,03,00', '20.300.1', 'abc', '20,30']) expect(moneyOk(bad)).toBe(false);
  });
});

describe('saving the Edit page', () => {
  test('a price change recalculates, is logged with the reason, and updates the Sheet', async () => {
    const drive = require('../services/driveInventory');
    drive.updatePaymentInSheet.mockClear(); drive.updateContractRowInSheet.mockClear();
    const { contractId, contractNumber } = await example(admin);
    const res = await save(admin, contractId, f => { f.details.steps.included = true; f.details.steps.price = '0'; },
      { reason: 'Steps were included on the handwritten contract' });
    expect(res.status).toBe(200);
    expect(row(contractId)).toMatchObject({ grand_total: '9729', due_prior: '4729', paid_amount: '5000' });
    expect(data(contractId).costing).toMatchObject({ subtotal: '9000', taxAmount: '729', grandTotal: '9729' });
    expect(log(contractId)).toEqual({ actor: 'admin', detail:
      'Steps price 500 → 0 · Steps Included — → yes · Grand Total $10269.50 → $9729.00 · Balance $5269.50 → $4729.00 — Reason: Steps were included on the handwritten contract' });
    expect(drive.updatePaymentInSheet).toHaveBeenCalledWith(contractNumber, 5000, 4729);
    expect(drive.updateContractRowInSheet).toHaveBeenCalledWith(contractNumber, expect.objectContaining({ pending: 4729 }));
    expect((await admin.post('/api/payments').send({ contractId, amount: '5000', method: 'cash' })).body.error).toMatch(/4729\.00/);
  });

  test('DHT2610PH00066: a mistyped spa price is fixed by editing', async () => {
    const { contractId } = await createContract(admin, { details: { spaPrice: '200300' },
      costing: { subtotal: '200300', taxPercent: '8.1', grandTotal: '216524.3' }, payment: { cash: { selected: true, amount: '10962' } } });
    const res = await save(admin, contractId, f => { f.details.spaPrice = '20300'; });
    expect(res.body).toMatchObject({ totals: { grandTotal: 21944.3 }, balance: 10982.3 });
  });

  test('everything else editable is saved in one go and listed in one log entry', async () => {
    const { contractId } = await example(admin);
    const res = await save(admin, contractId, f => {
      f.customer.phone = { cell: '6025550199' }; f.customer.address = '9 New Rd'; f.customer.zip = '85234';
      f.deliveryDate = '2026-12-20'; f.saleChannel = { channel: 'costco', location: 'Gilbert' };
      f.product.shellColor = 'Tuscan Sun'; f.product.year = '2027';
      f.misc = { ...f.misc, monthlyCleanings: true, cleaningMonths: '3', cleaningIncluded: true, notes: 'Back gate' };
      f.warranty = { manufacturer: { brands: ['HotSpring'], componentYrs: '5' }, dealership: {} };
    });
    expect(res.status).toBe(200);
    const d = data(contractId);
    expect(d).toMatchObject({ deliveryDate: '2026-12-20', saleChannel: { channel: 'costco', location: 'Gilbert' },
      product: { shellColor: 'Tuscan', year: '2027' }, misc: { cleaningMonths: '3', cleaningIncluded: true, notes: 'Back gate' },
      customer: { address: '9 New Rd', zip: '85234', phone: { cell: '602-555-0199' } } });
    expect(row(contractId).delivery_date).toBe('2026-12-20');
    const text = log(contractId).detail;
    for (const bit of ['Cell 602-555-0100 → 602-555-0199', 'Delivery date', 'Sold at showroom → costco', 'Shell colour', 'Cleaning months — → 3', 'Manufacturer warranty components yrs'])
      expect(text).toContain(bit);
  });

  test('phones / email / name go on the shared customer record; the address stays on the contract', async () => {
    const { contractId } = await createContract(admin);
    const c = row(contractId), cu0 = data(contractId).customer;
    await save(admin, contractId, f => { f.customer.email = 'new@example.com'; f.customer.address = '1 Other St'; });
    expect(ctx.db.prepare('SELECT email, address FROM customers WHERE id=?').get(c.customer_id)).toEqual({ email: 'new@example.com', address: cu0.address });
  });

  test('refused: below what\'s been paid, a badly placed comma, no reason, nothing changed', async () => {
    const { contractId } = await example(admin);
    expect((await save(admin, contractId, f => { f.details.spaPrice = '4000'; })).body.error)
      .toBe('Payments ($5000) are more than the new total ($4864.50) — void the extra payment first.');
    expect((await save(admin, contractId, f => { f.details.spaPrice = '20,0300'; })).body.error).toMatch(/^Spa price looks wrong: 20,0300/);
    expect((await save(admin, contractId, () => {}, { reason: ' ' })).body.error).toBe('A reason is required to edit the contract.');
    expect((await save(admin, contractId)).body.error).toBe('Nothing was changed.');
  });

  test('locked fields are ignored: store, salesperson, sale date, status, serial, payments at signing', async () => {
    const { contractId } = await example(admin);
    const before = row(contractId);
    await save(admin, contractId, f => {
      f.store = 'Surprise'; f.salesman = 'Someone'; f.date = '2020-01-01'; f.product.status = 'tbo';
      f.product.serialNumber = 'HACK'; f.payment.cheque.amount = '99999'; f.customer.email = 'x@example.com';
    });
    const after = row(contractId), d = data(contractId);
    expect([after.store, after.salesman, after.date, after.serial_number, after.status]).toEqual([before.store, before.salesman, before.date, before.serial_number, before.status]);
    expect([d.store, d.salesman, d.date, d.product.status, d.product.serialNumber, d.payment.cheque.amount])
      .toEqual([JSON.parse(before.data).store, JSON.parse(before.data).salesman, JSON.parse(before.data).date, 'instock', before.serial_number, '5000']);
  });

  test('totals move only when a price changes, and must match what the page showed', async () => {
    const { contractId } = await example(admin);
    // An older contract whose saved total doesn't match the formula exactly.
    const d0 = data(contractId); d0.costing.grandTotal = '10270';
    ctx.db.prepare("UPDATE contracts SET data=?, grand_total='10270', due_prior='5270' WHERE id=?").run(JSON.stringify(d0), contractId);
    const phoneOnly = await save(admin, contractId, f => { f.customer.phone = { cell: '6025550177' }; });
    expect(phoneOnly.status).toBe(200);
    expect(phoneOnly.body.totals).toBeNull();
    expect(row(contractId)).toMatchObject({ grand_total: '10270', due_prior: '5270' });
    expect(data(contractId).costing.grandTotal).toBe('10270');
    expect(log(contractId).detail).not.toMatch(/Grand Total/);
    // A price change whose page total doesn't add up is refused, nothing saved.
    const form = data(contractId); form.details.spaPrice = '9100'; form.costing.grandTotal = '10000';
    const bad = await admin.post(`/api/contracts/${contractId}/edit`).send({ form, reason: 'x' });
    expect(bad.body.error).toBe('The totals don\'t add up — refresh the page and try again.');
    expect(data(contractId).details.spaPrice).toBe('9000');
  });

  test('make / model can\'t change while a spa is linked', async () => {
    const { contractId } = await createContract(admin); // In Stock — its spa is linked
    const res = await save(admin, contractId, f => { f.product.model = 'Other Model'; });
    expect(res.body.error).toMatch(/^Make and model come from the linked spa/);
  });

  test('who and when: own salesperson yes, another no; after Delivered only contact details', async () => {
    const { contractId } = await example(sales);
    expect((await save(salesB, contractId, f => { f.details.spaPrice = '9100'; })).status).toBe(403);
    expect((await save(sales, contractId, f => { f.details.spaPrice = '9100'; })).status).toBe(200);
    ctx.db.prepare("UPDATE contracts SET status='delivered' WHERE id=?").run(contractId);
    const res = await save(admin, contractId, f => { f.details.spaPrice = '1'; f.customer.address = 'Ignored'; f.customer.phone = { cell: '6025550111' }; });
    expect(res.status).toBe(200);
    expect(data(contractId).details.spaPrice).toBe('9100');
    expect(data(contractId).customer).toMatchObject({ phone: { cell: '602-555-0111' } });
    expect(data(contractId).customer.address).not.toBe('Ignored');
  });

  test('images: the contract scan can be removed (file deleted); the signature can\'t', async () => {
    const { contractId, contractNumber } = await createContract(admin);
    const folder = path.join(process.env.UPLOADS_DIR, 'contracts', contractNumber);
    fs.mkdirSync(folder, { recursive: true });
    const scan = path.join(folder, 'contract.jpg'), sig = path.join(folder, 'sig-contract-customer.png');
    fs.writeFileSync(scan, 'x'); fs.writeFileSync(sig, 'x');
    ctx.db.prepare('UPDATE contracts SET contract_image_path=?, extra_images=? WHERE id=?')
      .run(scan, JSON.stringify([{ path: sig, label: 'Customer Signature' }]), contractId);
    const url = p => '/uploads/' + path.relative(process.env.UPLOADS_DIR, p).replace(/\\/g, '/');

    const res = await save(admin, contractId, () => {}, { removeImages: [url(scan), url(sig)] });
    expect(res.status).toBe(200);
    expect(row(contractId).contract_image_path).toBeNull();
    expect(fs.existsSync(scan)).toBe(false);
    expect(JSON.parse(row(contractId).extra_images)).toHaveLength(1); // signature kept
    expect(fs.existsSync(sig)).toBe(true);
    expect(log(contractId).detail).toMatch(/^Images removed: Contract — Reason:/);
  });
});

describe('New Contract and Record Payment', () => {
  test('a badly placed comma is refused; monthly cleanings months are checked and saved', async () => {
    const post = o => admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData(o)) });
    expect((await post({ details: { spaPrice: '20,0300' } })).body.error).toMatch(/^Spa price looks wrong: 20,0300/);
    expect((await post({ misc: { monthlyCleanings: true, cleaningMonths: '0' } })).body.error).toMatch(/months must be a whole number/);
    const ok = await post({ misc: { monthlyCleanings: true, cleaningPrice: '45', cleaningMonths: '3', cleaningIncluded: true } });
    expect(ok.status).toBe(200);
    expect(data(ok.body.contractId).misc).toMatchObject({ cleaningMonths: '3', cleaningIncluded: true });
    const { contractId } = await createContract(admin, { costing: { grandTotal: '9000' }, details: { spaPrice: '9000' } });
    expect((await admin.post('/api/payments').send({ contractId, amount: '1,5000', method: 'cash' })).body.error).toMatch(/^Amount looks wrong: 1,5000/);
  });

  test('New Contract: a Grand Total that doesn\'t add up from the prices is refused', async () => {
    const post = o => admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData(o)) });
    const bad = await post({ details: { spaPrice: '9000' }, costing: { taxPercent: '8.1', grandTotal: '9000' }, payment: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('The totals don\'t add up — refresh the page and try again.');
    const ok = await post({ details: { spaPrice: '9000', steps: { price: '500', included: false } }, costing: { taxPercent: '8.1', grandTotal: '10269.50' }, payment: {} });
    expect(ok.status).toBe(200);
  });
});
