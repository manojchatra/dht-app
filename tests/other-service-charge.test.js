'use strict';
// Other Service Charge (below Discount on New Contract): Yes/No, what it's for
// and an amount — a service charge, so not taxed: it goes into Service Total
// and the Grand Total. Shown on the preview, contract page and PDF; editable
// on the Edit page.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, contractFormData, createContract } = require('./helpers/fixtures');

let ctx, admin, totals;
beforeAll(async () => {
  ctx = createTestApp();
  totals = require('../utils/contractTotals');
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const other = (description, price) => ({ yes: true, description, price });
// Spa $9,000 at 8.1% tax, plus a $350 other service charge (not taxed).
const withCharge = (os = other('Fence panel removal', '350')) => ({
  details: { spaPrice: '9000', otherService: os },
  costing: { taxPercent: '8.1', grandTotal: String(totals.computeTotals({ spaPrice: '9000', otherService: os }, {}, '8.1').grandTotal) },
});

test('totals: added to Service Total and the Grand Total, not taxed; ignored when No', () => {
  const t = totals.computeTotals({ spaPrice: '9000', otherService: other('Fence', '1,350') }, { crane: true, craneFee: '400' }, '8.1');
  expect(t).toMatchObject({ subtotal: 9000, tax: 729, serviceTotal: 1750, grandTotal: 11479 });
  expect(totals.computeTotals({ spaPrice: '9000', otherService: { yes: false, price: '350' } }, {}, '8.1').serviceTotal).toBe(0);
  expect(totals.checkOtherService(other('', '350'))).toMatch(/what the charge is for/);
  expect(totals.checkOtherService(other('Fence', ''))).toMatch(/enter the amount/);
  expect(totals.checkOtherService({ yes: false })).toBeNull();
});

test('New Contract saves it in the Grand Total; Yes needs a description and an amount', async () => {
  const { contractId } = await createContract(admin, withCharge());
  expect(row(contractId).grand_total).toBe('10079'); // 9000 + 729 tax + 350
  expect(JSON.parse(row(contractId).data).details.otherService).toEqual(other('Fence panel removal', '350'));

  const post = o => admin.post('/api/contracts').send({ data: JSON.stringify(contractFormData(o)) });
  expect((await post(withCharge(other('', '350')))).body.error).toMatch(/what the charge is for/);
  expect((await post(withCharge(other('Fence', '')))).body.error).toMatch(/enter the amount/);
  expect((await post(withCharge(other('Fence', '3,50')))).body.error).toMatch(/Other service charge looks wrong/);
});

test('the Edit page adds it, recalculates and logs it', async () => {
  const { contractId } = await createContract(admin, { details: { spaPrice: '9000' }, costing: { taxPercent: '8.1', grandTotal: '9729' } });
  const form = JSON.parse(row(contractId).data);
  form.details.otherService = other('Crane permit', '200');
  form.costing.grandTotal = '9929';
  const res = await admin.post(`/api/contracts/${contractId}/edit`).send({ form, reason: 'Missed on the contract' });
  expect(res.status).toBe(200);
  expect(res.body.totals).toMatchObject({ serviceTotal: 200, grandTotal: 9929 });
  const log = ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='CONTRACT_EDITED'").get(contractId).detail;
  expect(log).toMatch(/Other service charge — → yes/);
  expect(log).toMatch(/Other service charge for — → Crane permit/);
  expect(log).toMatch(/Other service charge price — → 200/);

  form.details.otherService = other('', '200');
  const bad = await admin.post(`/api/contracts/${contractId}/edit`).send({ form, reason: 'x' });
  expect(bad.body.error).toMatch(/what the charge is for/);
});

test('shown on the PDF', async () => {
  const { contractId } = await createContract(admin, withCharge(other('Fence panel removal', '350')));
  const { generateContractPDF } = require('../utils/pdfGenerator');
  const c = row(contractId);
  const pdf = await generateContractPDF({ ...c, data: JSON.parse(c.data) });
  expect(Buffer.isBuffer(pdf) || pdf instanceof Uint8Array).toBe(true);
  const src = fs.readFileSync(path.join(__dirname, '../utils/pdfGenerator.js'), 'utf8');
  expect(src).toMatch(/text:'Other Service Charge'/);
}, 30000);

test('the form, preview, contract page and Edit page carry it', () => {
  const form = page('create-contract.html');
  expect(form.indexOf('name="otherService"')).toBeGreaterThan(form.indexOf('id="dtDiscountPrice"')); // below Discount
  expect(form).toMatch(/otherService:\{yes:rd\('otherService'\)==='yes',description:v\('dtOtherServiceDesc'\),price:v\('dtOtherServicePrice'\)\}/);
  expect(form).toMatch(/var serviceTotal = cents\(crane\+outTown\+spaRem\+fuel\+otherSvc\);/);
  expect(form).toMatch(/dtOtherServicePrice:'Other service charge'/);
  expect(page('preview-contract.html')).toMatch(/pRow\('Other Service Charge',de\.otherService\.description/);
  expect(page('contract-detail.html')).toMatch(/pRow\('Other Service Charge', de\.otherService\.description/);
  expect(page('js/contract-edit.js')).toMatch(/setVal\('dtOtherServiceDesc', g\('otherService'\)\.description\)/);
});
