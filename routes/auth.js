const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../db/database');

// ── Simple in-memory rate limiter ─────────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, lockedUntil }
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now    = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (record.lockedUntil > now) {
    const mins = Math.ceil((record.lockedUntil - now) / 60000);
    return { blocked: true, message: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` };
  }
  return { blocked: false };
}

function recordFailure(ip) {
  const now    = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.count = 0; // reset counter so next attempt after lockout starts fresh
  }
  loginAttempts.set(ip, record);
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// Clean up old entries every hour to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (record.lockedUntil < now && record.count === 0) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // Rate limit check
  const limit = checkRateLimit(ip);
  if (limit.blocked) {
    return res.status(429).json({ error: limit.message });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?')
    .get(username.trim().toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(ip);
    // Tell user how many attempts remain before lockout (but don't reveal if it's user vs password)
    const record   = loginAttempts.get(ip) || { count: 0 };
    const remaining = Math.max(0, MAX_ATTEMPTS - record.count);
    const hint = remaining > 0 && remaining <= 2
      ? ` (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout)`
      : '';
    return res.status(401).json({ error: 'Invalid username or password' + hint });
  }

  // Success — clear failed attempts
  clearAttempts(ip);

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    req.session.team     = user.team || null;
    req.session.save(() => res.json({ success: true, role: user.role }));
  });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    userId:   req.session.userId,
    username: req.session.username,
    role:     req.session.role,
    team:     req.session.team || null,
  });
});

module.exports = router;
