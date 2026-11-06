'use strict';
// Google address suggestions on New Contract / Edit: our server asks Google so
// the key never reaches a page; without a key, or with Google down, the address
// is typed by hand. Google itself is mocked here (global.fetch).
const fs   = require('fs');
const path = require('path');
const request = require('supertest');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent } = require('./helpers/fixtures');

const KEY = 'test-places-key';
const googleOk = body => ({ ok: true, status: 200, json: async () => body });
const prediction = (placeId, text) => ({ placePrediction: { placeId, text: { text } } });

let ctx, admin;
const realFetch = global.fetch;

beforeAll(async () => {
  ctx = createTestApp();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});

beforeEach(() => {
  process.env.GOOGLE_PLACES_KEY = KEY;
  global.fetch = jest.fn();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { jest.restoreAllMocks(); });

afterAll(() => {
  global.fetch = realFetch;
  delete process.env.GOOGLE_PLACES_KEY;
  destroyTestApp(ctx);
});

describe('Suggestions', () => {
  test('logged-out requests are refused', async () => {
    await request(ctx.app).get('/api/address/suggest?q=545+N+Fraser').expect(401);
    await request(ctx.app).get('/api/address/place/abc').expect(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('asks Google for US addresses with Arizona first; at most 5 come back, without the key', async () => {
    global.fetch.mockResolvedValue(googleOk({ suggestions: [
      prediction('p1', '545 N Fraser Dr, Mesa, AZ, USA'), { queryPrediction: {} },
      ...['p2', 'p3', 'p4', 'p5', 'p6'].map(id => prediction(id, `${id} St, Mesa, AZ, USA`)),
    ] }));
    const r = await admin.get('/api/address/suggest?q=545%20N%20Fraser&session=abc-123').expect(200);

    expect(r.body.suggestions).toHaveLength(5);
    expect(r.body.suggestions[0]).toEqual({ placeId: 'p1', text: '545 N Fraser Dr, Mesa, AZ' });
    expect(JSON.stringify(r.body)).not.toContain(KEY);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(options.method).toBe('POST');
    expect(options.headers['X-Goog-Api-Key']).toBe(KEY);
    const body = JSON.parse(options.body);
    expect(body.input).toBe('545 N Fraser');
    expect(body.includedRegionCodes).toEqual(['us']);
    expect(body.locationBias.rectangle.low.latitude).toBeCloseTo(31.33);
    expect(body.sessionToken).toBe('abc-123');
  });

  test('no Google call without a key or for fewer than 3 characters', async () => {
    delete process.env.GOOGLE_PLACES_KEY;
    expect((await admin.get('/api/address/suggest?q=545+N').expect(200)).body).toEqual({ suggestions: [] });
    process.env.GOOGLE_PLACES_KEY = KEY;
    expect((await admin.get('/api/address/suggest?q=54').expect(200)).body).toEqual({ suggestions: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Google down or refusing: empty list, no error for the page', async () => {
    global.fetch.mockRejectedValueOnce(new Error('timeout'));
    expect((await admin.get('/api/address/suggest?q=545+N').expect(200)).body).toEqual({ suggestions: [] });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    expect((await admin.get('/api/address/suggest?q=545+N').expect(200)).body).toEqual({ suggestions: [] });
  });

  test('a bad session token is not passed on', async () => {
    global.fetch.mockResolvedValue(googleOk({}));
    await admin.get('/api/address/suggest?q=545+N&session=' + encodeURIComponent('a&b=c')).expect(200);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).sessionToken).toBeUndefined();
  });
});

describe('Picking an address', () => {
  const parts = extra => ({ addressComponents: [
    { longText: '545', shortText: '545', types: ['street_number'] },
    { longText: 'North Fraser Drive', shortText: 'N Fraser Dr', types: ['route'] },
    { longText: 'Mesa', shortText: 'Mesa', types: ['locality', 'political'] },
    { longText: 'Arizona', shortText: 'AZ', types: ['administrative_area_level_1', 'political'] },
    { longText: '85203', shortText: '85203', types: ['postal_code'] },
    ...extra,
  ] });

  test('returns the four form fields, in the short street form', async () => {
    global.fetch.mockResolvedValue(googleOk(parts([])));
    const r = await admin.get('/api/address/place/ChIJabc_1-2?session=abc').expect(200);
    expect(r.body).toEqual({ address: '545 N Fraser Dr', city: 'Mesa', state: 'AZ', zip: '85203' });

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places/ChIJabc_1-2?languageCode=en&regionCode=us&sessionToken=abc');
    expect(options.headers['X-Goog-FieldMask']).toBe('addressComponents');
  });

  test('a unit number is kept', async () => {
    global.fetch.mockResolvedValue(googleOk(parts([{ longText: '12', shortText: '12', types: ['subpremise'] }])));
    expect((await admin.get('/api/address/place/abc').expect(200)).body.address).toBe('545 N Fraser Dr #12');
  });

  test('a bad id is refused; a failed lookup answers 502; no key answers 503', async () => {
    await admin.get('/api/address/place/' + encodeURIComponent('abc/../x')).expect(400);
    expect(global.fetch).not.toHaveBeenCalled();
    global.fetch.mockRejectedValueOnce(new Error('timeout'));
    await admin.get('/api/address/place/abc').expect(502);
    delete process.env.GOOGLE_PLACES_KEY;
    await admin.get('/api/address/place/abc').expect(503);
  });
});

// Last in the server tests: it uses up the admin's lookups for this minute.
test('each user is limited to 60 lookups a minute', async () => {
  global.fetch.mockResolvedValue(googleOk({}));
  for (let i = 0; i < 60; i++) await admin.get('/api/address/suggest?q=545+N');
  const calls = global.fetch.mock.calls.length;
  expect(calls).toBeLessThanOrEqual(60);
  expect((await admin.get('/api/address/suggest?q=545+N').expect(200)).body).toEqual({ suggestions: [] });
  await admin.get('/api/address/place/abc').expect(429);
  expect(global.fetch.mock.calls.length).toBe(calls);
});

describe('New Contract page', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/create-contract.html'), 'utf8');
  const code = src.slice(src.indexOf('// ── Address suggestions'), src.indexOf('// ── Crane fee toggle'));

  // The page's own functions, run against a small stand-in for the form.
  function page(fetchFn) {
    const els = {};
    const el = id => els[id] || (els[id] = { id, value: '', style: {}, children: [], innerHTML: '',
      appendChild(c) { this.children.push(c); }, addEventListener(t, f) { this[t] = f; }, setAttribute() {} });
    const document = { getElementById: el, createElement: () => el('new' + Object.keys(els).length) };
    const fns = new Function('document', 'fetch', 'setTimeout', 'clearTimeout', 'crypto',
      code + 'return { onAddressInput, pickAddress, hideAddrDd };')(
      document, fetchFn, f => f(), () => {}, { getRandomValues: a => a.fill(7) });
    return { ...fns, el };
  }
  const answer = body => Promise.resolve({ ok: true, json: async () => body });
  const flush = () => new Promise(resolve => setImmediate(resolve));

  test('the Address box is wired up and the key is not in the page', () => {
    expect(src).toMatch(/id="custAddress"[^>]*oninput="onAddressInput\(\)"[^>]*onblur="hideAddrDd\(\)"/);
    expect(src).toMatch(/id="addrDd"/);
    expect(src).not.toMatch(/GOOGLE_PLACES_KEY|X-Goog-Api-Key|places\.googleapis\.com/);
  });

  test('typing lists suggestions with the Google Maps label', async () => {
    const fetchFn = jest.fn(() => answer({ suggestions: [{ placeId: 'p1', text: '545 N Fraser Dr, Mesa, AZ' }] }));
    const p = page(fetchFn);
    p.el('custAddress').value = '545 N';
    p.onAddressInput();
    await flush();
    expect(fetchFn.mock.calls[0][0]).toMatch(/^\/api\/address\/suggest\?q=545%20N&session=[0-9a-f]{32}$/);
    const dd = p.el('addrDd');
    expect(dd.style.display).toBe('block');
    expect(dd.children.map(c => c.textContent)).toEqual(['545 N Fraser Dr, Mesa, AZ', 'Google Maps']);
  });

  test('under 3 characters asks nothing; a late answer after leaving the box is ignored', async () => {
    const fetchFn = jest.fn(() => answer({ suggestions: [{ placeId: 'p1', text: 'x' }] }));
    const p = page(fetchFn);
    p.el('custAddress').value = '54';
    p.onAddressInput();
    expect(fetchFn).not.toHaveBeenCalled();
    p.el('custAddress').value = '545';
    p.onAddressInput();
    p.hideAddrDd();
    await flush();
    expect(p.el('addrDd').style.display).toBe('none');
  });

  test('picking fills Address, City, State and Zip, replacing what was there', async () => {
    const fetchFn = jest.fn(() => answer({ address: '545 N Fraser Dr', city: 'Mesa', state: 'AZ', zip: '85203' }));
    const p = page(fetchFn);
    p.el('custCity').value = 'Old'; p.el('custZip').value = '11111';
    p.pickAddress({ placeId: 'p1', text: '545 N Fraser Dr, Mesa, AZ' });
    await flush();
    expect(fetchFn.mock.calls[0][0]).toMatch(/^\/api\/address\/place\/p1\?session=/);
    expect(['custAddress', 'custCity', 'custState', 'custZip'].map(id => p.el(id).value))
      .toEqual(['545 N Fraser Dr', 'Mesa', 'AZ', '85203']);
  });

  test('tabbing away right after a pick still fills the form; typing again cancels it', async () => {
    const fields = { address: '545 N Fraser Dr', city: 'Mesa', state: 'AZ', zip: '85203' };
    const left = page(() => answer(fields));
    left.pickAddress({ placeId: 'p1', text: '545 N Fraser Dr, Mesa, AZ' });
    left.hideAddrDd(); // the box's blur
    await flush();
    expect(left.el('custZip').value).toBe('85203');

    const typed = page(() => answer(fields));
    typed.pickAddress({ placeId: 'p1', text: '545 N Fraser Dr, Mesa, AZ' });
    typed.el('custAddress').value = '9';
    typed.onAddressInput();
    await flush();
    expect(typed.el('custZip').value).toBe('');
  });

  test('a failed lookup keeps the street and leaves the rest for typing', async () => {
    const p = page(() => Promise.resolve({ ok: false }));
    p.el('custCity').value = 'Mesa';
    p.pickAddress({ placeId: 'p1', text: '545 N Fraser Dr, Mesa, AZ' });
    await flush();
    expect(p.el('custAddress').value).toBe('545 N Fraser Dr');
    expect(p.el('custCity').value).toBe('Mesa');
  });
});
