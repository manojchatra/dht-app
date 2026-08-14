const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

// All user management routes require admin
router.use(requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, role, team, created_at FROM users ORDER BY role, username'
  ).all();
  res.json(users);
});

// POST /api/users — create user
router.post('/', (req, res) => {
  const { username, password, role, team } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'sales', 'delivery'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, role, team) VALUES (?,?,?,?)'
    ).run(username.trim().toLowerCase(), hash, role, role==='delivery'?(req.body.team||null):null);
    res.json({ success: true, userId: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id — update password or role
router.patch('/:id', (req, res) => {
  const { password, role } = req.body;
  const id = parseInt(req.params.id);

  // Prevent admin from demoting themselves
  if (id === req.session.userId && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }
  if (role && ['admin', 'sales', 'delivery'].includes(role)) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  res.json({ success: true });
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

// PATCH /api/users/me/password — change own password (any role)
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
  res.json({ success: true });
});

module.exports = router;
