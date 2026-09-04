/**
 * inventory-items.js — DB-backed inventory (Stage 3)
 * Distinct from routes/inventory.js, which only reads a Sheets-only cache
 * used to pick an in-stock spa's serial during contract creation.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db/database');
const { compressAndGate } = require('../utils/imageUtils');
const { requireRole } = require('../middleware/auth');
const {
  lookupSku, appendInventoryItem, updateInventoryItemField,
} = require('../services/driveInventory');

// 'warehouse' isn't a creatable role yet (lands in Stage 5) — included here
// now so this gate doesn't need a follow-up edit once it is.
router.use(requireRole(['admin', 'warehouse']));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/inventory-tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadPhotos = upload.fields([
  { name: 'skuPhoto',    maxCount: 1 },
  { name: 'serialPhoto', maxCount: 1 },
]);

function toUrlPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  try {
    const uploadsDir = path.join(__dirname, '../uploads');
    const rel = path.relative(uploadsDir, absPath);
    if (rel.startsWith('..')) return null;
    return '/uploads/' + rel.replace(/\\/g, '/');
  } catch(e) { return null; }
}

function safeFolderName(s) {
  return String(s||'').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

// Moves an uploaded temp file into uploads/inventory/<serialNumber>/<label>.ext,
// compressing it in place. Returns the final absolute path, or null on failure.
async function finalizeInventoryPhoto(tmpFile, serialNumber, label) {
  if (!tmpFile) return null;
  const dir = path.join(__dirname, '../uploads/inventory', safeFolderName(serialNumber));
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(tmpFile.originalname) || '.jpg';
  const dest = path.join(dir, label + ext);
  try { fs.renameSync(tmpFile.path, dest); } catch(e) { /* keep original path */ }
  let finalPath = fs.existsSync(dest) ? dest : tmpFile.path;
  const compResult = await compressAndGate(finalPath);
  if (compResult.path) finalPath = compResult.path;
  return finalPath;
}

// ── GET / — list all items, non-Sold first, Sold at the bottom ───────────────
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM inventory
      ORDER BY (availability = 'Sold') ASC, created_at DESC
    `).all();
    const items = rows.map(r => ({
      ...r,
      sku_photo_url:    toUrlPath(r.sku_photo_path),
      serial_photo_url: toUrlPath(r.serial_photo_path),
    }));
    res.json(items);
  } catch (err) {
    console.error('Inventory list error:', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

// ── GET /sku-lookup?sku=... — resolve Make/Model/Colors from the SKU master list ─
router.get('/sku-lookup', async (req, res) => {
  try {
    const match = await lookupSku(req.query.sku || '');
    if (!match) return res.status(404).json({ error: 'SKU not found' });
    res.json(match);
  } catch (err) {
    console.error('SKU lookup error:', err);
    res.status(500).json({ error: 'SKU lookup failed', detail: err.message });
  }
});

// ── POST / — add a new inventory item ─────────────────────────────────────────
router.post('/', (req, res) => {
  uploadPhotos(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    try {
      const { make, series, model, shellColor, cabinetColor, serialNumber, skuNumber } = req.body;
      if (!serialNumber || !serialNumber.trim()) return res.status(400).json({ error: 'Serial number is required' });
      if (!make || !model) return res.status(400).json({ error: 'Make and model are required' });

      const existing = db.prepare('SELECT id FROM inventory WHERE serial_number = ?').get(serialNumber.trim());
      if (existing) return res.status(409).json({ error: 'An item with this serial number is already in inventory.' });

      const skuFile    = req.files?.skuPhoto?.[0]    || null;
      const serialFile = req.files?.serialPhoto?.[0] || null;
      const skuPhotoPath    = await finalizeInventoryPhoto(skuFile,    serialNumber, 'sku-photo');
      const serialPhotoPath = await finalizeInventoryPhoto(serialFile, serialNumber, 'serial-photo');

      const result = db.prepare(`
        INSERT INTO inventory
          (make, series, model, shell_color, cabinet_color, serial_number, sku_number,
           availability, sku_photo_path, serial_photo_path, added_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        make.trim(), (series||'').trim(), model.trim(), (shellColor||'').trim(), (cabinetColor||'').trim(),
        serialNumber.trim(), (skuNumber||'').trim(),
        'In-stock', skuPhotoPath, serialPhotoPath, req.session.username || 'system'
      );

      try {
        await appendInventoryItem({
          serialNumber: serialNumber.trim(), skuNumber: (skuNumber||'').trim(),
          make: make.trim(), series: (series||'').trim(), model: model.trim(),
          shellColor: (shellColor||'').trim(), cabinetColor: (cabinetColor||'').trim(),
          availability: 'In-stock',
        });
      } catch(e) { console.error('[Drive add inventory item failed — non-fatal]', e.message); }

      res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
      console.error('Add inventory item error:', err);
      res.status(500).json({ error: 'Failed to add inventory item' });
    }
  });
});

// ── PATCH /:id — update Availability/Location/Steps/Cover/Finance ────────────
const EDITABLE_FIELDS = ['availability', 'location', 'steps', 'cover', 'finance'];
router.patch('/:id', async (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM inventory WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });

    const updates = [];
    const params = [];
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No editable fields provided' });

    params.push(req.params.id);
    db.prepare(`UPDATE inventory SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...params);

    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        try { await updateInventoryItemField(item.serial_number, field, req.body[field]); }
        catch(e) { console.error('[Drive update inventory field failed — non-fatal]', e.message); }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update inventory item error:', err);
    res.status(500).json({ error: 'Failed to update inventory item' });
  }
});

module.exports = router;