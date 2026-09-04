/**
 * sales.js — Stage 6: dedicated Sales section
 * Separate entry point from Settings' generic Add User flow for creating
 * sales-role users, plus the salesperson list/profile views.
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const db      = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

// GET /api/sales/active/list — {id, name} for active salespeople only, no
// admin gate: any authenticated user creating a contract needs this for the
// salesman dropdown (a sales-role user only ever selects themself there, but
// still needs the full active list to populate the <select>).
router.get('/active/list', (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, COALESCE(name, username) AS name FROM users WHERE role='sales' AND active=1 ORDER BY name`).all();
    res.json(rows);
  } catch (err) {
    console.error('Active salespeople list error:', err);
    res.status(500).json({ error: 'Failed to load salespeople' });
  }
});

router.use(requireAdmin);

// GET /api/sales — list of salespeople with contract counts (admin only —
// includes email and per-person contract counts, unlike the list above)
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id, COALESCE(u.name, u.username) AS name, u.username, u.email, u.active,
        COUNT(c.id) AS contract_count
      FROM users u
      LEFT JOIN contracts c ON c.salesman_user_id = u.id
      WHERE u.role = 'sales'
      GROUP BY u.id
      ORDER BY name
    `).all();
    res.json(rows);
  } catch (err) {
    console.error('Sales list error:', err);
    res.status(500).json({ error: 'Failed to load salespeople' });
  }
});

// GET /api/sales/:id — profile + their contracts
router.get('/:id', (req, res) => {
  try {
    const user = db.prepare(`SELECT id, COALESCE(name, username) AS name, username, email, active FROM users WHERE id=? AND role='sales'`).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const contracts = db.prepare(`
      SELECT c.id, c.contract_number, c.status, c.date, c.grand_total,
        COALESCE(json_extract(c.data,'$.customer.name'), cu.name, '') AS customer_name
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.salesman_user_id = ?
      ORDER BY c.created_at DESC
    `).all(req.params.id);

    res.json({ ...user, contracts });
  } catch (err) {
    console.error('Sales profile error:', err);
    res.status(500).json({ error: 'Failed to load salesperson' });
  }
});

// POST /api/sales — add a new salesperson
router.post('/', (req, res) => {
  const { name, username, email, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, role, name, email) VALUES (?,?,?,?,?)'
    ).run(username.trim().toLowerCase(), hash, 'sales', name.trim(), email.trim());
    res.json({ success: true, userId: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Failed to create salesperson' });
  }
});

// PATCH /api/sales/:id/active — toggle active/inactive
router.patch('/:id/active', (req, res) => {
  const { active } = req.body;
  if (active !== 0 && active !== 1) return res.status(400).json({ error: 'active must be 0 or 1' });
  const user = db.prepare(`SELECT id FROM users WHERE id=? AND role='sales'`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET active=? WHERE id=?').run(active, req.params.id);
  res.json({ success: true });
});

module.exports = router;
