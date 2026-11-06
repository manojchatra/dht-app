// routes/address.js — Address suggestions for the New Contract / Edit form.
// Our server asks Google (Places API New), so the key stays in .env and never
// reaches a page. No key, or Google slow or down: no suggestions, and the
// address is simply typed by hand.
const express = require('express');
const router  = express.Router();

const PLACES = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 4000;
const MAX_SUGGESTIONS = 5;
const LIMIT_PER_MINUTE = 60; // per user; each Google call is billable

// Arizona first; the rest of the US still shows.
const ARIZONA = { low: { latitude: 31.33, longitude: -114.82 }, high: { latitude: 37.0, longitude: -109.04 } };

const uses = new Map();
function overLimit(userId) {
  const now = Date.now();
  const u = uses.get(userId);
  if (!u || now - u.start >= 60000) { uses.set(userId, { start: now, count: 1 }); return false; }
  u.count += 1;
  return u.count > LIMIT_PER_MINUTE;
}

// Groups one address's lookups for Google's billing; the page makes one up.
const sessionToken = req => {
  const s = String(req.query.session || '');
  return /^[A-Za-z0-9_-]{1,36}$/.test(s) ? s : '';
};

const askGoogle = async (url, key, fieldMask, options = {}) => {
  const r = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Google answered ${r.status}`);
  return r.json();
};

/** Google's address parts → the form's Address, City, State and Zip. */
function addressFields(parts) {
  const part = (type, form = 'longText') => {
    const p = parts.find(x => (x.types || []).includes(type));
    return (p && p[form]) || '';
  };
  const unit = part('subpremise');
  const street = [part('street_number'), part('route', 'shortText')].filter(Boolean).join(' ');
  const city = ['locality', 'postal_town', 'sublocality_level_1', 'neighborhood', 'administrative_area_level_3']
    .map(t => part(t)).find(Boolean) || '';
  return {
    address: (street + (street && unit ? ` #${unit}` : '')).slice(0, 150),
    city: city.slice(0, 60),
    state: part('administrative_area_level_1', 'shortText').slice(0, 2),
    zip: part('postal_code').slice(0, 5),
  };
}

router.get('/suggest', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  const q = String(req.query.q || '').trim();
  if (!key || q.length < 3 || q.length > 150 || overLimit(req.session.userId)) return res.json({ suggestions: [] });
  try {
    const session = sessionToken(req);
    const data = await askGoogle(`${PLACES}/places:autocomplete`, key,
      'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text', {
        method: 'POST',
        body: JSON.stringify({
          input: q,
          includedRegionCodes: ['us'],
          languageCode: 'en',
          locationBias: { rectangle: ARIZONA },
          ...(session ? { sessionToken: session } : {}),
        }),
      });
    const suggestions = (data.suggestions || [])
      .map(s => s.placePrediction)
      .filter(p => p && p.placeId && p.text && p.text.text)
      .slice(0, MAX_SUGGESTIONS)
      .map(p => ({ placeId: p.placeId, text: p.text.text.replace(/, USA$/, '') }));
    res.json({ suggestions });
  } catch (e) {
    console.error('[address] suggest:', e.message);
    res.json({ suggestions: [] });
  }
});

router.get('/place/:placeId', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.status(503).json({ error: 'Address lookup is not set up' });
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(req.params.placeId)) return res.status(400).json({ error: 'Invalid address' });
  if (overLimit(req.session.userId)) return res.status(429).json({ error: 'Too many address lookups' });
  try {
    const session = sessionToken(req);
    const data = await askGoogle(
      `${PLACES}/places/${req.params.placeId}?languageCode=en&regionCode=us${session ? `&sessionToken=${session}` : ''}`,
      key, 'addressComponents');
    res.json(addressFields(data.addressComponents || []));
  } catch (e) {
    console.error('[address] place:', e.message);
    res.status(502).json({ error: 'Address lookup failed' });
  }
});

module.exports = router;
