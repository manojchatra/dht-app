/**
 * googleCalendar.js — Google Calendar integration for DHT delivery scheduling
 * Uses same service account as driveInventory.js
 * Requires: GOOGLE_CALENDAR_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY in .env
 */
const { google } = require('googleapis');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const TZ = 'America/Phoenix';

// Event colour = the delivery zone of the contract's delivery zip (East Valley
// blue, Central orange, West yellow, Out of Town green — utils/deliveryZones.js).
// The team is in the description instead (it used to be the colour).
const { zoneForZip, DELIVERED } = require('../utils/deliveryZones');
const { teamName } = require('../utils/teams');
const zoneOf = data => zoneForZip(((data || {}).customer || {}).zip);

function getCalendar() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
  return google.calendar({ version: 'v3', auth });
}

function calendarConfigured() {
  return !!(CALENDAR_ID && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

// Phoenix is fixed UTC-7, no DST — add minutes to a naive Phoenix-local
// "YYYY-MM-DDTHH:mm:ss" string and return the result in the same naive form.
function addMinutesPhoenix(naiveStr, mins) {
  const instant = new Date(naiveStr + '-07:00').getTime() + mins * 60000;
  return new Date(instant - 7 * 3600000).toISOString().slice(0, 19);
}

function buildDescription(contract, data) {
  const cu = data.customer || {};
  const de = data.details  || {};
  const lines = [
    'Contract: ' + contract.contract_number,
    'Zone:     ' + zoneOf(data).name,
    'Customer: ' + (cu.name || ''),
    'Address:  ' + [(cu.address||''), (cu.city||''), (cu.zip||'')].filter(Boolean).join(', '),
    'Phone:    ' + (cu.phone?.cell || cu.phone?.home || ''),
    'Email:    ' + (cu.email || ''),
    '',
    'Make/Model: ' + [contract.make, contract.model].filter(Boolean).join(' / '),
    'Serial:     ' + (contract.serial_number || ''),
    '',
    'Steps:      ' + (de.steps?.type || ''),
    'Water Care: ' + (de.waterCareSystem?.type || ''),
    'Cover:      ' + [(de.cover?.coverType||[]).join('/'), de.cover?.brand, de.cover?.lift, de.cover?.otherLift].filter(Boolean).join(' - '),
    '',
    'Salesman: ' + (contract.salesman || ''),
    'Team:     ' + teamName(contract.delivery_team),
  ];
  return lines.join('\n');
}

// ── Event title: Name · Make Model · S/N (no contract number; team in the description) ──
function buildSummary(contract, data) {
  const cu   = data.customer || {};
  const name = cu.name || contract.customer_name || '';
  const makeModel = [contract.make, contract.model].filter(Boolean).join(' ');
  const serial = contract.serial_number ? 'S/N: ' + contract.serial_number : '';
  return [name, makeModel, serial].filter(Boolean).join(' · ');
}

// ── Create event on scheduling ────────────────────────────────────────────────
async function createCalendarEvent(contract, data) {
  if (!calendarConfigured()) { console.warn('[Calendar] Not configured — skipping'); return null; }
  const startNaive = contract.scheduled_datetime;
  const endNaive    = addMinutesPhoenix(startNaive, contract.scheduled_duration || 120);
  const cu      = data.customer || {};
  const location = [(cu.address||''), (cu.city||''), (cu.zip||'')].filter(Boolean).join(', ');

  const res = await getCalendar().events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary:     buildSummary(contract, data),
      location,
      description: buildDescription(contract, data),
      start:       { dateTime: startNaive, timeZone: TZ },
      end:         { dateTime: endNaive,   timeZone: TZ },
      colorId:     zoneOf(data).googleColorId,
    }
  });
  console.log('[Calendar] Event created:', res.data.id);
  return res.data.id;
}

// ── Update event on reschedule ────────────────────────────────────────────────
async function updateCalendarEvent(eventId, contract, data) {
  if (!calendarConfigured() || !eventId) return;
  const startNaive = contract.scheduled_datetime;
  const endNaive    = addMinutesPhoenix(startNaive, contract.scheduled_duration || 120);
  const cu = (data || {}).customer || {};

  // Everything the crew reads is rewritten — title (S/N), description (serial,
  // steps, cover) and location — not just the time: a serial changed with
  // Assign SI. No must never leave the old one on the calendar.
  await getCalendar().events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: {
      summary:     buildSummary(contract, data || {}),
      description: buildDescription(contract, data || {}),
      location:    [(cu.address||''), (cu.city||''), (cu.zip||'')].filter(Boolean).join(', '),
      start:   { dateTime: startNaive, timeZone: TZ },
      end:     { dateTime: endNaive,   timeZone: TZ },
      colorId: zoneOf(data).googleColorId,
    }
  });
  console.log('[Calendar] Event updated:', eventId);
}

// ── Delivered: the event stays, greyed out (Graphite) ────────────────────────
// Title, time and description are left as they were. An event already gone
// from Google is fine.
async function markEventDelivered(eventId) {
  if (!calendarConfigured() || !eventId) return;
  try {
    await getCalendar().events.patch({ calendarId: CALENDAR_ID, eventId, requestBody: { colorId: DELIVERED.googleColorId } });
    console.log('[Calendar] Event marked delivered (grey):', eventId);
  } catch (e) {
    if (e.code === 404 || e.status === 404) return; // already gone
    throw e;
  }
}

// ── Admin time block (calendar_blocks) — red (Tomato), "BLOCKED – note" ──────
// An all-day block is an all-day event (end date is exclusive, as Google wants).
const BLOCK_COLOR_ID = '11';
function blockEventBody(block) {
  const team = block.team ? teamName(block.team) : 'Both teams';
  const body = {
    summary:     'BLOCKED' + (block.note ? ' – ' + block.note : ''),
    description: 'Team: ' + team + '\nNo deliveries can be booked in this time.\nBlocked in GOBI' + (block.created_by ? ' by ' + block.created_by : ''),
    colorId:     BLOCK_COLOR_ID,
  };
  if (block.all_day) {
    body.start = { date: block.start_datetime.slice(0, 10) };
    body.end   = { date: block.end_datetime.slice(0, 10) };
  } else {
    body.start = { dateTime: block.start_datetime, timeZone: TZ };
    body.end   = { dateTime: block.end_datetime,   timeZone: TZ };
  }
  return body;
}
async function createBlockEvent(block) {
  if (!calendarConfigured()) { console.warn('[Calendar] Not configured — skipping'); return null; }
  const res = await getCalendar().events.insert({ calendarId: CALENDAR_ID, requestBody: blockEventBody(block) });
  console.log('[Calendar] Block event created:', res.data.id);
  return res.data.id;
}

// ── Delete event on cancel / contract delete ─────────────────────────────────
async function deleteCalendarEvent(eventId) {
  if (!calendarConfigured() || !eventId) return;
  try {
    await getCalendar().events.delete({ calendarId: CALENDAR_ID, eventId });
    console.log('[Calendar] Event deleted:', eventId);
  } catch(e) {
    if (e.code === 404 || e.status === 404) return; // already gone
    throw e;
  }
}

// ── Does this event exist (and isn't cancelled) on the configured calendar? ──
// Used by scripts/resync-calendar.js so a re-run never duplicates events.
async function calendarEventExists(eventId) {
  if (!calendarConfigured() || !eventId) return false;
  try {
    const res = await getCalendar().events.get({ calendarId: CALENDAR_ID, eventId });
    return res.data.status !== 'cancelled';
  } catch (e) {
    if ([404, 403, 410].includes(e.code) || [404, 403, 410].includes(e.status)) return false; // not on this calendar
    throw e;
  }
}

// ── Can the service account write to the configured calendar? ────────────────
// Lists one event; a calendar that isn't shared (or only free/busy) fails here.
async function checkCalendarAccess() {
  if (!calendarConfigured()) throw new Error('GOOGLE_CALENDAR_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY not set in .env');
  const cal = getCalendar();
  const acl = await cal.calendarList.get({ calendarId: CALENDAR_ID }).catch(() => null);
  if (acl && !['owner', 'writer'].includes(acl.data.accessRole)) {
    throw new Error(`Service account has "${acl.data.accessRole}" access — share the calendar with it as "Make changes to events"`);
  }
  await cal.events.list({ calendarId: CALENDAR_ID, maxResults: 1 });
  return { calendarId: CALENDAR_ID, account: process.env.GOOGLE_CLIENT_EMAIL, accessRole: acl ? acl.data.accessRole : 'unknown' };
}

module.exports = { createCalendarEvent, updateCalendarEvent, markEventDelivered, deleteCalendarEvent, calendarConfigured, calendarEventExists, checkCalendarAccess,
  createBlockEvent,
  _buildDescription: buildDescription, _buildSummary: buildSummary, _blockEventBody: blockEventBody }; // for tests
