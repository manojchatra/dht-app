/**
 * List / delete stray uploaded photos — files left in the upload holding areas
 * (loose files in uploads/contracts/, uploads/tmp, inventory-tmp, warehouse-tmp,
 * payment-tmp) by saves that were rejected or never finished. Files inside a
 * contract or serial folder, and any file the database refers to, are never touched.
 * The running app does the same sweep daily (utils/uploadCleanup.js).
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/clean-stray-uploads.js              # report only — changes nothing
 *   node scripts/clean-stray-uploads.js --apply      # delete them
 *   --hours N   only files older than N hours (default 48)
 */
require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../db/database'));
const { findStrayUploads, deleteStrayUploads } = require(path.join(__dirname, '../utils/uploadCleanup'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const hi = args.indexOf('--hours');
const hours = hi >= 0 ? Number(args[hi + 1]) : 48;
if (!(hours >= 0)) { console.log('--hours needs a number'); process.exit(1); }

const strays = findStrayUploads(db, { olderThanHours: hours });
const mb = n => (n / 1048576).toFixed(1) + ' MB';
console.log(`Stray uploads older than ${hours} h: ${strays.length} (${mb(strays.reduce((s, f) => s + f.size, 0))})`);
for (const s of strays) console.log(`  ${s.mtime.toISOString().slice(0, 10)}  ${mb(s.size).padStart(8)}  uploads/${s.rel}`);

if (!APPLY) { console.log('\nREPORT ONLY — nothing was deleted. Re-run with --apply to delete them.'); process.exit(0); }
const { deleted, bytes } = deleteStrayUploads(db, strays);
console.log(`\nDeleted ${deleted} file(s), ${mb(bytes)}.`);
