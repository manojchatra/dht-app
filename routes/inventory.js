const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getInventory, getLastSynced, getSkuList } = require('../services/driveInventory');
const { buildColourLists, ALIASES } = require('../utils/colours');
const { findOrderedMatches } = require('../services/orderedStock');

// Keyword → substring match against the DB `location` column (case-insensitive).
const STORE_MAP = {
  backroom: 'back room',
  emp: 'back room', // old name of the Back Room (bookmarked links)
  costco: 'costco',
  walmart: 'walmart',
  phoenix: 'phoenix',
  goodyear: 'goodyear',
  chandler: 'chandler',
  surprise: 'surprise',
  tolleson: 'tolleson',
  stock: 'warehouse',
};

// GET /api/inventory/search?q=sovereign&store=phoenix[&includeOrdered=1]
// Searches the DB-backed `inventory` table (Stage 3), filtered to
// availability='In-stock' — Hold/Sold units must never be pickable for a new
// contract. Previously read the read-only Sheets "Inventory" tab via
// searchInventory(); that source had no live link to a DB row, so nothing
// could flag a picked unit Sold. See routes/contracts.js POST / for the
// write-back that now closes that loop.
// includeOrdered=1 (New Contract) also lists unreserved Ordered stock — on a
// truck, no serial yet — listed after In-stock; a floor/warehouse filter hides
// them (they aren't on any floor yet), store=onorder shows only them.
// Picking one reserves it (services/orderedStock.js).
router.get('/search', (req, res) => {
  try {
    const { q = '', store = '' } = req.query;
    const query = String(q).trim().toLowerCase();
    const storeFilter = String(store).trim().toLowerCase();
    const onOrderOnly = storeFilter === 'onorder'; // the modal's "On order" filter
    const withOrdered = req.query.includeOrdered === '1' && (!storeFilter || onOrderOnly);

    // Never offer a spa that's linked to a contract, whatever its availability says.
    let rows = db.prepare(`SELECT * FROM inventory
      WHERE contract_id IS NULL AND (${onOrderOnly ? '0' : "availability = 'In-stock'"} ${withOrdered ? "OR availability = 'Ordered'" : ''})
      ORDER BY (availability = 'Ordered'), created_at DESC`).all();

    if (storeFilter && !onOrderOnly) {
      const target = STORE_MAP[storeFilter] || storeFilter;
      rows = rows.filter(r => (r.location || '').toLowerCase().includes(target));
    }

    if (query) {
      rows = rows.filter(r => {
        const hay = [r.make, r.series, r.model, r.year, r.serial_number, r.shell_color, r.cabinet_color,
          r.web_order_number, r.truck_number].join(' ').toLowerCase();
        return hay.includes(query);
      });
    }

    res.json({ results: rows });
  } catch (err) {
    console.error('Inventory search error:', err.message);
    res.status(500).json({ error: 'Failed to search inventory', detail: err.message });
  }
});

// GET /api/inventory/colours — shell / cabinet colour buttons per brand for New
// Contract: the SKU List's colours (5-minute cache) + utils/colours.js extras,
// plus the alias map so the page can match an inventory spa's colour to its button.
router.get('/colours', async (req, res) => {
  let rows = [];
  try { rows = await getSkuList(); } catch (e) { console.warn('[Colours] SKU List unavailable — using the built-in snapshot:', e.message); }
  res.json({ ...buildColourLists(rows), aliases: ALIASES });
});

// GET /api/inventory/ordered-matches?make=Caldera&model=Vanto — unreserved
// Ordered stock of that make/model, for the admin's Move to Order Placed dialog.
router.get('/ordered-matches', (req, res) => {
  res.json({ results: findOrderedMatches(db, req.query.make, req.query.model) });
});

// GET /api/inventory/serial-exists?serial=XYZ — { exists } — New Contract shows
// the DHT/Bank Owned choice only for a serial that isn't in inventory yet
// (saving that contract creates the unit).
router.get('/serial-exists', (req, res) => {
  const serial = String(req.query.serial || '').trim();
  if (!serial) return res.json({ exists: false });
  const row = db.prepare('SELECT 1 FROM inventory WHERE serial_number = ?').get(serial);
  res.json({ exists: !!row });
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
