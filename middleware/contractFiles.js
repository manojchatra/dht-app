/**
 * contractFiles.js — who may open a contract's uploaded files
 * (/uploads/contracts/<contract number>/…: contract scan, cheque photos,
 * signatures, receipts, contract / acknowledgement PDFs, delivery photos).
 *
 *   admin     — every contract
 *   sales     — their own contracts (salesman_user_id)
 *   delivery  — contracts scheduled or delivered to their team
 *   warehouse — none (their photos live under /uploads/inventory/)
 *
 * Loose files directly in /uploads/contracts/ are Preview & Save uploads still
 * waiting for their contract — admin and sales only. Anything outside
 * /uploads/contracts/ (e.g. inventory photos) is unaffected.
 */
const db = require('../db/database');

function contractFileAccess(req, res, next) {
  let parts;
  try { parts = decodeURIComponent(req.path).split('/').filter(Boolean); }
  catch (e) { return res.status(400).send('Bad request'); }
  if (parts[0] !== 'contracts') return next();

  const { role, userId, team } = req.session || {};
  if (role === 'admin') return next();
  if (parts.length <= 2) return role === 'sales' ? next() : res.status(403).send('Forbidden');

  const c = db.prepare('SELECT salesman_user_id, delivery_team, status FROM contracts WHERE contract_number=?').get(parts[1]);
  const allowed = c && (
    (role === 'sales' && c.salesman_user_id === userId) ||
    (role === 'delivery' && !!team && c.delivery_team === team && ['scheduled', 'delivered'].includes(c.status))
  );
  return allowed ? next() : res.status(403).send('Forbidden');
}

module.exports = { contractFileAccess };
