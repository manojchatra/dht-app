// utils/teams.js — delivery team names (team ids are stored on users and
// contracts). Renamed Oct 2026: team_a "Clear Choice Team" → "Classic Spa Team".
// The pages carry the same names (status.html, settings.html, js/sidebar.js).
'use strict';

const TEAM_NAMES = { team_a: 'Classic Spa Team', team_b: 'Installation Team' };

const teamName = id => TEAM_NAMES[id] || id || '';

module.exports = { TEAM_NAMES, teamName };
