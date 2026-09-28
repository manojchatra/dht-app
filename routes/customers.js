/**
 * customers.js — customer lookups. No UI page uses GET /:id yet; it's there
 * so a future Customers tab / service app can be a page-only job.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireRole, requireAdmin } = require('../middleware/auth');
const { findMatches } = require('../services/customers');

// GET /api/customers/search?phone=..&phone=..&email=..&name=..
// Backs the "Existing customer?" popup on the contract form.
router.get('/search', requireRole(['admin', 'sales']), (req, res) => {
  try {
    const phones = [].concat(req.query.phone || []);
    res.json({ matches: findMatches({ phones, email: req.query.email, name: req.query.name }) });
  } catch (err) {
    console.error('Customer search error:', err);
    res.status(500).json({ error: 'Customer search failed' });
  }
});

// GET /api/customers/:id — one customer with all their contracts.
router.get('/:id', requireAdmin, (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const contracts = db.prepare(`
      SELECT id, contract_number, store, date, status, make, model, serial_number,
        delivery_date, salesman, grand_total,
        json_extract(data,'$.customer.address') AS delivery_address,
        json_extract(data,'$.customer.city')    AS delivery_city
      FROM contracts WHERE customer_id=? ORDER BY date DESC, id DESC
    `).all(req.params.id);
    res.json({ ...customer, contracts });
  } catch (err) {
    console.error('Customer fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

module.exports = router;
