// utils/arizona.js — dates in Arizona time (MST all year, no daylight saving).
// The server runs on UTC, so new Date().toISOString().slice(0,10) is already
// "tomorrow" from 5 pm in Arizona.
'use strict';

// Today's date in Arizona as YYYY-MM-DD.
function phoenixToday() {
  return new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
}

module.exports = { phoenixToday };
