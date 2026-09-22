const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');

// PATCH /api/users/me/password — change own password (any logged-in role).
// Must be registered before the router-wide requireAdmin gate below, or it's
// unreachable for every non-admin role despite the comment/intent.
router.patch('/me/password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);
  logActivity(db, { eventType: 'PASSWORD_CHANGED', actor: req.session.username || 'system', detail: 'Self-service password change' });
  res.json({ success: true });
});

// Everything below requires admin.
router.use(requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, name, email, role, team, created_at FROM users ORDER BY role, username'
  ).all();
  res.json(users);
});

// POST /api/users — create user
router.post('/', (req, res) => {
  const { username, password, role, team, name, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  // Sales users are created exclusively via the dedicated Sales section
  // (routes/sales.js) now, not this generic form.
  if (!['admin', 'delivery', 'warehouse'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const cleanUsername = username.trim().toLowerCase();
    const cleanTeam = role === 'delivery' ? (req.body.team || null) : null;
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, role, team, name, email) VALUES (?,?,?,?,?,?)'
    ).run(cleanUsername, hash, role, cleanTeam, name.trim(), email.trim());
    logActivity(db, {
      eventType: 'USER_CREATED', actor: req.session.username || 'system',
      detail: `Created ${cleanUsername} (${role}${cleanTeam ? ', ' + cleanTeam : ''})`
    });
    res.json({ success: true, userId: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id — update password, role, name, or email
router.patch('/:id', (req, res) => {
  const { password, role, name, email } = req.body;
  const id = parseInt(req.params.id);

  // Prevent admin from demoting themselves
  if (id === req.session.userId && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  const before = db.prepare('SELECT username, role, name, email FROM users WHERE id = ?').get(id);
  const actor  = req.session.username || 'system';
  const changes = [];

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    if (before) logActivity(db, { eventType: 'USER_PASSWORD_RESET', actor, detail: `Password reset for ${before.username}` });
  }
  if (role && ['admin', 'delivery', 'warehouse'].includes(role)) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (before && role !== before.role) logActivity(db, { eventType: 'USER_ROLE_CHANGED', actor, detail: `${before.username}: ${before.role} → ${role}` });
  }
  if (name) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), id);
    if (before && name.trim() !== before.name) changes.push(`name: "${before.name || ''}" → "${name.trim()}"`);
  }
  if (email) {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email.trim(), id);
    if (before && email.trim() !== before.email) changes.push(`email: "${before.email || ''}" → "${email.trim()}"`);
  }
  if (before && changes.length) {
    logActivity(db, { eventType: 'USER_UPDATED', actor, detail: `${before.username}: ${changes.join(', ')}` });
  }
  res.json({ success: true });
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  const before = db.prepare('SELECT username, role FROM users WHERE id = ?').get(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (before) {
    logActivity(db, {
      eventType: 'USER_DELETED', actor: req.session.username || 'system',
      detail: `Deleted ${before.username} (${before.role})`
    });
  }
  res.json({ success: true });
});

module.exports = router;
