/**
 * contractDateFix.js — correct a saved contract's sale date (e.g.
 * DHT2611PH00098: an old sale entered with today's date instead of 9-20-2026).
 * The portal can't change it — the Edit page locks it and the contract number
 * carries its year and month — so scripts/fix-contract-date.js uses this.
 *
 * The number keeps its sequence and takes the new year/month
 * (DHT2611PH00098 → DHT2609PH00098), so it can't clash with another contract.
 * Renumbering renames the contract's upload folder and every stored path into
 * it, and the activity log / notification entries. A contract with a calendar
 * event isn't renumbered (its Google event carries the number).
 *
 * Payments taken at signing (saved with the contract) of an old sale entered
 * after delivery move to the new sale date, as New Contract dates them;
 * payments recorded later keep their dates.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const NUMBER = /^DHT(\d{2})(\d{2})([A-Z]{2})(\d+)$/;

/** "2026-09-20", "9-20-2026" or "9/20/2026" → "2026-09-20" (a real date), else null. */
function parseSaleDate(s) {
  s = String(s || '').trim();
  let y, m, d;
  let x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) { m = +x[1]; d = +x[2]; y = +x[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** The contract number for a new sale date: same store code and sequence, new YYMM. */
function numberForDate(contractNumber, isoDate) {
  const m = String(contractNumber).match(NUMBER);
  if (!m) return null;
  return `DHT${isoDate.slice(2, 4)}${isoDate.slice(5, 7)}${m[3]}${m[4]}`;
}

// Paths into the contract's folder (uploads/contracts/<number>/…), with either
// slash — Windows backslashes are doubled inside stored JSON (extra_images, data).
const folderRef = number => new RegExp(`([\\\\/]contracts[\\\\/]+)${number}(?=[\\\\/])`, 'g');
const movePaths = (value, from, to) => (value == null ? value : String(value).replace(folderRef(from), `$1${to}`));

function planDateFix(db, contractNumber, newDate, { today, uploadsDir }) {
  const c = db.prepare('SELECT * FROM contracts WHERE contract_number=?').get(contractNumber);
  if (!c) throw new Error(`Contract ${contractNumber} not found`);
  const iso = parseSaleDate(newDate);
  if (!iso) throw new Error(`"${newDate}" isn't a date — use 9-20-2026`);
  if (iso > today) throw new Error(`${iso} is in the future`);
  if (iso === c.date) throw new Error(`${contractNumber} already has the sale date ${iso}`);

  const warnings = [];
  if (c.delivery_date && iso > c.delivery_date) warnings.push(`The new sale date is after the delivery date (${c.delivery_date}).`);

  let number = numberForDate(c.contract_number, iso) || c.contract_number;
  if (number !== c.contract_number) {
    if (c.calendar_event_id) throw new Error(`${contractNumber} has a calendar event — its number can't be changed by this script`);
    if (db.prepare('SELECT 1 FROM contracts WHERE contract_number=? AND id<>?').get(number, c.id)) {
      throw new Error(`${number} is already used by another contract`);
    }
  }

  // Taken at signing: saved with the contract (within 2 minutes) on its old sale date.
  const payments = c.back_entered
    ? db.prepare(`SELECT * FROM payments WHERE contract_id=? AND date=?
        AND abs(julianday(created_at) - julianday(?)) * 86400 <= 120 ORDER BY id`).all(c.id, c.date, c.created_at)
    : [];

  const from = path.join(path.resolve(uploadsDir), 'contracts', c.contract_number);
  const to = path.join(path.resolve(uploadsDir), 'contracts', number);
  const folder = { from, to, exists: fs.existsSync(from) };
  if (number !== c.contract_number && fs.existsSync(to)) throw new Error(`The folder ${to} already exists`);

  return {
    contract: c, payments, warnings, folder,
    before: { date: c.date, number: c.contract_number },
    after: { date: iso, number },
  };
}

function applyDateFix(db, plan) {
  const { contract: c, before, after, folder } = plan;
  const renumber = after.number !== before.number;
  // The folder first: if the database save then fails, it's moved back.
  const moveFolder = renumber && folder.exists;
  if (moveFolder) fs.renameSync(folder.from, folder.to);
  try {
    db.transaction(() => {
      const data = JSON.parse(c.data || '{}');
      data.date = after.date;
      const mv = v => (renumber ? movePaths(v, before.number, after.number) : v);
      db.prepare(`UPDATE contracts SET date=?, contract_number=?, data=?, contract_image_path=?, cheque_image_path=?,
          extra_images=?, acknowledgement_pdf=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(after.date, after.number, mv(JSON.stringify(data)), mv(c.contract_image_path), mv(c.cheque_image_path),
          mv(c.extra_images), mv(c.acknowledgement_pdf), c.id);
      const setDate = db.prepare('UPDATE payments SET date=? WHERE id=?');
      plan.payments.forEach(p => setDate.run(after.date, p.id));
      if (renumber) {
        const pays = db.prepare('SELECT id, cheque_image_path FROM payments WHERE contract_id=?').all(c.id);
        const setPath = db.prepare('UPDATE payments SET cheque_image_path=? WHERE id=?');
        pays.forEach(p => { if (p.cheque_image_path) setPath.run(mv(p.cheque_image_path), p.id); });
        db.prepare('UPDATE activity_log SET contract_num=? WHERE contract_id=?').run(after.number, c.id);
        db.prepare('UPDATE notifications SET contract_num=?, message=replace(message, ?, ?) WHERE contract_id=?')
          .run(after.number, before.number, after.number, c.id);
      }
    })();
  } catch (e) {
    if (moveFolder) fs.renameSync(folder.to, folder.from);
    throw e;
  }
  return { renumbered: renumber };
}

module.exports = { parseSaleDate, numberForDate, planDateFix, applyDateFix };
