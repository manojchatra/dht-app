const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, JSON.stringify(value));
}

// GET /api/settings/tax-rates
router.get('/tax-rates', (req, res) => {
  res.json(getSetting('tax_rates') || {});
});

// PUT /api/settings/tax-rates (admin only)
router.put('/tax-rates', requireAdmin, (req, res) => {
  const rates = req.body;
  if (typeof rates !== 'object') return res.status(400).json({ error: 'Invalid data' });
  setSetting('tax_rates', rates);
  res.json({ success: true });
});

// GET /api/settings/email-recipients (admin only — staff email addresses)
router.get('/email-recipients', requireAdmin, (req, res) => {
  res.json(getSetting('email_recipients') || []);
});

// PUT /api/settings/email-recipients (admin only)
router.put('/email-recipients', requireAdmin, (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  setSetting('email_recipients', emails);
  res.json({ success: true });
});

// GET / PUT /api/settings/exception-emails (admin only) — who gets the
// "Delivery exception" email (photos + details) when a crew notes an exception
// on the acknowledgement form (Nov 2026). Empty = no email.
router.get('/exception-emails', requireAdmin, (req, res) => {
  res.json(getSetting('exception_email_recipients') || []);
});
router.put('/exception-emails', requireAdmin, (req, res) => {
  const { emails } = req.body || {};
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  const clean = [...new Set(emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = clean.find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad) return res.status(400).json({ error: `Not an email address: ${bad}` });
  setSetting('exception_email_recipients', clean);
  res.json({ success: true, emails: clean });
});

// GET /api/settings/review-urls (admin only) — per-store Google review links
router.get('/review-urls', requireAdmin, (req, res) => {
  res.json(getSetting('review_urls') || {});
});

// PUT /api/settings/review-urls (admin only) — body: { Phoenix: 'https://...', ... }
router.put('/review-urls', requireAdmin, (req, res) => {
  const urls = req.body;
  if (!urls || typeof urls !== 'object' || Array.isArray(urls)) return res.status(400).json({ error: 'Invalid data' });
  const clean = {};
  for (const [store, raw] of Object.entries(urls)) {
    const url = String(raw || '').trim();
    if (!url) continue; // blank = no link for that store
    if (!/^https?:\/\/\S+$/i.test(url)) return res.status(400).json({ error: `${store}: link must start with http:// or https://` });
    clean[store] = url;
  }
  setSetting('review_urls', clean);
  res.json({ success: true });
});

module.exports = router;
