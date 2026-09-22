/**
 * auth.js — Session-based authentication middleware
 */

/** Redirect to login if not authenticated (for page routes) */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
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
  if (req.session && req.session.userId) return next();
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

module.exports = { requireAuth, requireAuthAPI, requireAdmin, requireRole };
