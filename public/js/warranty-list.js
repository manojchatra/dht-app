// warranty-list.js — manufacturer warranty years per model (Nov 2026, from the
// office's Warranty document). New Contract / Edit fill the Manufacturer
// warranty from the spa picked: the brand tick, Components (= component &
// leak), Shell and Cabinet (= siding). The salesperson can still change them.
// The list is fixed here — a change needs a deploy.
//
// Spas not on the list: HotSpring / Caldera / Endless Pools / WLA (Desert
// Series) tick their brand and the years are typed by hand; Tylo saunas tick
// Tylo with its own two lines; any other make ticks Others (typed text).
(function (root) {
  'use strict';
  // [brand tick, series, component & leak yrs, shell yrs, siding yrs, models]
  var LIST = [
    ['HotSpring', 'Highlife',        5,  7, 5, ['Grandee', 'Envoy', 'Vanguard', 'Aria', 'Jetsetter LX', 'Jetsetter', 'Sovereign', 'Triumph', 'Prodigy']],
    ['HotSpring', 'Limelight',       5,  7, 5, ['Beam', 'Flash', 'Flair', 'Prism', 'Pulse']],
    ['HotSpring', 'Hot Spot',        2,  5, 2, ['Rhythm', 'Relay', 'Pace', 'SX', 'TX', 'Stride']],
    ['HotSpring', 'Cold Plunge',     3,  5, 3, ['Vigor']],
    ['HotSpring', 'Freeflow',        1,  5, 2, ['Azure', 'Excursion', 'Monterey', 'Mini', 'Aptos']],
    ['Caldera',   'Utopia',          5, 10, 5, ['Cantabria', 'Florence', 'Geneva', 'Niagara', 'Provence', 'Ravello', 'Tahitian']],
    ['Caldera',   'Paradise',        5, 10, 3, ['Martinique', 'Kauai', 'Makena', 'Reunion', 'Salina', 'Seychelles']],
    ['Caldera',   'Vacanza',         2,  5, 2, ['Aventine', 'Celio', 'Marino', 'Vanto', 'Palatino', 'Tarino']],
    ['Caldera',   'Cold Plunge',     3,  5, 3, ['Emerge']],
    ['Caldera',   'Fantasy',         1,  5, 2, ['Aspire', 'Bloom', 'Entice', 'Invite', 'Splendor']],
    ['EP',        'Fitness Systems', 5, 10, 5, ['E2000', 'E500', 'E550', 'E700']],
    ['EP',        'SwimCross',       5, 10, 5, ['X2000', 'X200', 'X500']],
    ['EP',        'RecSport',        3, 10, 3, ['R200', 'R220', 'R500']]
  ];
  var TYLO = { tyloCoreYrs: '5', tyloSoundYrs: '1' }; // Tylo saunas: core components 5 years, Bluetooth sound system 1 year

  var norm = function (s) { return String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(); };
  var BY_MODEL = {};
  LIST.forEach(function (row) { row[5].forEach(function (m) { BY_MODEL[norm(m)] = row; }); });

  // The list row for a model name — exact, or by dropping trailing words
  // ("Sovereign IIN" → Sovereign, "Monterey Premier" → Monterey, "Beam II" → Beam).
  function rowFor(model) {
    var words = norm(model).split(' ').filter(Boolean);
    for (var n = words.length; n > 0; n--) { var hit = BY_MODEL[words.slice(0, n).join(' ')]; if (hit) return hit; }
    return null;
  }

  function brandForMake(make) {
    var m = norm(make);
    if (!m) return '';
    if (/hot ?spring/.test(m)) return 'HotSpring';
    if (/caldera|fantasy/.test(m)) return 'Caldera';
    if (/endless|^ep$/.test(m)) return 'EP';
    if (/wla|desert/.test(m)) return 'WLA';
    if (/tylo/.test(m)) return 'Tylo';
    return 'Others';
  }

  // What the Manufacturer warranty should show for this spa, or null (nothing picked).
  // { brand, componentYrs, shellYrs, cabinetYrs, tyloCoreYrs, tyloSoundYrs, series }
  function warrantyFor(make, model) {
    var brand = brandForMake(make);
    var row = brand === 'Tylo' || brand === 'WLA' || brand === 'Others' ? null : rowFor(model);
    if (row) return { brand: row[0], series: row[1], componentYrs: String(row[2]), shellYrs: String(row[3]), cabinetYrs: String(row[4]), tyloCoreYrs: '', tyloSoundYrs: '' };
    if (!brand) return null;
    var out = { brand: brand, series: '', componentYrs: '', shellYrs: '', cabinetYrs: '', tyloCoreYrs: '', tyloSoundYrs: '' };
    if (brand === 'Tylo') { out.tyloCoreYrs = TYLO.tyloCoreYrs; out.tyloSoundYrs = TYLO.tyloSoundYrs; }
    return out;
  }

  var api = { WARRANTY_LIST: LIST, TYLO_WARRANTY: TYLO, warrantyFor: warrantyFor, brandForMake: brandForMake };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.warrantyFor = warrantyFor; root.TYLO_WARRANTY = TYLO; }
})(this);
