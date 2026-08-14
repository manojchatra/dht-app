const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const DB_PATH  = path.join(__dirname, '../../data/dht-app.db');
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'sales',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    email        TEXT,
    phone_cell   TEXT,
    phone_home   TEXT,
    phone_work   TEXT,
    address      TEXT,
    city         TEXT,
    state        TEXT DEFAULT 'AZ',
    zip          TEXT,
    gated        INTEGER DEFAULT 0,
    gate_code    TEXT,
    heard_about  TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_number     TEXT UNIQUE,
    customer_id         INTEGER REFERENCES customers(id),
    store               TEXT,
    date                TEXT,
    delivery_date       TEXT,
    scheduled_datetime  TEXT,
    scheduled_duration  INTEGER DEFAULT 120,
    calendar_event_id   TEXT,
    delivery_team       TEXT,
    acknowledgement_pdf TEXT,
    salesman            TEXT,
    product_status      TEXT,
    status              TEXT DEFAULT 'assigned',
    serial_number       TEXT,
    make                TEXT,
    model               TEXT,
    grand_total         TEXT,
    paid_amount         TEXT,
    due_prior           TEXT,
    data                TEXT NOT NULL,
    contract_image_path TEXT,
    cheque_image_path   TEXT,
    extra_images        TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id     INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
    amount          REAL NOT NULL,
    method          TEXT NOT NULL,
    cheque_number   TEXT,
    date            TEXT,
    notes           TEXT,
    recorded_by     TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS post_delivery_feedback (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id          INTEGER UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
    status               TEXT NOT NULL DEFAULT 'pending',
    contacted            INTEGER,
    google_review        INTEGER,
    rating_delivery      INTEGER,
    rating_installation  INTEGER,
    rating_explanation   INTEGER,
    rating_confidence    INTEGER,
    rating_overall       INTEGER,
    concerns_text        TEXT,
    submitted_by         TEXT,
    submitted_at         DATETIME,
    completed_by         TEXT,
    completed_at         DATETIME,
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_contracts_customer ON contracts(customer_id);
  CREATE INDEX IF NOT EXISTS idx_contracts_serial   ON contracts(serial_number);
  CREATE INDEX IF NOT EXISTS idx_contracts_status   ON contracts(status);
  CREATE INDEX IF NOT EXISTS idx_contracts_created  ON contracts(created_at);
  CREATE INDEX IF NOT EXISTS idx_payments_contract  ON payments(contract_id);
  CREATE INDEX IF NOT EXISTS idx_pdf_contract        ON post_delivery_feedback(contract_id);
  CREATE INDEX IF NOT EXISTS idx_pdf_status          ON post_delivery_feedback(status);
`);

// ── Seed default users ────────────────────────────────────────────────────────
function seedUsers() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (existing > 0) return;
  db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run('admin', bcrypt.hashSync('admin123',10), 'admin');
  db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run('sales', bcrypt.hashSync('sales123',10), 'sales');
  console.log('[DB] Default users seeded');
}

// ── Seed default settings ─────────────────────────────────────────────────────
function seedContractSequence() {
  const existing = db.prepare("SELECT value FROM settings WHERE key='contract_sequence'").get();
  if (existing) return;
  // Seed from MAX of existing contract numbers
  const rows = db.prepare("SELECT contract_number FROM contracts WHERE contract_number IS NOT NULL").all();
  let maxSeq = 0;
  rows.forEach(r => {
    const match = r.contract_number.match(/(\d+)$/);
    if (match) { const n = parseInt(match[1]); if (n > maxSeq) maxSeq = n; }
  });
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)").run('contract_sequence', String(maxSeq));
  console.log('[DB] contract_sequence seeded at', maxSeq);
}

function seedSettings() {
  const existing = db.prepare("SELECT value FROM settings WHERE key='tax_rates'").get();
  if (existing) return;
  const defaultTax = { Phoenix:'8.6', Goodyear:'9.3', Chandler:'7.8', Surprise:'9.1', Tolleson:'8.8' };
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)").run('tax_rates', JSON.stringify(defaultTax));
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)").run('email_recipients', JSON.stringify([]));
  console.log('[DB] Default settings seeded');
}

// ── Migrate existing DB ───────────────────────────────────────────────────────
const existingCols = db.prepare('PRAGMA table_info(contracts)').all().map(c=>c.name);
if (!existingCols.includes('scheduled_datetime')) {
  db.exec('ALTER TABLE contracts ADD COLUMN scheduled_datetime TEXT');
  console.log('[DB] scheduled_datetime column added');
}
if (!existingCols.includes('scheduled_duration')) {
  db.exec('ALTER TABLE contracts ADD COLUMN scheduled_duration INTEGER DEFAULT 120');
  console.log('[DB] scheduled_duration column added');
}
if (!existingCols.includes('calendar_event_id')) {
  db.exec('ALTER TABLE contracts ADD COLUMN calendar_event_id TEXT');
  console.log('[DB] calendar_event_id column added');
}
if (!existingCols.includes('delivery_team')) {
  db.exec('ALTER TABLE contracts ADD COLUMN delivery_team TEXT');
  console.log('[DB] delivery_team column added');
}
if (!existingCols.includes('acknowledgement_pdf')) {
  db.exec('ALTER TABLE contracts ADD COLUMN acknowledgement_pdf TEXT');
  console.log('[DB] acknowledgement_pdf column added');
}
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
if (!userCols.includes('team')) {
  db.exec('ALTER TABLE users ADD COLUMN team TEXT');
  console.log('[DB] users.team column added');
}
const pdfCols = db.prepare('PRAGMA table_info(post_delivery_feedback)').all().map(c=>c.name);
if (!pdfCols.includes('google_review')) {
  db.exec('ALTER TABLE post_delivery_feedback ADD COLUMN google_review INTEGER');
  console.log('[DB] post_delivery_feedback.google_review column added');
}

// ── Activity log ─────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER,
  contract_num TEXT,
  event_type   TEXT NOT NULL,
  actor        TEXT,
  detail       TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
)`);

// ── Notifications ─────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  INTEGER,
  contract_num TEXT,
  event_type   TEXT NOT NULL,
  message      TEXT,
  color        TEXT DEFAULT 'green',
  dismissed    INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
)`);

seedUsers();
seedSettings();
seedContractSequence();

module.exports = db;
