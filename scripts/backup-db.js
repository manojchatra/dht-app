/**
 * Weekly SQLite backup — uses better-sqlite3's online backup API (safe to
 * run while the app is serving traffic), writes to a fixed, web-inaccessible
 * directory outside public/public_html, and prunes old backups beyond the
 * retention window.
 *
 * Usage: node scripts/backup-db.js
 * Intended to be run on a schedule (Hestia cron), not imported.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH     = path.join(__dirname, '../../data/dht-app.db');
const BACKUP_DIR  = process.env.DB_BACKUP_DIR || path.join(__dirname, '../../backups/db');
const RETENTION   = 8; // keep the last 8 backups (~2 months at weekly cadence)

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('dht-app-') && f.endsWith('.db'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of files.slice(RETENTION)) {
    fs.unlinkSync(path.join(BACKUP_DIR, stale.name));
    console.log('[backup-db] Pruned old backup:', stale.name);
  }
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `dht-app-${timestamp()}.db`);

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
    console.log('[backup-db] Backup written to', dest);
  } finally {
    db.close();
  }

  pruneOldBackups();
}

main().catch(err => {
  console.error('[backup-db] FAILED:', err.message);
  process.exit(1);
});
