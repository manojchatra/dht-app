'use strict';
// Nov 2026: back-dated contracts (delivery date already past) don't make
// dashboard news — no notification, no "awaiting order placement" email, not
// in Recent Contracts; View Contracts sorts by contract date with a From / To
// filter; Continue Editing on the preview fills New Contract in again.
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

let ctx, admin, email;
beforeAll(async () => {
  ctx = createTestApp();
  email = require('../utils/emailSender'); // the jest mock from createTestApp
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

describe('Back-dated contracts', () => {
  const tbo = { status: 'tbo', serialNumber: '', make: 'Caldera', model: 'Utopia' };
  const notified = id => ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE contract_id=? AND event_type='CONTRACT_CREATED'").get(id).n;

  test('no dashboard notification and no To Be Ordered email; flagged in the list', async () => {
    email.notifyContractCreatedTBO.mockClear();
    const back = await createContract(admin, { date: '2026-03-02', deliveryDate: '2026-03-20', product: tbo });
    expect(notified(back.contractId)).toBe(0);
    expect(email.notifyContractCreatedTBO).not.toHaveBeenCalled();

    const now = await createContract(admin, { product: tbo });
    expect(notified(now.contractId)).toBe(1);
    expect(email.notifyContractCreatedTBO).toHaveBeenCalledTimes(1);

    const list = (await admin.get('/api/contracts')).body;
    expect(list.find(c => c.id === back.contractId).back_entered).toBe(1);
    expect(list.find(c => c.id === now.contractId).back_entered).toBe(0);
  });

  test('payments taken at signing are dated with the sale date; a current contract\'s with today', async () => {
    const payDates = id => ctx.db.prepare('SELECT date FROM payments WHERE contract_id=?').all(id).map(p => p.date);
    const back = await createContract(admin, { date: '2026-03-02', deliveryDate: '2026-03-20' });
    expect(payDates(back.contractId)).toEqual(['2026-03-02']);

    const { phoenixToday } = require('../utils/arizona');
    const now = await createContract(admin, { date: '2026-03-02' }); // delivery still ahead
    expect(payDates(now.contractId)).toEqual([phoenixToday()]);
  });

  test('Recent Contracts on the dashboard leaves them out', () => {
    const src = page('dashboard.html');
    const fn = src.slice(src.indexOf('function renderRecentContracts'), src.indexOf('function renderShowroomBreakdown'));
    const el = { innerHTML: '' };
    const render = new Function('document', 'escHtml', 'STATUS_BADGE', 'STATUS_LABEL', fn + 'return renderRecentContracts;')(
      { getElementById: () => el }, s => String(s), {}, {});
    const rows = [{ id: 1, contract_number: 'OLD-SALE', back_entered: 1 },
      ...[2, 3, 4, 5, 6].map(id => ({ id, contract_number: 'NEW-' + id, back_entered: 0 }))];
    render(rows);
    expect(el.innerHTML).not.toContain('OLD-SALE');
    expect(el.innerHTML.match(/NEW-\d/g)).toEqual(['NEW-2', 'NEW-3', 'NEW-4', 'NEW-5', 'NEW-6']);
  });
});

describe('View Contracts', () => {
  const src = page('view-contracts.html');
  const { contractDay, byContractDate } = new Function(
    src.slice(src.indexOf('function contractDay'), src.indexOf('async function loadContracts')) + 'return { contractDay, byContractDate };')();

  test('newest contract date first; same date keeps the order entered', () => {
    const list = [
      { id: 'entered-today-old-sale', date: '2026-03-02' },
      { id: 'b', date: '2026-11-09' },
      { id: 'a', date: '2026-11-09' },
      { id: 'c', date: '2026-11-10' },
      { id: 'no-date', date: '', created_at: '2026-10-01 10:00:00' },
    ];
    expect(byContractDate(list).map(c => c.id)).toEqual(['c', 'b', 'a', 'no-date', 'entered-today-old-sale']);
    expect(contractDay({ date: '2026-11-09' })).toBe('2026-11-09');
  });

  test('From / To on the contract date, kept in the address and cleared with Clear filters', () => {
    expect(src).toMatch(/from:'fromDate',to:'toDate'/);
    expect(src).toMatch(/if\(from&&contractDay\(c\)<from\)return false;/);
    expect(src).toMatch(/if\(to&&contractDay\(c\)>to\)return false;/);
    expect(src).toMatch(/id="fromDateText"[^>]*filterCards\(\)/);
    expect(src).toMatch(/function clearFilters\(\)\{[^}]*\}\);\s*syncDateBoxes\(\);/);
  });
});

describe('Status page Delivered tab', () => {
  const src = page('status.html');

  test('sorted by contract date like View Contracts; the other tabs keep the server order', () => {
    const { byContractDate } = new Function(
      src.slice(src.indexOf('function contractDay'), src.indexOf('function updateTabCounts')) + 'return { byContractDate };')();
    const list = [{ id: 'old-sale', date: '2026-03-02' }, { id: 'b', date: '2026-11-09' }, { id: 'a', date: '2026-11-09' }, { id: 'c', date: '2026-11-10' }];
    expect(byContractDate(list).map(c => c.id)).toEqual(['c', 'b', 'a', 'old-sale']);
    expect(src).toMatch(/const filtered=allContracts\.filter\(c=>c\.status===currentTab&&matchesFilters\(c,q,r\)\);\s*if\(currentTab==='delivered'\) byContractDate\(filtered\);/);
  });
});

describe('Continue Editing', () => {
  test('the preview goes back to New Contract with resume=1', () => {
    const src = page('preview-contract.html');
    expect(src).toMatch(/window\.location\.href = '\/contracts\/new\?resume=1'/);
    expect(src).toMatch(/sessionStorage\.removeItem\('draftContractUi'\)/); // after a save
  });

  test('photos from the preview are kept unless replaced; new extras are added after them', () => {
    const src = page('create-contract.html');
    const withKeptUploads = new Function(src.slice(src.indexOf('function withKeptUploads'), src.indexOf('// What Continue Editing needs')) + 'return withKeptUploads;')();
    const kept = { contractImagePath: '/up/c1.jpg', chequeImagePath: '/up/q1.jpg', extraImages: [{ path: '/up/e1.jpg', label: 'Waiver' }] };
    expect(withKeptUploads({}, kept)).toEqual(kept);
    expect(withKeptUploads({ contractImagePath: '/up/c2.jpg', extraImages: [{ path: '/up/e2.jpg', label: 'Site' }] }, kept)).toEqual({
      contractImagePath: '/up/c2.jpg', chequeImagePath: '/up/q1.jpg',
      extraImages: [{ path: '/up/e1.jpg', label: 'Waiver' }, { path: '/up/e2.jpg', label: 'Site' }],
    });
    expect(withKeptUploads({ contractImagePath: '/up/c3.jpg' }, null)).toEqual({ contractImagePath: '/up/c3.jpg' });
    expect(src).toMatch(/data\._uploadedPaths=withKeptUploads\(uploadedPaths,keptUploads\);\s*sessionStorage\.setItem\('draftContract',JSON\.stringify\(data\)\);\s*sessionStorage\.setItem\('draftContractUi',JSON\.stringify\(draftUiState\(\)\)\);/);
  });

  // The real script, run against a small stand-in for New Contract.
  function runResume({ draft, ui, search = '?resume=1' }) {
    const els = {};
    const el = id => els[id] || (els[id] = {
      id, value: '', checked: false, style: {}, textContent: '', innerHTML: '', classList: { toggle() {}, add() {} },
      querySelector: sel => (sel === '.card-header' ? { after: box => { els[box.id] = box; } } : null),
      querySelectorAll: () => [], appendChild() {}, closest: () => el('imagesCard'),
    });
    const store = { draftContract: draft && JSON.stringify(draft), draftContractUi: ui && JSON.stringify(ui) };
    const sig = [];
    const context = {
      location: { pathname: '/contracts/new', search },
      sessionStorage: { getItem: k => store[k] || null },
      document: { readyState: 'complete', getElementById: el, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ style: {}, querySelectorAll: () => [] }) },
      escHtml: s => String(s).replace(/</g, '&lt;'), showToast: () => {}, syncTextFromDate: () => {},
      updateSeriesDl() {}, renderColourChips() {}, selectChipFromValue() {}, coloursFor() {}, normColour: (k, v) => v,
      COVER_COLORS: [], toggleCraneFee() {}, onSubpanelChange() {}, onWaterCareChange() {}, recalcAll() {}, refreshFinanceChoice() {},
      contractSigPad: { restore: url => sig.push(url) },
      linkedCustomer: null, dismissedCustomerIds: {}, selectedOrderedUnitId: null, confirmedSerial: '', keptUploads: null,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/contract-edit.js'), 'utf8'), context);
    return { context, el, sig, ready: context.window._onAuthReady ? context.window._onAuthReady() : Promise.resolve() };
  }

  const draft = {
    store: 'Chandler', date: '2026-11-08', deliveryDate: '2026-12-01', salesmanUserId: 4, salesman: 'Sam',
    customer: { name: 'Jane Pool', email: 'jane@example.com', address: '545 N Fraser Dr', city: 'Mesa', zip: '85203',
      phone: { cell: '602-555-0100' }, existingCustomerId: 12 },
    product: { status: 'tbo', make: 'Caldera', series: 'Utopia', model: 'Geneva', serialNumber: '', orderedUnitId: 33, finance: 'Owned' },
    details: { spaPrice: '15000' }, costing: { taxPercent: '8.6' },
    payment: { cheque: { selected: true, number: '1001', amount: '5000' } },
    customerSignature: 'data:image/png;base64,AAA',
    _uploadedPaths: { contractImagePath: '/up/c1.jpg', extraImages: [{ path: '/up/e1.jpg', label: 'Waiver' }] },
  };
  const ui = { invTrigger: 'Caldera Geneva - On order (Truck 23)', orderedNote: 'On order — Truck 23, Web Order # <77>.',
    linkedLabel: 'DHT-C00012 · Jane Pool', dismissed: { 9: true }, confirmedSerial: '' };

  test('fills the form, spa pick, linked customer, signature and kept photos from the draft', async () => {
    const r = runResume({ draft, ui });
    await r.ready;
    const v = id => r.el(id).value;
    expect([v('custName'), v('custCity'), v('custZip'), v('custCell')]).toEqual(['Jane Pool', 'Mesa', '85203', '602-555-0100']);
    expect([v('prodMake'), v('prodSeries'), v('prodModel'), v('dtSpaPrice'), v('costTaxPct')]).toEqual(['Caldera', 'Utopia', 'Geneva', '15000', '8.6']);
    expect([v('payChequeNum'), v('payChequeAmt'), r.el('payChequeSel').checked]).toEqual(['1001', '5000', true]);
    expect([v('saleDate'), v('deliveryDate'), v('salesman')]).toEqual(['2026-11-08', '2026-12-01', '4']);
    expect(vm.runInContext('[selectedStore, selectedStatus, selectedOrderedUnitId]', r.context)).toEqual(['Chandler', 'tbo', 33]);
    expect(v('invTrigger')).toBe(ui.invTrigger);
    expect(r.el('orderedNote').innerHTML).toContain('Web Order # &lt;77>'); // escaped
    expect(v('prodFinance')).toBe('Owned');
    expect(r.context.linkedCustomer).toEqual({ id: 12 });
    expect(r.el('custLinkedLabel').textContent).toBe('DHT-C00012 · Jane Pool');
    expect(r.el('custLinkedBanner').style.display).toBe('flex');
    expect(r.context.dismissedCustomerIds).toEqual({ 9: true });
    expect(r.sig).toEqual(['data:image/png;base64,AAA']);
    expect(r.context.keptUploads).toEqual(draft._uploadedPaths);
    expect(r.el('keptUploads').innerHTML).toContain('Handwritten contract photo');
    expect(r.el('keptUploads').innerHTML).toContain('Waiver');
  });

  test('a plain New Contract (no resume=1) or no draft is left blank', async () => {
    for (const r of [runResume({ draft, ui, search: '' }), runResume({ draft: null, ui: null })]) {
      await r.ready;
      expect(r.el('custName').value).toBe('');
      expect(r.sig).toEqual([]);
    }
  });
});
