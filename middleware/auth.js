/**
 * auth.js — Session-based authentication middleware
 */

/** Redirect to login if not authenticated (for page routes) */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.xhr || req.path.startsWith('/api/')) {
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
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Forbidden — Admin only' });
  }
  res.status(403).send('Forbidden');
}

/** Require one of the given roles */
function requireRole(roles) {
  return (req, res, next) => {
    if (req.session && roles.includes(req.session.role)) return next();
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.status(403).send('Forbidden');
  };
}

module.exports = { requireAuth, requireAuthAPI, requireAdmin, requireRole };
