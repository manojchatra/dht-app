// utils/sqliteSessionStore.js — express-session store in the app's SQLite
// database, so a restart (deploy, PM2's memory limit) no longer logs everyone
// out. The default MemoryStore lost every login on restart and leaked memory.
// No extra package: a table `sessions` (sid, expires ms, data JSON) next to
// the app's own data. Expired rows are removed hourly.
'use strict';
const session = require('express-session');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      expires INTEGER NOT NULL,
      data    TEXT NOT NULL
    )`);
    this.pruneTimer = setInterval(() => this.prune(), 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  expiresOf(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + DEFAULT_TTL_MS;
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT expires, data FROM sessions WHERE sid=?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.db.prepare('INSERT INTO sessions (sid, expires, data) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET expires=excluded.expires, data=excluded.data')
        .run(sid, this.expiresOf(sess), JSON.stringify(sess));
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb = () => {}) {
    try { this.db.prepare('UPDATE sessions SET expires=? WHERE sid=?').run(this.expiresOf(sess), sid); cb(null); }
    catch (e) { cb(e); }
  }

  destroy(sid, cb = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); }
    catch (e) { cb(e); }
  }

  // Logs a user out everywhere (deactivated / deleted). Sessions hold the user
  // id in their JSON; the per-request check in middleware/auth.js also catches it.
  destroyForUser(userId) {
    try {
      return this.db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.userId') = ?").run(userId).changes;
    } catch (e) { return 0; }
  }

  prune() {
    try { this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()); }
    catch (e) { /* database closed (tests) */ }
  }
}

module.exports = { SqliteSessionStore };
