const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getInventory, getLastSynced } = require('../services/driveInventory');

// Keyword → substring match against the DB `location` column (case-insensitive).
// 'stock' has no matching floor value in LOCATIONS — treated as "no floor set".
const STORE_MAP = {
  emp: 'emp room',
  phoenix: 'phoenix',
  goodyear: 'goodyear',
  chandler: 'chandler',
  surprise: 'surprise',
  tolleson: 'tolleson',
};

// GET /api/inventory/search?q=sovereign&store=phoenix
// Searches the DB-backed `inventory` table (Stage 3), always filtered to
// availability='In-stock' — Hold/Sold units must never be pickable for a new
// contract. Previously read the read-only Sheets "Inventory" tab via
// searchInventory(); that source had no live link to a DB row, so nothing
// could flag a picked unit Sold. See routes/contracts.js POST / for the
// write-back that now closes that loop.
router.get('/search', (req, res) => {
  try {
    const { q = '', store = '' } = req.query;
    const query = String(q).trim().toLowerCase();
    const storeFilter = String(store).trim().toLowerCase();

    let rows = db.prepare(`SELECT * FROM inventory WHERE availability = 'In-stock'`).all();

    if (storeFilter === 'stock') {
      rows = rows.filter(r => !r.location || !r.location.trim());
    } else if (storeFilter) {
      const target = STORE_MAP[storeFilter] || storeFilter;
      rows = rows.filter(r => (r.location || '').toLowerCase().includes(target));
    }

    if (query) {
      rows = rows.filter(r => {
        const hay = [r.make, r.series, r.model, r.serial_number, r.shell_color, r.cabinet_color]
          .join(' ').toLowerCase();
        return hay.includes(query);
      });
    }

    res.json({ results: rows });
  } catch (err) {
    console.error('Inventory search error:', err.message);
    res.status(500).json({ error: 'Failed to search inventory', detail: err.message });
  }
});

// POST /api/inventory/refresh — force re-download of the OLD Sheets Inventory
// cache. Unrelated to the DB-backed search above; left as-is, out of scope.
router.post('/refresh', async (req, res) => {
  try {
    await getInventory(true);
    res.json({ success: true, lastSynced: getLastSynced() });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed', detail: err.message });
  }
});

module.exports = router;
