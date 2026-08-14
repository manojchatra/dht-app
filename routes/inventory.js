const express = require('express');
const router = express.Router();
const { searchInventory, getLastSynced } = require('../services/driveInventory');

// GET /api/inventory/search?q=sovereign&store=phoenix
router.get('/search', async (req, res) => {
  try {
    const { q = '', store = '' } = req.query;
    const results = await searchInventory(q, store);
    res.json({ results, lastSynced: getLastSynced() });
  } catch (err) {
    console.error('Inventory search error:', err.message);
    res.status(500).json({ error: 'Failed to search inventory', detail: err.message });
  }
});

// GET /api/inventory/refresh  – force re-download from Drive
router.post('/refresh', async (req, res) => {
  try {
    const { getInventory } = require('../services/driveInventory');
    await getInventory(true);
    res.json({ success: true, lastSynced: getLastSynced() });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed', detail: err.message });
  }
});

module.exports = router;
