// utils/makes.js — one spelling per spa brand, so brand filters and on-order
// matching see one brand ("Hotspring" / "Hot Spring" are HotSpring). Applied
// wherever a make is saved: New Contract, Add to Inventory, stock imports.
// Keep in step with MAKE_MODELS in public/create-contract.html.
'use strict';

const STANDARD_MAKES = ['HotSpring', 'Caldera', 'Tylo', 'WLA', 'Endless Pools', 'LifeSmart'];
// Spellings that differ by more than capitals/spaces → standard name.
const ALIASES = { endlesspool: 'Endless Pools' };

const makeKey = s => String(s ?? '').toLowerCase().replace(/[\s_-]+/g, '');

// The standard spelling of a known brand; anything else is returned trimmed, as typed.
function normalizeMake(s) {
  const t = String(s ?? '').trim();
  if (!t) return t;
  const k = makeKey(t);
  return STANDARD_MAKES.find(m => makeKey(m) === k) || ALIASES[k] || t;
}

module.exports = { STANDARD_MAKES, ALIASES, makeKey, normalizeMake };
