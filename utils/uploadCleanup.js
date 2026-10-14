/**
 * uploadCleanup.js — stop uploaded photos piling up as strays.
 *
 * Every upload lands first in a holding area (multer), and the route moves it
 * into its proper folder (uploads/contracts/<number>/, uploads/inventory/<serial>/…)
 * once the save succeeds. A save that is rejected (missing signature, duplicate
 * serial…) or errors used to leave its photos behind.
 *
 *  - discardUnusedUploads: Express middleware — once the response is sent, any
 *    file from this request still sitting where multer put it is deleted.
 *    Skips POST /api/contracts/upload-temp (Preview & Save keeps those for the
 *    final save) and never deletes a file the database refers to.
 *  - findStrayUploads / deleteStrayUploads: loose files in the holding areas
 *    older than a cut-off and not referenced anywhere — e.g. a contract
 *    previewed but never saved. Run daily by the app and by
 *    scripts/clean-stray-uploads.js.
 */
const fs   = require('fs');
const path = require('path');

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

// Holding areas: [folder under uploads/, also scan sub-folders?]
const HOLDING_AREAS = [
  ['contracts', false],      // loose files only — never the per-contract folders
  ['tmp', true],
  ['inventory-tmp', true],
  ['warehouse-tmp', true],
  ['payment-tmp', true],
];

// Columns that can hold an upload's path (fallbacks keep the holding-area path
// if a move fails, so a referenced file must never be deleted).
const REFERENCES = [
  ['contracts', ['contract_image_path', 'cheque_image_path', 'extra_images', 'data', 'acknowledgement_pdf']],
  ['inventory', ['sku_photo_path', 'serial_photo_path']],
  ['payments',  ['cheque_image_path']],
];

function referencedColumns(db) {
  const out = [];
  for (const [table, cols] of REFERENCES) {
    let have;
    try { have = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch (e) { continue; }
    const usable = cols.filter(c => have.includes(c));
    if (usable.length) out.push([table, usable]);
  }
  return out;
}

function isReferenced(db, filePath) {
  const like = '%' + path.basename(filePath) + '%';
  return referencedColumns(db).some(([table, cols]) =>
    !!db.prepare(`SELECT 1 FROM ${table} WHERE ${cols.map(c => `${c} LIKE ?`).join(' OR ')} LIMIT 1`)
      .get(...cols.map(() => like)));
}

function requestFiles(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) files.push(...(Array.isArray(req.files) ? req.files : Object.values(req.files).flat()));
  return files.filter(f => f && f.path);
}

function discardUnusedUploads(req, res, next) {
  if (req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/contracts/upload-temp') return next();
  res.on('finish', () => {
    const files = requestFiles(req).filter(f => fs.existsSync(f.path));
    if (!files.length) return;
    const db = require('../db/database');
    for (const f of files) {
      try {
        if (isReferenced(db, f.path)) continue;
        fs.unlinkSync(f.path);
      } catch (e) { console.error('[Upload cleanup]', e.message); }
    }
  });
  next();
}

function findStrayUploads(db, { olderThanHours = 48, now = Date.now() } = {}) {
  const root = uploadsDir();
  const cutoff = now - olderThanHours * 3600000;
  const strays = [];
  const scan = (dir, recurse) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (recurse) scan(p, true); continue; }
      if (!ent.isFile()) continue;
      const st = fs.statSync(p);
      if (st.mtimeMs > cutoff) continue;
      if (isReferenced(db, p)) continue;
      strays.push({ path: p, rel: path.relative(root, p).replace(/\\/g, '/'), size: st.size, mtime: st.mtime });
    }
  };
  for (const [area, recurse] of HOLDING_AREAS) scan(path.join(root, area), recurse);
  return strays;
}

function deleteStrayUploads(db, strays) {
  let deleted = 0, bytes = 0;
  for (const s of strays) {
    try { fs.unlinkSync(s.path); deleted++; bytes += s.size; }
    catch (e) { console.error('[Upload cleanup]', s.rel, e.message); }
  }
  return { deleted, bytes };
}

// Daily sweep in the running app (first run 5 minutes after start).
function startStrayUploadSweep() {
  const run = () => {
    try {
      const db = require('../db/database');
      const strays = findStrayUploads(db);
      if (!strays.length) return;
      const { deleted, bytes } = deleteStrayUploads(db, strays);
      console.log(`[Upload cleanup] Removed ${deleted} stray upload(s), ${(bytes / 1048576).toFixed(1)} MB`);
    } catch (e) { console.error('[Upload cleanup sweep]', e.message); }
  };
  setTimeout(run, 5 * 60000).unref();
  setInterval(run, 24 * 3600000).unref();
}

module.exports = { discardUnusedUploads, findStrayUploads, deleteStrayUploads, startStrayUploadSweep, isReferenced };
