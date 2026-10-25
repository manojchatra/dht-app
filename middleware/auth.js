/**
 * auth.js — Session-based authentication middleware
 */

/**
 * The logged-in user, re-read from the database on every request: a
 * deactivated or deleted account is logged out at once, and a role or team
 * change applies on the next click (they used to be read only at login and
 * kept for the whole 6-hour session). Returns false if the session is no
 * longer valid (it is then destroyed).
 */
function refreshSessionUser(req) {
  if (!(req.session && req.session.userId)) return false;
  const db = require('../db/database');
  const user = db.prepare('SELECT id, username, role, team, active FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.active === 0) {
    req.session.destroy(() => {});
    return false;
  }
  req.session.username = user.username;
  req.session.role     = user.role;
  req.session.team     = user.team || null;
  return true;
}

/** Redirect to login if not authenticated (for page routes) */
function requireAuth(req, res, next) {
  if (refreshSessionUser(req)) return next();
  // req.originalUrl (not req.path) — routes mounted via app.use('/api/x', requireAuth, router)
  // have '/api/x' stripped from req.path by the time this middleware runs, so that check
  // never matched and every unauthenticated API request silently redirected instead of
  // returning JSON. req.originalUrl always holds the full request path regardless of mounting.
  if (req.xhr || req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

/** Return 401 JSON if not authenticated (for API routes) */
function requireAuthAPI(req, res, next) {
  if (refreshSessionUser(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/** Require admin role */
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  if (req.xhr || req.originalUrl.startsWith('/api/')) {
    return res.status(403).json({ error: 'Forbidden — Admin only' });
  }
  res.status(403).send('Forbidden');
}

/** Require one of the given roles */
function requireRole(roles) {
  return (req, res, next) => {
    if (req.session && roles.includes(req.session.role)) return next();
    if (req.xhr || req.originalUrl.startsWith('/api/')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.status(403).send('Forbidden');
  };
}

module.exports = { requireAuth, requireAuthAPI, requireAdmin, requireRole, refreshSessionUser };
