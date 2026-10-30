// utils/deliveryZones.js — delivery zone by the contract's delivery zip, and
// its colour on the Google Calendar event and the portal calendar (agreed with
// the owner, Oct 2026). A zip in no zone is Out of Town (green).
// To add or move a zip: edit the lists below and deploy (plus
// `node scripts/resync-calendar.js --refresh` to recolour existing events).
'use strict';

// Google Calendar event colour ids: 5 Banana, 6 Tangerine, 7 Peacock, 10 Basil.
// hex = the same colours on the portal calendar; text = readable on them.
const ZONES = {
  east:    { name: 'East Valley',    googleColorId: '7',  hex: '#039BE5', text: '#ffffff' }, // Peacock (blue)
  central: { name: 'Central Valley', googleColorId: '6',  hex: '#F4511E', text: '#ffffff' }, // Tangerine (orange)
  west:    { name: 'West Valley',    googleColorId: '5',  hex: '#F6BF26', text: '#1f1f1f' }, // Banana (yellow)
  out:     { name: 'Out of Town',    googleColorId: '10', hex: '#0B8043', text: '#ffffff' }, // Basil (green)
};

const ZIPS = {
  east: {
    'Gilbert':                         '85234 85233 85298 85297 85296',
    'Chandler':                        '85224 85225 85226 85248 85286 85249',
    'Mesa':                            '85201 85202 85203 85205 85206 85207 85208 85209 85210 85212 85213 85215',
    'Tempe':                           '85281 85282 85283 85284',
    'Scottsdale':                      '85253 85251 85255 85256 85257 85250 85258 85259 85260',
    'Fountain Hills / N. Scottsdale':  '85264 85268 85377 85266 85262 85263',
    'Cave Creek / Carefree':           '85331',                 // added Oct 2026 (with N. Scottsdale)
    'Queen Creek':                     '85140 85141 85142 85143 85144',
    'Apache Junction':                 '85118 85119 85120',
    'Ahwatukee':                       '85040 85041 85042 85044 85045 85048',
    'Maricopa':                        '85138 85139',           // added Oct 2026 (south-east, via I-10)
  },
  central: {
    'Phoenix': '85004 85005 85006 85007 85008 85009 85012 85013 85014 85015 85016 85017 85018 85019 85020 85021 85022 '
             + '85023 85024 85027 85028 85029 85031 85032 85034 85050 85051 85052 85053 85054',
    'Phoenix (added Oct 2026)': '85003 85033 85035 85037 85043 85083 85085 85086 85087', // downtown, west, north, Anthem
    'Laveen':  '85339',                                        // added Oct 2026 (part of Phoenix)
    'Glendale': '85310 85308 85306 85302 85301 85304 85305 85307', // 85305, 85307 added Oct 2026
  },
  west: {
    'Surprise':   '85374 85379 85375 85387 85388 85378',      // 85378 added Oct 2026
    'Sun City':   '85373 85375 85351 85381 85382',
    'Waddell':    '85355',
    'Litchfield': '85340 85309',
    'Peoria':     '85382 85381 85383 85345',                  // 85345 added Oct 2026
    'Buckeye':    '85326',
    'Goodyear':   '85395 85396 85338',
    'Avondale':   '85392 85323',
    'Tolleson':   '85353',                                    // added Oct 2026
    'El Mirage':  '85335',                                    // added Oct 2026
  },
};

const BY_ZIP = new Map();
for (const [zone, areas] of Object.entries(ZIPS)) {
  for (const list of Object.values(areas)) for (const zip of list.split(/\s+/).filter(Boolean)) BY_ZIP.set(zip, zone);
}

// 'east' | 'central' | 'west' | 'out' for a zip ("85234", "85234-1234", " 85234 ").
function zoneKeyForZip(zip) {
  const z = String(zip ?? '').trim().slice(0, 5);
  return BY_ZIP.get(z) || 'out';
}
const zoneForZip = zip => ({ key: zoneKeyForZip(zip), ...ZONES[zoneKeyForZip(zip)] });

module.exports = { ZONES, ZIPS, zoneKeyForZip, zoneForZip };
