/**
 * thumbnails.js — small card-size copies of uploaded photos.
 *
 * /uploads/<path>.jpg?thumb=1 answers with a 160 px JPEG instead of the
 * full photo (a phone photo is ~400 KB; the thumbnail ~8 KB), so a page of
 * contract or inventory cards doesn't download every full-size photo.
 * Mounted after the access checks, so it serves only what the user may open.
 *
 * Thumbnails are made on first request and kept in uploads/.thumbs/ (same
 * sub-path), rebuilt when the photo is newer. That folder is never served
 * directly (express.static only hides a dot-name at the END of a path, so
 * /uploads/.thumbs/contracts/… would otherwise skip the contract access
 * check), and the backup skips it. Anything that can't be thumbnailed falls
 * through to the full file.
 */
const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');

const SIZE = 160;
const PHOTO = /\.(jpe?g|png|webp)$/i;

function thumbnails(uploadsDir) {
  const root = path.resolve(uploadsDir);
  const thumbsRoot = path.join(root, '.thumbs');
  return async function (req, res, next) {
    let rel;
    try { rel = decodeURIComponent(req.path); } catch (e) { return res.status(400).send('Bad request'); }
    if (/(^|[\\/])\.thumbs([\\/]|$)/i.test(rel)) return res.status(404).send('Not found');
    if (req.query.thumb !== '1' || !PHOTO.test(rel)) return next();
    const src = path.resolve(root, '.' + rel);
    if (!src.startsWith(root + path.sep) || src.startsWith(thumbsRoot + path.sep)) return next();
    const out = path.join(thumbsRoot, path.relative(root, src)).replace(PHOTO, '.jpg');
    try {
      const srcTime = fs.statSync(src).mtimeMs;
      let fresh = false;
      try { fresh = fs.statSync(out).mtimeMs >= srcTime; } catch (e) { /* not made yet */ }
      if (!fresh) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        // Written beside, then renamed: two requests at once never serve half a file.
        const tmp = `${out}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
        // Read into memory first: sharp reading the path itself keeps the
        // photo open (its file cache), and Windows then can't delete it.
        await sharp(fs.readFileSync(src)).rotate().resize(SIZE, SIZE, { fit: 'cover' }).jpeg({ quality: 72 }).toFile(tmp);
        fs.renameSync(tmp, out);
      }
      res.set('Cache-Control', 'private, max-age=86400');
      return res.type('jpg').sendFile(out);
    } catch (e) {
      return next(); // missing or unreadable — the full file (or a 404) as before
    }
  };
}

// A deleted contract's thumbnails go with its folder.
function removeContractThumbs(uploadsDir, contractNumber) {
  if (!contractNumber) return;
  fs.rmSync(path.join(path.resolve(uploadsDir), '.thumbs', 'contracts', String(contractNumber)), { recursive: true, force: true });
}

module.exports = { thumbnails, removeContractThumbs };
