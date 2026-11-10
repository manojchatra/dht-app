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
const { normalizeMake } = require('../utils/makes');
const { normalizeColour } = require('../utils/colours');
const { requireAdmin, requireRole } = require('../middleware/auth');
const {
  lookupSku, appendInventoryItem, updateInventoryItemField, deleteInventoryItem,
  markInventoryItemReceivedInSheet, deleteOrderedInventoryItem,
  deleteContractRowFromSheet, moveToOrderPlaced,
} = require('../services/driveInventory');
const { contractsAwaitingSpa, relinkOrdered } = require('../services/orderedStock');
const { logActivity } = require('../utils/activityLogger');
const { buildDriveData } = require('./contracts');

const norm = s => String(s ?? '').trim().toLowerCase();

// 'warehouse' isn't a creatable role yet (lands in Stage 5) — included here
// now so this gate doesn't need a follow-up edit once it is.
// Sales may only read the list (GET /) — view-only page, Finance left out.
const adminOrWarehouse = requireRole(['admin', 'warehouse']);
router.use((req, res, next) =>
  (req.method === 'GET' && req.path === '/' && req.session.role === 'sales') ? next() : adminOrWarehouse(req, res, next));

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
    // A spa linked to a contract (Sold, or on-order stock Reserved) carries that
    // contract's number and customer — the page shows "Sold · Jane Smith ·
    // DHT2610PH00066" (a link to the contract for admin, plain text for warehouse).
    const rows = db.prepare(`
      SELECT i.*,
        c.id AS linked_contract_id, c.contract_number AS linked_contract_number, c.salesman_user_id AS linked_salesman_user_id,
        COALESCE(cu.name, json_extract(c.data,'$.customer.name'), '') AS linked_customer_name,
        CASE WHEN i.availability = 'Ordered' THEN c.contract_number END AS reserved_contract_number
      FROM inventory i
      LEFT JOIN contracts c ON c.id = i.contract_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      ORDER BY (i.availability = 'Sold') ASC, i.created_at DESC
    `).all();
    const isSales = req.session.role === 'sales';
    const items = rows.map(({ linked_salesman_user_id, ...r }) => {
      const item = {
        ...r,
        sku_photo_url:    toUrlPath(r.sku_photo_path),
        serial_photo_url: toUrlPath(r.serial_photo_path),
      };
      // Sales: no Finance; a contract id (the page's link) only for their own contracts.
      if (isSales) {
        delete item.finance;
        if (linked_salesman_user_id !== req.session.userId) item.linked_contract_id = null;
      }
      return item;
    });
    res.json(items);
  } catch (err) {
    console.error('Inventory list error:', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

// ── GET /sku-lookup?sku=... — resolve Make/Model/Colors from the SKU master list ─
router.get('/sku-lookup', async (req, res) => {
  try {
    const { match, suggestion } = await lookupSku(req.query.sku || '');
    if (match) return res.json(match);
    if (suggestion) return res.status(404).json({ error: 'SKU not found', suggestion });
    res.status(404).json({ error: 'SKU not found' });
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
      const { series, model, serialNumber, skuNumber, speaker, webOrderNumber, truckNumber } = req.body;
      const make = normalizeMake(req.body.make); // one spelling per brand (utils/makes.js)
      const shellColor   = normalizeColour(make, 'shell', req.body.shellColor);     // SKU List names (utils/colours.js)
      const cabinetColor = normalizeColour(make, 'cabinet', req.body.cabinetColor);
      const year = String(req.body.year || '').trim(), line = String(req.body.line || '').trim(), bay = String(req.body.bay || '').trim();
      const hasSerial = serialNumber && serialNumber.trim();
      const hasOrderInfo = webOrderNumber && webOrderNumber.trim() && truckNumber && truckNumber.trim();

      if (!hasSerial && !hasOrderInfo) {
        return res.status(400).json({ error: 'Serial Number, or both Web Order Number and Truck Number, are required' });
      }
      if (!make || !model) return res.status(400).json({ error: 'Make and model are required' });

      // "Ordered" stock (on order, not yet physically in hand) — tracked by
      // Web Order Number/Truck Number instead of a serial until warehouse
      // marks it received. No duplicate check: a single web order can
      // legitimately cover multiple units, same as it does on contracts.
      // But an Order Placed contract with the same Web Order #, make and model
      // and no spa reserved yet is probably this spa: the page asks first
      // (409 needsChoice) and sends orderChoice = that contract's id, or
      // "stock" to add it as general on-order stock anyway.
      if (!hasSerial) {
        const matches = contractsAwaitingSpa(db, webOrderNumber, make, model);
        const choice = String(req.body.orderChoice || '');
        if (matches.length && !choice) {
          return res.status(409).json({ needsChoice: true, matches: matches.map(m => ({
            id: m.id, contractNumber: m.contract_number, customerName: m.customer_name, truckNumber: m.truck_number || '' })) });
        }
        let reserveFor = null;
        if (choice && choice !== 'stock') {
          reserveFor = matches.find(m => String(m.id) === choice);
          if (!reserveFor) return res.status(409).json({ error: 'That contract no longer needs this spa (it was linked or received meanwhile) — add it again.' });
        }
        const add = db.transaction(() => {
          const r = db.prepare(`
            INSERT INTO inventory
              (make, series, model, shell_color, cabinet_color, sku_number,
               availability, added_by, speaker, web_order_number, truck_number, year, line, bay)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            make.trim(), (series||'').trim(), model.trim(), (shellColor||'').trim(), (cabinetColor||'').trim(),
            (skuNumber||'').trim(), 'Ordered', req.session.username || 'system', (speaker||'').trim(),
            webOrderNumber.trim(), truckNumber.trim(), year, line, bay
          );
          // The contract takes this spa's Web Order # / Truck # (services/orderedStock.js).
          if (reserveFor) relinkOrdered(db, reserveFor.id, r.lastInsertRowid);
          return r;
        });
        const result = add();
        if (reserveFor) {
          logActivity(db, { contractId: reserveFor.id, contractNum: reserveFor.contract_number, eventType: 'ORDER_PLACED',
            actor: req.session.username || 'system',
            detail: `Its on-order spa was added to Inventory and reserved for it — Web Order #: ${webOrderNumber.trim()} | Truck #: ${truckNumber.trim()}`
              + (norm(reserveFor.truck_number) !== norm(truckNumber) ? ` (Truck # was ${reserveFor.truck_number || '—'})` : '') });
        }

        try {
          await appendInventoryItem({
            skuNumber: (skuNumber||'').trim(),
            make: make.trim(), series: (series||'').trim(), model: model.trim(),
            shellColor: (shellColor||'').trim(), cabinetColor: (cabinetColor||'').trim(),
            availability: 'Ordered', speaker: (speaker||'').trim(),
            webOrderNumber: webOrderNumber.trim(), truckNumber: truckNumber.trim(),
            year, line, bay,
          });
        } catch(e) { console.error('[Drive add inventory item failed — non-fatal]', e.message); }
        if (reserveFor && norm(reserveFor.truck_number) !== norm(truckNumber)) {
          // The contract's Order Placed row takes this spa's Truck # (as on the Edit page).
          try {
            const fresh = db.prepare('SELECT * FROM contracts WHERE id=?').get(reserveFor.id);
            const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(fresh.customer_id);
            await deleteContractRowFromSheet(fresh.contract_number);
            await moveToOrderPlaced(fresh.contract_number, fresh.web_order_number || '', fresh.truck_number || '', buildDriveData(fresh, customer, null));
          } catch(e) { console.error('[Drive Order Placed row update failed — non-fatal]', e.message); }
        }

        return res.json({ success: true, id: result.lastInsertRowid, reservedFor: reserveFor ? reserveFor.contract_number : null });
      }

      const existing = db.prepare('SELECT id FROM inventory WHERE upper(trim(serial_number)) = upper(trim(?))').get(serialNumber.trim());
      if (existing) return res.status(409).json({ error: 'An item with this serial number is already in inventory.' });

      const skuFile    = req.files?.skuPhoto?.[0]    || null;
      const serialFile = req.files?.serialPhoto?.[0] || null;
      const skuPhotoPath    = await finalizeInventoryPhoto(skuFile,    serialNumber, 'sku-photo');
      const serialPhotoPath = await finalizeInventoryPhoto(serialFile, serialNumber, 'serial-photo');

      const result = db.prepare(`
        INSERT INTO inventory
          (make, series, model, shell_color, cabinet_color, serial_number, sku_number,
           availability, sku_photo_path, serial_photo_path, added_by, speaker, year, line, bay)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        make.trim(), (series||'').trim(), model.trim(), (shellColor||'').trim(), (cabinetColor||'').trim(),
        serialNumber.trim(), (skuNumber||'').trim(),
        'In-stock', skuPhotoPath, serialPhotoPath, req.session.username || 'system', (speaker||'').trim(),
        year, line, bay
      );

      try {
        await appendInventoryItem({
          serialNumber: serialNumber.trim(), skuNumber: (skuNumber||'').trim(),
          make: make.trim(), series: (series||'').trim(), model: model.trim(),
          shellColor: (shellColor||'').trim(), cabinetColor: (cabinetColor||'').trim(),
          availability: 'In-stock', speaker: (speaker||'').trim(),
          year, line, bay,
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
// Admin-only, except Line/Bay — warehouse can view/add inventory but not edit the rest —
// same layering as the DELETE route below (outer requireRole allows
// admin+warehouse in, requireAdmin narrows this specific route further).
// Exception: warehouse staff may set Line/Bay (where the unit sits) — nothing else.
const EDITABLE_FIELDS  = ['availability', 'location', 'steps', 'cover', 'finance', 'speaker', 'year', 'line', 'bay'];
const WAREHOUSE_FIELDS = ['line', 'bay'];
router.patch('/:id', async (req, res) => {
  try {
    if (req.session.role !== 'admin') {
      const other = EDITABLE_FIELDS.filter(fld => !WAREHOUSE_FIELDS.includes(fld) && req.body[fld] !== undefined);
      if (other.length) return res.status(403).json({ error: 'Only Line and Bay can be changed by warehouse users' });
    }
    const item = db.prepare('SELECT * FROM inventory WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    // A spa linked to a contract (sold, or on-order reserved) keeps its availability
    // until that contract releases it (cancel / delete) — otherwise it could be set
    // back to In-stock while still sold, and sold a second time.
    if (item.contract_id && req.body.availability !== undefined && req.body.availability !== item.availability) {
      const c = db.prepare('SELECT contract_number FROM contracts WHERE id=?').get(item.contract_id);
      return res.status(400).json({ error: `Linked to ${c ? c.contract_number : 'a contract'} — cancel the contract to release it.` });
    }

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

    // sheetSynced=false tells the UI to warn the user the Sheets mirror
    // couldn't find this item (most commonly a Serial Number mismatch/typo
    // between the DB and the sheet) — the DB save above still succeeded.
    let sheetSynced = true;
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        try {
          const ok = await updateInventoryItemField(item.serial_number, field, req.body[field]);
          if (!ok) sheetSynced = false;
        }
        catch(e) { console.error('[Drive update inventory field failed — non-fatal]', e.message); sheetSynced = false; }
      }
    }

    res.json({ success: true, sheetSynced });
  } catch (err) {
    console.error('Update inventory item error:', err);
    res.status(500).json({ error: 'Failed to update inventory item' });
  }
});

// ── PATCH /:id/receive — mark an "Ordered" item received: sets the real ────
// Serial Number and flips availability to 'In-stock'. A serial photo scan is
// optional here (manual entry alone is still enough) — unlike the
// contract-linked warehouse receive flow, which requires both scans.
router.patch('/:id/receive', (req, res) => {
  uploadPhotos(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    try {
      const item = db.prepare('SELECT * FROM inventory WHERE id=?').get(req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found' });
      if (item.availability !== 'Ordered') {
        return res.status(400).json({ error: 'Only Ordered items can be marked received here.' });
      }
      if (item.contract_id) {
        const c = db.prepare('SELECT contract_number FROM contracts WHERE id=?').get(item.contract_id);
        return res.status(400).json({ error: `Reserved for ${c ? c.contract_number : 'a contract'} — receive it from that contract (Warehouse queue).` });
      }

      const serialNumber = (req.body.serialNumber || '').trim();
      if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });

      const existing = db.prepare('SELECT id FROM inventory WHERE upper(trim(serial_number)) = upper(trim(?)) AND id != ?').get(serialNumber, req.params.id);
      if (existing) return res.status(409).json({ error: 'An item with this serial number is already in inventory.' });

      const serialFile = req.files?.serialPhoto?.[0] || null;
      const serialPhotoPath = serialFile ? await finalizeInventoryPhoto(serialFile, serialNumber, 'serial-photo') : null;

      db.prepare(`
        UPDATE inventory
        SET serial_number=?, availability='In-stock',
            serial_photo_path=COALESCE(?, serial_photo_path), updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(serialNumber, serialPhotoPath, req.params.id);

      let sheetSynced = true;
      try { sheetSynced = await markInventoryItemReceivedInSheet(item, serialNumber); }
      catch(e) { console.error('[Drive mark inventory received failed — non-fatal]', e.message); sheetSynced = false; }

      res.json({ success: true, sheetSynced });
    } catch (err) {
      console.error('Mark inventory item received error:', err);
      res.status(500).json({ error: 'Failed to mark item received' });
    }
  });
});

// ── DELETE /:id — admin-only; blocked if the item is Sold / linked to a contract ─
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM inventory WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.availability === 'Sold' || item.contract_id) {
      return res.status(400).json({ error: 'Cannot delete an item that is Sold or linked to a contract.' });
    }

    db.prepare('DELETE FROM inventory WHERE id=?').run(req.params.id);

    [item.sku_photo_path, item.serial_photo_path].forEach(p => {
      if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch(e) { console.error('[Delete inventory photo failed]', e.message); } }
    });

    let sheetSynced = true;
    // On-order units have no serial yet — their Sheet row is found by Web Order # / make / model.
    try { sheetSynced = item.serial_number ? await deleteInventoryItem(item.serial_number) : await deleteOrderedInventoryItem(item); }
    catch(e) { console.error('[Drive delete inventory item failed — non-fatal]', e.message); sheetSynced = false; }

    res.json({ success: true, sheetSynced });
  } catch (err) {
    console.error('Delete inventory item error:', err);
    res.status(500).json({ error: 'Failed to delete inventory item' });
  }
});

module.exports = router;