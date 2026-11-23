'use strict';
// Nov 2026: the Manufacturer warranty fills itself in from the spa picked
// (public/js/warranty-list.js, from the office's Warranty document): brand
// tick, Components (component & leak), Shell, Cabinet (siding). WLA Desert
// Series ticks WLA, Tylo saunas tick Tylo (core components 5 yrs, Bluetooth
// sound 1 yr), any other make ticks Others with a text box. One brand only.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');
const { warrantyFor, TYLO_WARRANTY } = require('../public/js/warranty-list.js');

const page = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

describe('the warranty list', () => {
  test.each([
    ['Caldera', 'Geneva',          { brand: 'Caldera',   series: 'Utopia',    componentYrs: '5', shellYrs: '10', cabinetYrs: '5' }],
    ['Caldera', 'Makena',          { brand: 'Caldera',   series: 'Paradise',  componentYrs: '5', shellYrs: '10', cabinetYrs: '3' }],
    ['Caldera', 'Aspire',          { brand: 'Caldera',   series: 'Fantasy',   componentYrs: '1', shellYrs: '5',  cabinetYrs: '2' }],
    ['Caldera', 'Aventine',        { brand: 'Caldera',   series: 'Vacanza',   componentYrs: '2', shellYrs: '5',  cabinetYrs: '2' }],
    ['HotSpring', 'Sovereign IIN', { brand: 'HotSpring', series: 'Highlife',  componentYrs: '5', shellYrs: '7',  cabinetYrs: '5' }],
    ['HotSpring', 'Jetsetter LX',  { brand: 'HotSpring', series: 'Highlife' }],
    ['HotSpring', 'Beam II',       { brand: 'HotSpring', series: 'Limelight', componentYrs: '5', shellYrs: '7',  cabinetYrs: '5' }],
    ['HotSpring', 'PACE',          { brand: 'HotSpring', series: 'Hot Spot',  componentYrs: '2', shellYrs: '5',  cabinetYrs: '2' }],
    ['HotSpring', 'Monterey Premier', { brand: 'HotSpring', series: 'Freeflow', componentYrs: '1', shellYrs: '5', cabinetYrs: '2' }],
    ['HotSpring', 'Vigor',         { brand: 'HotSpring', series: 'Cold Plunge', componentYrs: '3', shellYrs: '5', cabinetYrs: '3' }],
    ['Endless Pools', 'E700',      { brand: 'EP',        series: 'Fitness Systems', componentYrs: '5', shellYrs: '10', cabinetYrs: '5' }],
    ['Endless Pools', 'R220',      { brand: 'EP',        series: 'RecSport',  componentYrs: '3', shellYrs: '10', cabinetYrs: '3' }],
    ['', 'Geneva',                 { brand: 'Caldera',   series: 'Utopia' }],
  ])('%s %s', (make, model, want) => expect(warrantyFor(make, model)).toMatchObject(want));

  test('not on the list: the brand is ticked and the years are typed; Tylo gets its own lines; anything else is Others', () => {
    expect(warrantyFor('WLA', '735L')).toEqual({ brand: 'WLA', series: '', componentYrs: '', shellYrs: '', cabinetYrs: '', tyloCoreYrs: '', tyloSoundYrs: '' });
    expect(warrantyFor('HotSpring', 'Propel')).toMatchObject({ brand: 'HotSpring', componentYrs: '' });
    expect(warrantyFor('Tylo', 'Halmstad 3')).toMatchObject({ brand: 'Tylo', componentYrs: '', tyloCoreYrs: '5', tyloSoundYrs: '1' });
    expect(TYLO_WARRANTY).toEqual({ tyloCoreYrs: '5', tyloSoundYrs: '1' });
    expect(warrantyFor('LifeSmart', 'LS350')).toMatchObject({ brand: 'Others', componentYrs: '' });
    expect(warrantyFor('', '')).toBeNull();
  });
});

describe('New Contract / Edit form', () => {
  const src = page('create-contract.html');

  test('Tylo and Others next to EP; the model list matches the Warranty document', () => {
    expect(src).toMatch(/value="EP"> EP<\/label>\s*<label class="cb-item"><input type="checkbox" class="mfg-brand" value="Tylo"> Tylo<\/label>\s*<label class="cb-item"><input type="checkbox" class="mfg-brand" value="Others"> Others<\/label>/);
    expect(src).toMatch(/'Vacanza':\['Palatino','Marino','Vanto','Tarino','Aventine','Celio'\],'Fantasy':\['Bloom','Entice','Splendor','Invite','Aspire'\]/);
    expect(src).not.toMatch(/Embrace|Enamor|'Drift'|Discovery/);
    expect(src).toMatch(/'Sovereign','Triumph'/);
    expect(src).toMatch(/'Florence','Provence'/);
    expect(src).toMatch(/'X-Series':\['X2000','X500','X200'\]/);
    expect(src).toMatch(/<script src="\/js\/warranty-list\.js"><\/script>/);
    // Picking a model or a spa from Inventory Search fills it in; loading a saved contract doesn't.
    expect(src).toMatch(/function selectModel\(m\)\{[^\n]*applySpaWarranty\(make,m\);\}/);
    expect(src).toMatch(/applySpaWarranty\(row\.make\|\|'', row\.model\|\|''\);/);
    expect(page('js/contract-edit.js')).not.toMatch(/applySpaWarranty/);
    expect(page('js/contract-edit.js')).toMatch(/setVal\('mfgTyloCore', mfg\.tyloCoreYrs\); setVal\('mfgTyloSound', mfg\.tyloSoundYrs\); setVal\('mfgOther', mfg\.otherText\);/);
  });

  // Runs the page's own functions against a stub form.
  function form() {
    const el = {};
    for (const id of ['mfgComp', 'mfgShell', 'mfgCabinet', 'mfgTyloCore', 'mfgTyloSound', 'mfgOther', 'mfgTyloBox', 'mfgYears', 'mfgOtherBox', 'mfgHint'])
      el[id] = { value: '', textContent: '', style: { display: '' } };
    const mk = vals => vals.map(value => ({ value, checked: false, addEventListener(t, f) { this.onchange = f; } }));
    const mfg = mk(['HotSpring', 'Caldera', 'WLA', 'EP', 'Tylo', 'Others']), dlr = mk(['HotSpring', 'Caldera', 'WLA', 'EP']);
    const document = {
      getElementById: id => el[id],
      querySelectorAll: s => (s === '.mfg-brand' ? mfg : s === '.dlr-brand' ? dlr : []),
      querySelector: s => { const m = s.match(/^\.mfg-brand\[value="(\w+)"\]:checked$/); return m ? mfg.find(b => b.value === m[1] && b.checked) || null : null; },
    };
    const code = src.slice(src.indexOf('function applySpaWarranty('), src.indexOf('// ── Address suggestions'));
    const fns = new Function('document', 'warrantyFor', 'TYLO_WARRANTY', code + '; return { applySpaWarranty, updateMfgBoxes };')(document, warrantyFor, TYLO_WARRANTY);
    const ticked = list => list.filter(b => b.checked).map(b => b.value);
    return { el, mfg, dlr, ticked, ...fns };
  }

  test('a spa on the list ticks its brand and fills the years', () => {
    const f = form();
    f.applySpaWarranty('Caldera', 'Geneva');
    expect(f.ticked(f.mfg)).toEqual(['Caldera']);
    expect([f.el.mfgComp.value, f.el.mfgShell.value, f.el.mfgCabinet.value]).toEqual(['5', '10', '5']);
    expect(f.el.mfgTyloBox.style.display).toBe('none');
    expect(f.el.mfgHint.textContent).toMatch(/Geneva \(Utopia\)/);
    f.applySpaWarranty('HotSpring', 'Vigor'); // picking another spa replaces it
    expect(f.ticked(f.mfg)).toEqual(['HotSpring']);
    expect(f.el.mfgShell.value).toBe('5');
  });

  test('Tylo shows its two lines (5 and 1 years); Others shows the text box', () => {
    const f = form();
    f.applySpaWarranty('Tylo', 'Halmstad 3');
    expect(f.ticked(f.mfg)).toEqual(['Tylo']);
    expect(f.el.mfgTyloBox.style.display).toBe('grid');
    expect(f.el.mfgYears.style.display).toBe('none');
    expect([f.el.mfgTyloCore.value, f.el.mfgTyloSound.value]).toEqual(['5', '1']);
    f.applySpaWarranty('LifeSmart', 'LS350');
    expect(f.ticked(f.mfg)).toEqual(['Others']);
    expect(f.el.mfgOtherBox.style.display).toBe('block');
    expect(f.el.mfgTyloBox.style.display).toBe('none');
  });

  test('one brand only, in both Manufacturer and Dealership', () => {
    const f = form();
    for (const list of [f.mfg, f.dlr]) {
      list[0].checked = true;
      list[1].checked = true; list[1].onchange.call(list[1]);
      expect(f.ticked(list)).toEqual([list[1].value]);
    }
    const tylo = f.mfg.find(b => b.value === 'Tylo');
    tylo.checked = true; tylo.onchange.call(tylo); // ticking Tylo by hand fills its defaults
    expect([f.el.mfgTyloCore.value, f.el.mfgTyloSound.value]).toEqual(['5', '1']);
  });

  test('saved with the contract: Tylo lines and Others text only when ticked', () => {
    expect(src).toMatch(/tyloCoreYrs:tylo\?v\('mfgTyloCore'\):'',tyloSoundYrs:tylo\?v\('mfgTyloSound'\):'',otherText:b\.indexOf\('Others'\)>=0\?v\('mfgOther'\):''/);
  });
});

describe('saved, edited and printed', () => {
  let ctx, admin;
  beforeAll(async () => {
    ctx = createTestApp();
    admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
  });
  afterAll(() => { destroyTestApp(ctx); });
  const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);

  test('a Tylo contract prints its two lines; the Edit page logs an Others change', async () => {
    const tylo = { manufacturer: { brands: ['Tylo'], tyloCoreYrs: '5', tyloSoundYrs: '1' }, dealership: { brands: [] } };
    const { contractId } = await createContract(admin, { warranty: tylo });
    expect(JSON.parse(row(contractId).data).warranty.manufacturer).toEqual(tylo.manufacturer);
    const { generateContractPDF } = require('../utils/pdfGenerator');
    const pdf = await generateContractPDF({ ...row(contractId), data: JSON.parse(row(contractId).data) });
    expect(Buffer.isBuffer(pdf) || pdf instanceof Uint8Array).toBe(true);
    expect(fs.readFileSync(path.join(__dirname, '../utils/pdfGenerator.js'), 'utf8')).toMatch(/kv\('BLUETOOTH SOUND SYSTEM'/);

    const form = JSON.parse(row(contractId).data);
    form.warranty.manufacturer = { brands: ['Others'], otherText: 'Sundance — 5 yr shell' };
    const res = await admin.post(`/api/contracts/${contractId}/edit`).send({ form, reason: 'Wrong brand' });
    expect(res.status).toBe(200);
    const saved = JSON.parse(row(contractId).data).warranty.manufacturer;
    expect(saved).toMatchObject({ brands: ['Others'], otherText: 'Sundance — 5 yr shell', tyloCoreYrs: '' });
    const log = ctx.db.prepare("SELECT detail FROM activity_log WHERE contract_id=? AND event_type='CONTRACT_EDITED'").get(contractId).detail;
    expect(log).toMatch(/Manufacturer warranty brands Tylo → Others/);
    expect(log).toMatch(/Manufacturer warranty others — → Sundance — 5 yr shell/);
    expect(log).toMatch(/Manufacturer warranty Tylo core components yrs 5 → —/);
  }, 30000);

  test('the contract page and preview show the Tylo lines and Others text', () => {
    expect(page('contract-detail.html')).toMatch(/Bluetooth sound system: <strong>' \+ escHtml\(mfg\.tyloSoundYrs\)/);
    expect(page('contract-detail.html')).toMatch(/Others: <strong>' \+ escHtml\(mfg\.otherText\)/);
    expect(page('preview-contract.html')).toMatch(/pKV\('Tylo Core Components Yrs',mfg\.tyloCoreYrs\)/);
  });
});
