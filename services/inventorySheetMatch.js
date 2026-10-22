/**
 * inventorySheetMatch.js — find an on-order unit's row in the "Inventory Items"
 * Sheet tab. On-order rows have no serial yet, and one Web Order # can cover a
 * whole truck (identical spas included), so the first row with that Web Order #
 * isn't good enough: receiving the second spa would overwrite the first one's row.
 *
 * A row qualifies when its serial is blank, make/model match, and the Web Order #
 * matches (or the Truck # when the unit has no Web Order #). Among those, matching
 * colours and truck win; ties go to the first row. Pure — no Sheets access.
 */
'use strict';
const { makeKey } = require('../utils/makes');

// Column positions (0-based) in INVENTORY_ITEMS_HEADERS (services/driveInventory.js).
const COL = { serial: 0, make: 2, model: 4, shell: 5, cabinet: 6, webOrder: 14, truck: 15 };
const norm = s => String(s ?? '').trim().toLowerCase();

// values: the tab's rows including the header row (values[0]).
// unit: inventory DB row. Returns the 1-based sheet row number, or -1.
function pickOrderedItemRow(values, unit) {
  const wo = norm(unit.web_order_number), truck = norm(unit.truck_number);
  if (!wo && !truck) return -1;
  let best = -1, bestScore = -1;
  for (let i = 1; i < (values || []).length; i++) {
    const r = values[i] || [];
    if (norm(r[COL.serial])) continue;
    if (makeKey(r[COL.make]) !== makeKey(unit.make) || norm(r[COL.model]) !== norm(unit.model)) continue;
    if (wo ? norm(r[COL.webOrder]) !== wo : norm(r[COL.truck]) !== truck) continue;
    const score = (norm(r[COL.shell]) === norm(unit.shell_color) ? 2 : 0)
                + (norm(r[COL.cabinet]) === norm(unit.cabinet_color) ? 2 : 0)
                + (truck && norm(r[COL.truck]) === truck ? 1 : 0);
    if (score > bestScore) { best = i + 1; bestScore = score; }
  }
  return best;
}

module.exports = { pickOrderedItemRow };
