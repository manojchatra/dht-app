/**
 * warehouse.js — Stage 5: Warehouse role
 * Narrow, receiving-focused view of Order-Placed contracts (no pricing/
 * payment data exposed here — see routes/contracts.js for the full view
 * admin/sales use). Also the two-photo "mark received" flow, separate
 * from the existing single-photo POST /api/contracts/:id/received so
 * that flow (used today by admin/sales from the status board) isn't
 * touched.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db/database');
const { compressAndGate } = require('../utils/imageUtils');
const { requireRole } = require('../middleware/auth');
const { moveToReceived } = require('../services/driveInventory');
const { logActivity, addNotification } = require('../utils/activityLogger');
const { notifyReceived } = require('../utils/emailSender');
const { buildDriveData } = require('./contracts');

router.use(requireRole(['admin', 'warehouse']));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/warehouse-tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadPhotos = upload.fields([
  { name: 'serialPhoto', maxCount: 1 },
  { name: 'skuPhoto',    maxCount: 1 },
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
async function finalizePhoto(tmpFile, serialNumber, label) {
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

// ── GET /queue — Order-Placed contracts awaiting receipt (narrow fields only) ─
router.get('/queue', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.contract_number, c.make, c.model, c.web_order_number, c.truck_number,
        json_extract(c.data,'$.product.shellColor')   AS shell_color,
        json_extract(c.data,'$.product.cabinetColor') AS cabinet_color,
        COALESCE(json_extract(c.data,'$.customer.name'), cu.name, '') AS customer_name
      FROM contracts c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      WHERE c.status = 'order_placed'
      ORDER BY c.created_at DESC
    `).all();
    res.json(rows);
  } catch (err) {
    console.error('Warehouse queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

// ── POST /:id/receive — two-photo mark-received, creates/links an inventory row ─
router.post('/:id/receive', (req, res) => {
  uploadPhotos(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    const { serialNumber, skuNumber, receivedDate } = req.body;
    if (!serialNumber || !serialNumber.trim()) return res.status(400).json({ error: 'Serial number is required' });
    if (!req.files?.serialPhoto?.[0]) return res.status(400).json({ error: 'Serial number photo is required' });
    if (!req.files?.skuPhoto?.[0])    return res.status(400).json({ error: 'SKU barcode photo is required' });

    try {
      const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
      if (!contract) return res.status(404).json({ error: 'Not found' });
      if (contract.status !== 'order_placed') {
        return res.status(400).json({ error: 'Only Order Placed contracts can be marked received here.' });
      }

      const serial = serialNumber.trim();
      const sku    = (skuNumber || '').trim();
      const serialPhotoPath = await finalizePhoto(req.files.serialPhoto[0], serial, 'serial-photo');
      const skuPhotoPath    = await finalizePhoto(req.files.skuPhoto[0],    serial, 'sku-photo');
      const actualDate = receivedDate || new Date().toISOString().slice(0,10);

      // Update contract: status, serial number, and extra_images (matches the
      // existing single-photo flow's convention so contract-detail.html's
      // "Serial Number Photo" display keeps working unchanged).
      const data = JSON.parse(contract.data || '{}');
      if (data.product) data.product.serialNumber = serial;
      const existingImages = contract.extra_images ? JSON.parse(contract.extra_images) : [];
      const filteredImages = existingImages.filter(i => { const p = typeof i==='string'?i:i.path; return !p.includes('serial-photo'); });
      filteredImages.unshift({ path: serialPhotoPath, label: 'Serial Number Photo' });

      db.prepare('UPDATE contracts SET status=?,serial_number=?,data=?,extra_images=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run('received', serial, JSON.stringify(data), JSON.stringify(filteredImages), req.params.id);

      // Create or link the inventory row for this physical unit.
      const product = data.product || {};
      const invExisting = db.prepare('SELECT id FROM inventory WHERE serial_number=?').get(serial);
      if (invExisting) {
        db.prepare(`UPDATE inventory SET contract_id=?,availability=?,sku_number=?,sku_photo_path=?,serial_photo_path=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(req.params.id, 'Sold', sku, skuPhotoPath, serialPhotoPath, invExisting.id);
      } else {
        db.prepare(`
          INSERT INTO inventory
            (make, model, shell_color, cabinet_color, serial_number, sku_number,
             availability, sku_photo_path, serial_photo_path, contract_id, added_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          contract.make || product.make || '', contract.model || product.model || '',
          product.shellColor || '', product.cabinetColor || '',
          serial, sku, 'Sold', skuPhotoPath, serialPhotoPath, req.params.id,
          req.session.username || 'system'
        );
      }

      // Google Sheets (non-fatal): move the contract's row to Received.
      try {
        const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(contract.customer_id);
        const driveData = buildDriveData(contract, customer, null);
        driveData.serialNumber = serial;
        const photoUrl = 'https://app.deserthottubsaz.com' + (toUrlPath(serialPhotoPath) || '');
        await moveToReceived(contract.contract_number, actualDate, photoUrl, driveData);
      } catch(e) { console.error('[Drive warehouse-received failed — non-fatal]', e.message); }

      logActivity(db, { contractId: req.params.id, contractNum: contract.contract_number, eventType: 'MARK_RECEIVED',
        actor: req.session.username || 'warehouse', detail: 'order_placed → received (warehouse)' });
      const custName = (() => { try { return JSON.parse(contract.data||'{}').customer?.name || ''; } catch(e){ return ''; } })();
      addNotification(db, { contractId: req.params.id, contractNum: contract.contract_number, eventType: 'RECEIVED',
        color: 'green', message: `${contract.contract_number} — ${custName} marked received` });
      try {
        const freshContract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
        await notifyReceived({ contract: freshContract, customerName: custName });
      } catch (e) { console.error('[Email notify RECEIVED failed — non-fatal]', e.message); }

      res.json({ success: true });
    } catch (err) {
      console.error('Warehouse receive error:', err);
      res.status(500).json({ error: 'Failed to mark as received' });
    }
  });
});

module.exports = router;
