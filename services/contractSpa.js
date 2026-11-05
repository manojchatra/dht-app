/**
 * contractSpa.js — the spa on the Edit contract page (admin only, agreed with
 * the owner 2026-11-05; replaces Assign SI. No on the pages). The admin picks
 * another spa, corrects the serial, or switches In Stock ↔ To Be Ordered, and
 * the card moves with it:
 *
 *  - Switching only while Assigned, To Be Ordered or Order Placed.
 *      In Stock → To Be Ordered: the spa goes back to stock, the serial box
 *        becomes a remark again, card → To Be Ordered.
 *      To Be Ordered / Order Placed → In Stock: the spa is linked (or added to
 *        Inventory as Sold), card → Assigned. A reserved on-order unit goes
 *        back to unreserved on-order stock; an Order Placed contract with a
 *        typed Web Order # and truck leaves its factory spa as on-order stock
 *        (same as cancelling); Web Order # / Truck # are cleared.
 *  - Received / Scheduled: another spa only (same kind), no switching.
 *  - In Stock serial not in Inventory: added as Sold only when the admin chose
 *    "Add to Inventory" (spa.addToInventory) — otherwise refused (notFound).
 *  - To Be Ordered serial box: a remark, saved as typed — unless it names a spa
 *    in Inventory (then In Stock is the way to sell it).
 *  - A free In-stock spa is linked only when the admin confirmed it
 *    (spa.confirmed) — otherwise the route asks first (needsConfirm).
 *  - On-order stock picked (spa.orderedUnitId) on a To Be Ordered / Order
 *    Placed contract is reserved for it (planOrderedPick); card → Order Placed.
 *
 * planSpaChange() decides without writing; the edit route (routes/contracts.js
 * POST /:id/edit) applies it with applySpaUnits() in the same transaction as
 * the rest of the edit, then updates the Sheets.
 */
'use strict';
const { statusName } = require('../utils/contractStatus');

const CLOSED = ['delivered', 'cancelled'];
const SWITCHABLE = ['assigned', 'tbo', 'order_placed'];
const FINANCE_OPTIONS = ['DHT Owned', 'Bank Owned'];

// The spa details a linked inventory spa gives the contract. Blank inventory
// fields leave the contract's value.
const SPA_DETAILS = [
  ['make', 'make', 'Make'], ['series', 'series', 'Series'], ['model', 'model', 'Model'], ['year', 'year', 'Year'],
  ['shellColor', 'shell_color', 'Shell'], ['cabinetColor', 'cabinet_color', 'Cabinet'],
];
function spaDetailChanges(contract, product, unit) {
  const now = { ...product, make: product.make || contract.make || '', model: product.model || contract.model || '' };
  return SPA_DETAILS.map(([key, col, label]) => ({ key, label, from: String(now[key] ?? '').trim(), to: String(unit[col] ?? '').trim() }))
    .filter(c => c.to && c.to !== c.from);
}
const spaChangeText = changes => changes.map(c => `${c.label} ${c.from || '—'} → ${c.to}`).join(', ');

function findUnit(db, serial) {
  return db.prepare(`SELECT i.*, c.contract_number AS linked_contract FROM inventory i
    LEFT JOIN contracts c ON c.id = i.contract_id WHERE lower(trim(i.serial_number)) = lower(?)`).get(serial) || null;
}
const kindName = k => (k === 'instock' ? 'In Stock' : 'To Be Ordered');
const unitLabel = u => u.serial_number || `on-order stock (Web Order # ${u.web_order_number || '—'})`;

/**
 * What the Edit page's spa section changes, or null when nothing does.
 * input = form.spa: { status: 'instock'|'tbo', serial, confirmed, addToInventory, finance }.
 * Returns { error, notFound? } | null | plan:
 *   { from, to, switching, serial, serialWas, newStatus, link, create, finance,
 *     release: [units], remove: [units], keepOrdered, clearOrder, changes, confirmMessage }
 */
function planSpaChange(db, contract, input) {
  if (!input || typeof input !== 'object') return null;
  if (input.orderedUnitId) return planOrderedPick(db, contract, input);
  const cur = (contract.product_status || JSON.parse(contract.data || '{}').product?.status) === 'instock' ? 'instock' : 'tbo';
  const want = ['instock', 'tbo'].includes(input.status) ? input.status : cur;
  const serial = String(input.serial ?? '').trim().slice(0, 50);
  const serialWas = String(contract.serial_number || '').trim();
  const switching = want !== cur;
  if (!switching && serial.toUpperCase() === serialWas.toUpperCase()) return null;

  const num = contract.contract_number, st = contract.status;
  if (CLOSED.includes(st)) return { error: `${num} is ${statusName(st)} — its spa can't be changed.` };
  if (switching && !SWITCHABLE.includes(st)) {
    return { error: `${num} is ${statusName(st)} — In Stock / To Be Ordered can only be switched while it's Assigned, To Be Ordered or Order Placed.` };
  }

  const linked = db.prepare('SELECT * FROM inventory WHERE contract_id=?').all(contract.id);
  const unit = serial ? findUnit(db, serial) : null;
  const own = !!(unit && unit.contract_id === contract.id);
  const plan = {
    from: cur, to: want, switching, serial, serialWas, newStatus: st,
    link: null, create: false, finance: '', release: [], remove: [], keepOrdered: false, clearOrder: null,
    changes: [], confirmMessage: '',
  };
  const soldTo = u => `Serial ${u.serial_number} is already sold to ${u.linked_contract || 'another contract'}.`;

  // ── To Be Ordered (no spa in hand): the serial box is a remark ──
  if (want === 'tbo' && (switching || !['received', 'scheduled'].includes(st))) {
    if (unit && !own) {
      return { error: unit.contract_id ? soldTo(unit)
        : `${unit.serial_number} is a spa in Inventory (${unit.availability}) — choose In Stock to sell it, or type something else.` };
    }
    if (switching) {
      // In Stock → To Be Ordered: the spa goes back to stock (a unit added for a
      // typed serial too — the spa is real, as when the contract is cancelled).
      if (own) plan.serial = '';
      plan.release = linked;
      plan.newStatus = 'tbo';
    }
    return plan;
  }

  // ── A spa in hand: In Stock, or a Received / Scheduled contract's spa ──
  if (!serial) {
    return { error: switching || st === 'assigned'
      ? 'An In Stock contract needs its spa — pick one in Inventory Search or type its serial, or switch to To Be Ordered.'
      : `${num} is ${statusName(st)} — its serial can't be left empty.` };
  }
  if (unit && unit.contract_id && !own) return { error: soldTo(unit) };
  if (unit && unit.availability !== 'In-stock' && !(own && unit.availability === 'Sold')) {
    return { error: `Spa ${unit.serial_number} is "${unit.availability}" in Inventory, not In-stock — it can't be sold.`
      + (unit.availability === 'Ordered' ? ' On-order stock is linked with Move to Order Placed on the Status page.' : '') };
  }
  const others = linked.filter(u => !unit || u.id !== unit.id);
  // A swap corrects the spa: a unit this contract added for a typed serial goes
  // (it was only ever that serial); anything else goes back to stock.
  const dropOthers = () => {
    plan.remove = others.filter(u => u.created_by_contract_id === contract.id && u.availability !== 'Ordered');
    plan.release = others.filter(u => !plan.remove.includes(u));
  };
  if (unit && !own) {
    plan.link = unit;
    plan.changes = spaDetailChanges(contract, JSON.parse(contract.data || '{}').product || {}, unit);
    dropOthers();
  } else if (!unit) {
    if (st === 'received') {
      // As Assign SI. No did: a received spa's serial is only corrected on the contract.
    } else if (!input.addToInventory) {
      return { notFound: true, error: `Serial ${serial} isn't in Inventory — choose Add to Inventory, re-enter it`
        + (SWITCHABLE.includes(st) ? ', or switch to To Be Ordered.' : '.') };
    } else {
      plan.create = true;
      plan.finance = FINANCE_OPTIONS.includes(input.finance) ? input.finance : '';
      dropOthers();
    }
  }
  if (switching) {
    plan.newStatus = 'assigned';
    // The factory spa of an Order Placed contract that had no on-order unit stays as on-order stock.
    plan.keepOrdered = st === 'order_placed' && !linked.length
      && !!String(contract.web_order_number || '').trim() && !!String(contract.truck_number || '').trim();
    if (contract.web_order_number || contract.truck_number) {
      plan.clearOrder = { webOrder: contract.web_order_number || '', truck: contract.truck_number || '' };
    }
  }
  if (plan.link) {
    const what = [unit.make, unit.model].filter(Boolean).join(' ') || 'Spa';
    const freed = plan.release.map(unitLabel);
    plan.confirmMessage = `${unit.serial_number} is in Inventory (${what}${unit.location ? ', ' + unit.location : ''}). `
      + `${num} will be linked to it and it will be marked Sold.`
      + (switching ? `\n\nThe contract becomes In Stock and its card moves to Assigned.` : '')
      + (plan.changes.length ? `\n\nContract spa details change: ${spaChangeText(plan.changes)}.` : '')
      + (freed.length ? `\n\n${freed.join(', ')} goes back to stock.` : '');
  }
  return plan;
}

// On-order stock picked in Inventory Search (a spa on a truck, no serial yet),
// on a To Be Ordered or Order Placed contract: the spa is reserved for the
// contract, which takes its Web Order # / Truck # and runs as Order Placed — as
// when on-order stock is picked on New Contract. A spa it had reserved goes back
// to unreserved on-order stock. Typed Web Order # / Truck # are replaced — the
// picked spa is that order, so no extra on-order unit is added for them.
function planOrderedPick(db, contract, input) {
  const num = contract.contract_number, st = contract.status;
  if (!['tbo', 'order_placed'].includes(st)) {
    return { error: `On-order stock can only be linked to a To Be Ordered or Order Placed contract — ${num} is ${statusName(st)}.` };
  }
  if (input.status === 'instock') return { error: 'An on-order spa is To Be Ordered — it can\'t be linked to an In Stock sale.' };
  const id = parseInt(input.orderedUnitId, 10);
  const linked = db.prepare('SELECT * FROM inventory WHERE contract_id=?').all(contract.id);
  if (linked.some(u => u.id === id)) return null; // already this contract's spa
  const unit = db.prepare("SELECT * FROM inventory WHERE id=? AND availability='Ordered' AND contract_id IS NULL").get(id);
  if (!unit) return { error: 'That on-order spa isn\'t free on-order stock any more — search again.' };
  const serial = String(input.serial ?? '').trim().slice(0, 50);
  const plan = {
    from: 'tbo', to: 'tbo', switching: false, serial, serialWas: String(contract.serial_number || '').trim(),
    newStatus: 'order_placed', link: null, create: false, finance: '', release: linked, remove: [],
    keepOrdered: false, clearOrder: null, reserve: unit,
    setOrder: { webOrder: unit.web_order_number || '', truck: unit.truck_number || '' },
    orderWas: { webOrder: contract.web_order_number || '', truck: contract.truck_number || '' },
    changes: spaDetailChanges(contract, JSON.parse(contract.data || '{}').product || {}, unit),
  };
  const what = [unit.make, unit.model].filter(Boolean).join(' ') || 'Spa';
  plan.confirmMessage = `Reserve the on-order ${what} (Truck ${unit.truck_number || '—'}, Web Order # ${unit.web_order_number || '—'}) for ${num}?`
    + `\n\nThe contract takes its Web Order # and Truck #` + (st === 'tbo' ? ' and its card moves to Order Placed.' : '.')
    + (plan.changes.length ? `\n\nContract spa details change: ${spaChangeText(plan.changes)}.` : '')
    + (linked.length ? `\n\n${linked.map(unitLabel).join(', ')} goes back to stock.` : '');
  return plan;
}

// The contract as the rest of the edit should see it once the spa change is
// made: status, serial and the spa details a linked spa brings.
function contractAfterSpa(contract, plan) {
  const data = JSON.parse(contract.data || '{}');
  const product = { ...(data.product || {}) };
  product.status = plan.to;
  product.serialNumber = plan.serial;
  for (const c of plan.changes) product[c.key] = c.to;
  if (plan.to === 'tbo') product.floorModel = '';
  if (plan.release.some(u => u.availability === 'Ordered')) delete product.orderedUnitId;
  if (plan.reserve) product.orderedUnitId = plan.reserve.id;
  if (plan.create && plan.finance) product.finance = plan.finance;
  data.product = product;
  return {
    ...contract, data: JSON.stringify(data),
    status: plan.newStatus, product_status: plan.to, serial_number: plan.serial || null,
    make: plan.changes.find(c => c.key === 'make')?.to ?? contract.make,
    model: plan.changes.find(c => c.key === 'model')?.to ?? contract.model,
    web_order_number: plan.setOrder ? plan.setOrder.webOrder : plan.clearOrder ? null : contract.web_order_number,
    truck_number: plan.setOrder ? plan.setOrder.truck : plan.clearOrder ? null : contract.truck_number,
  };
}

// The inventory spa the contract is linked to after the change (make / model
// then come from it), or null.
function linkedAfter(db, contract, plan) {
  if (plan.link) return plan.link;
  if (plan.reserve) return plan.reserve;
  if (plan.create) return null; // added from the page's make / model
  const gone = new Set([...plan.release, ...plan.remove].map(u => u.id));
  return db.prepare('SELECT id, serial_number FROM inventory WHERE contract_id=?').all(contract.id).find(u => !gone.has(u.id)) || null;
}

/**
 * Inventory writes for the plan — synchronous, for the edit route's
 * transaction. product = the saved contract's product (the unit added for a
 * typed serial is made from it). Throws 'taken' if the spa was sold meanwhile.
 * Returns { created, kept } — the units added, for the Sheets.
 */
function applySpaUnits(db, contract, plan, product, actor) {
  for (const u of plan.remove) db.prepare('DELETE FROM inventory WHERE id=?').run(u.id);
  for (const u of plan.release) {
    db.prepare(`UPDATE inventory SET contract_id=NULL,
      availability=CASE WHEN availability='Ordered' THEN 'Ordered' ELSE 'In-stock' END, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(u.id);
  }
  if (plan.link) {
    const ok = db.prepare(`UPDATE inventory SET availability='Sold', contract_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND contract_id IS NULL AND availability='In-stock'`).run(contract.id, plan.link.id).changes === 1;
    if (!ok) throw new Error('taken');
  }
  if (plan.reserve) {
    const ok = db.prepare(`UPDATE inventory SET contract_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND availability='Ordered' AND contract_id IS NULL`).run(contract.id, plan.reserve.id).changes === 1;
    if (!ok) throw new Error('taken');
  }
  const p = product || {};
  const spa = {
    make: p.make || contract.make || '', series: p.series || '', model: p.model || contract.model || '',
    year: String(p.year || ''), shellColor: p.shellColor || '', cabinetColor: p.cabinetColor || '',
    speaker: p.included?.speaker ? 'Yes' : '',
  };
  let created = null, kept = null;
  if (plan.create) {
    created = { ...spa, serialNumber: plan.serial, availability: 'Sold', finance: plan.finance };
    db.prepare(`INSERT INTO inventory (make, series, model, year, shell_color, cabinet_color, serial_number,
        availability, finance, speaker, contract_id, created_by_contract_id, added_by)
      VALUES (?,?,?,?,?,?,?,'Sold',?,?,?,?,?)`).run(spa.make, spa.series, spa.model, spa.year, spa.shellColor, spa.cabinetColor,
      plan.serial, plan.finance || null, spa.speaker, contract.id, contract.id, actor);
  }
  if (plan.keepOrdered) {
    // Same unit keepOrderedSpa (services/orderedStock.js) adds when an Order Placed contract is cancelled.
    const webOrder = String(contract.web_order_number).trim(), truck = String(contract.truck_number).trim();
    const was = JSON.parse(contract.data || '{}').product || {};
    const factory = {
      make: contract.make || was.make || '', series: was.series || '', model: contract.model || was.model || '',
      shellColor: was.shellColor || '', cabinetColor: was.cabinetColor || '',
      speaker: was.included?.speaker ? 'Yes' : '', year: String(was.year || ''),
    };
    db.prepare(`INSERT INTO inventory (make, series, model, shell_color, cabinet_color, availability,
        added_by, speaker, web_order_number, truck_number, year)
      VALUES (?,?,?,?,?,'Ordered',?,?,?,?,?)`).run(factory.make, factory.series, factory.model, factory.shellColor,
      factory.cabinetColor, actor, factory.speaker, webOrder, truck, factory.year);
    kept = { ...factory, skuNumber: '', availability: 'Ordered', webOrderNumber: webOrder, truckNumber: truck };
  }
  return { created, kept };
}

// The activity-log text for the spa part of an edit.
function spaLogText(contract, plan) {
  const parts = [];
  if (plan.switching) {
    parts.push(`${kindName(plan.from)} → ${kindName(plan.to)} (card ${statusName(contract.status)} → ${statusName(plan.newStatus)})`);
  }
  if (plan.reserve) {
    parts.push(`On-order stock reserved: Truck ${plan.setOrder.truck || '—'} / Web Order # ${plan.setOrder.webOrder || '—'}`
      + (plan.orderWas.webOrder || plan.orderWas.truck ? ` (was Web Order # ${plan.orderWas.webOrder || '—'} / Truck # ${plan.orderWas.truck || '—'})` : '')
      + (contract.status !== plan.newStatus ? ` (card ${statusName(contract.status)} → ${statusName(plan.newStatus)})` : ''));
  }
  if (plan.serial.toUpperCase() !== plan.serialWas.toUpperCase()) {
    parts.push(`Serial ${plan.serialWas || '—'} → ${plan.serial || '—'}`);
  }
  if (plan.link) parts.push(`${plan.link.serial_number} linked from Inventory and marked Sold`);
  if (plan.create) parts.push(`${plan.serial} added to Inventory as Sold` + (plan.finance ? ` (${plan.finance})` : ''));
  if (plan.changes.length) parts.push(`Spa details: ${spaChangeText(plan.changes)}`);
  if (plan.release.length) parts.push(`Returned to stock: ${plan.release.map(unitLabel).join(', ')}`);
  if (plan.remove.length) parts.push(`Removed unit added for a typed serial: ${plan.remove.map(u => u.serial_number).join(', ')}`);
  if (plan.keepOrdered) parts.push(`Factory spa kept as on-order stock (Web Order # ${String(contract.web_order_number).trim()})`);
  if (plan.clearOrder) parts.push(`Web Order # ${plan.clearOrder.webOrder || '—'} / Truck # ${plan.clearOrder.truck || '—'} cleared`);
  return parts.join(' · ');
}

module.exports = { planSpaChange, contractAfterSpa, linkedAfter, applySpaUnits, spaLogText, spaDetailChanges, spaChangeText, SWITCHABLE };
