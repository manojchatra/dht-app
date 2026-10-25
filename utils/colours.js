// utils/colours.js — shell / cabinet colour names. The SKU List tab of the Google
// Sheet is the standard: New Contract offers each brand's SKU List colours (plus
// the extras below) and colours are saved in the SKU List's spelling.
'use strict';
const { normalizeMake, makeKey } = require('./makes');

// Colours a brand uses that the SKU List doesn't carry, and brands the SKU List
// doesn't cover at all (agreed with the owner, Oct 2026).
const EXTRA = {
  HotSpring: { shell: ['Taupe'], cabinet: ['Driftwood', 'Gray', 'Mocha', 'Ash', 'Brown'] }, // Mocha/Ash: Vigor cold plunge; Brown: Monterey; Taupe: Mini
  Caldera:   { shell: [], cabinet: ['Mocha'] },                                   // Emerge cold plunge
  'Endless Pools': { shell: [], cabinet: ['Brown', 'Espresso'] },
  WLA:       { shell: ['Alpine White'], cabinet: ['Brown', 'Charcoal'] },
  LifeSmart: { shell: ['Arctic White', 'Sea Salt', 'Sand', 'Taupe'], cabinet: ['Espresso', 'Coastal Gray', 'Brown', 'Black', 'Charcoal'] },
  Tylo:      { shell: [], cabinet: [] }, // saunas: "Others" only
};

// The SKU List's colours as of 2026-10-25 — used only if the live sheet can't be read.
const SKU_SNAPSHOT = {
  HotSpring: {
    shell: ['Alpine White', 'Desert', 'Dune', 'Ice Gray', 'Ivory', 'Pearl', 'Pebble', 'Platinum', 'Smoke', 'Tuscan'],
    cabinet: ['Almond', 'Blackwood', 'Brushed Nickel', 'Charcoal', 'Coastal Gray', 'Diamond Weave', 'Espresso', 'Havana', 'Java', 'Linen', 'Mosaic', 'Sable', 'Storm'],
  },
  Caldera: {
    shell: ['Arctic White', 'Desert', 'Fog Stone', 'Midnight Canyon', 'Natural Taupe', 'Pearl', 'Platinum', 'Tuscan'],
    cabinet: ['Ash', 'Coastal Gray', 'Espresso', 'Honeycomb', 'Java', 'Parchment', 'Waves'],
  },
  'Endless Pools': { shell: ['Alpine White', 'Ice Gray'], cabinet: ['Gray', 'Mocha'] },
};

// Other spellings → the standard name. '*' applies to every brand; 'Brand.part'
// only there (LifeSmart's "Taupe" is a real colour, Caldera's is "Natural Taupe").
const ALIASES = {
  '*': { 'tuscan sun': 'Tuscan', 'ice grey': 'Ice Gray', 'costal gray': 'Coastal Gray', 'costal grey': 'Coastal Gray',
         'nickel': 'Brushed Nickel', 'charcoalcoal': 'Charcoal', 'seasalt': 'Sea Salt' },
  'HotSpring.cabinet': { 'diamond': 'Diamond Weave', 'diamond wave': 'Diamond Weave' },
  // Each brand's white has one name: Caldera / LifeSmart "Arctic White", WLA "Alpine White".
  'Caldera.shell': { 'taupe': 'Natural Taupe', 'alpine white': 'Arctic White' },
  'LifeSmart.shell': { 'alpine white': 'Arctic White' },
  'WLA.shell': { 'arctic white': 'Alpine White' },
};

const colourKey = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// The standard name for a colour of this brand/part; anything unknown comes back trimmed, as typed.
function normalizeColour(make, part, value) {
  const t = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const k = colourKey(t);
  const brand = normalizeMake(make);
  return (ALIASES[`${brand}.${part}`] || {})[k] || ALIASES['*'][k] || t;
}

const sortUnique = list => [...new Map(list.filter(Boolean).map(v => [colourKey(v), String(v).trim()])).values()]
  .sort((a, b) => a.localeCompare(b));

// SKU List rows (objects with Make / Shell Color / Cabinet Color) → per-brand
// button lists, merged with EXTRA. Falls back to SKU_SNAPSHOT when rows is empty.
function buildColourLists(skuRows) {
  const brands = {};
  const add = (brand, part, colour) => {
    if (!colour) return;
    brands[brand] = brands[brand] || { shell: [], cabinet: [] };
    brands[brand][part].push(normalizeColour(brand, part, colour));
  };
  if (skuRows && skuRows.length) {
    for (const r of skuRows) {
      const brand = normalizeMake(r['Make']);
      if (!brand) continue;
      add(brand, 'shell', String(r['Shell Color'] || '').trim());
      add(brand, 'cabinet', String(r['Cabinet Color'] || '').trim());
    }
  } else {
    for (const [brand, parts] of Object.entries(SKU_SNAPSHOT)) for (const part of ['shell', 'cabinet']) parts[part].forEach(c => add(brand, part, c));
  }
  for (const [brand, parts] of Object.entries(EXTRA)) {
    brands[brand] = brands[brand] || { shell: [], cabinet: [] };
    for (const part of ['shell', 'cabinet']) brands[brand][part].push(...parts[part]);
  }
  const all = { shell: [], cabinet: [] };
  for (const b of Object.values(brands)) {
    b.shell = sortUnique(b.shell); b.cabinet = sortUnique(b.cabinet);
    all.shell.push(...b.shell); all.cabinet.push(...b.cabinet);
  }
  return { brands, all: { shell: sortUnique(all.shell), cabinet: sortUnique(all.cabinet) } };
}

// The brand's lists (case/space-insensitive brand match), or null if unknown.
function listsForMake(lists, make) {
  const k = makeKey(normalizeMake(make));
  const name = Object.keys(lists.brands).find(b => makeKey(b) === k);
  return name ? lists.brands[name] : null;
}

// The colours an inventory unit should have, and why (used by scripts/normalize-colours.js):
// spelling → standard; cold plunge colour in Shell with Cabinet empty → Cabinet; shell and
// cabinet swapped (each is the other part's colour for that brand) → swapped back. Colours
// still not on the brand's list are listed in offList, not changed.
const COLD_PLUNGE = /\b(vigor|emerge)\b/i;
function planColourFix(u, lists) {
  let shell = normalizeColour(u.make, 'shell', u.shell_color);
  let cabinet = normalizeColour(u.make, 'cabinet', u.cabinet_color);
  const why = [];
  if (shell !== String(u.shell_color || '').trim() || cabinet !== String(u.cabinet_color || '').trim()) why.push('spelling');
  const has = (list, v) => !!v && list.some(x => colourKey(x) === colourKey(v));
  const l = listsForMake(lists, u.make);
  if (COLD_PLUNGE.test(u.model || '') && shell && !cabinet) { cabinet = shell; shell = ''; why.push('cold plunge colour moved to cabinet'); }
  else if (l && shell && cabinet && !has(l.shell, shell) && has(l.cabinet, shell) && has(l.shell, cabinet) && !has(l.cabinet, cabinet)) {
    [shell, cabinet] = [cabinet, shell]; why.push('shell / cabinet swapped');
  }
  const offList = l ? [['shell', shell], ['cabinet', cabinet]].filter(([p, v]) => v && !has(l[p], v)).map(([p, v]) => `${p} "${v}"`) : [];
  return { shell, cabinet, why, offList, changed: why.length > 0 };
}

module.exports = { EXTRA, SKU_SNAPSHOT, ALIASES, colourKey, normalizeColour, buildColourLists, listsForMake, planColourFix };
