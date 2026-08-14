/**
 * driveInventory.js v8
 * - Contract ID as primary key for all row operations
 * - Full bidirectional tab movement
 * - Tabs: Inventory (read), Assigned, TBO, Delivered, Cancelled
 */

const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');

const CACHE_PATH     = path.join(__dirname, '../../data/inventory_cache.json');
const CACHE_TTL_MS   = 5 * 60 * 1000;
const SPREADSHEET_ID = process.env.INVENTORY_FILE_ID;
const INVENTORY_TAB  = 'Inventory';

// ── Column headers ────────────────────────────────────────────────────────────
const ASSIGNED_HEADERS = [
  'Contract ID','Contract Date','Make','Model','Year','Shell','Cabinet',
  'Serial Number','Sales Man','Customer','Address','Zip','Cover','Steps',
  'Water Care','Accessories','Paid','Pending','Status','Schedule Date & Time'
];
const TBO_HEADERS = [
  'Contract ID','Contract Date','Make','Model','Year','Shell','Cabinet',
  'Serial Number','Sales Man','Customer','Address','Zip','Cover','Steps',
  'Water Care','Accessories','Paid','Pending','Status'
];
const DELIVERED_HEADERS = [
  'Contract ID','Contract Date','Delivery Date','Make','Model','Year','Shell','Cabinet',
  'Serial Number','Sales Man','Customer','Address','Zip','Cover','Steps',
  'Water Care','Accessories','Paid','Pending','Status'
];
const CANCELLED_HEADERS = [
  'Contract ID','Contract Date','Cancelled Date','Make','Model','Year','Shell','Cabinet',
  'Serial Number','Sales Man','Customer','Address','Zip','Cover','Steps',
  'Water Care','Accessories','Paid','Pending','Status'
];

const RECEIVED_HEADERS = [
  'Contract ID','Contract Date','Received Date','Make','Model','Year','Shell','Cabinet',
  'Serial Number','Serial Photo URL','Sales Man','Customer','Address','Zip','Cover','Steps',
  'Water Care','Accessories','Paid','Pending','Status'
];

// ── Auth ──────────────────────────────────────────────────────────────────────
function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'),
    },
    scopes:[
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}
function getSheets() { return google.sheets({ version:'v4', auth:getAuth() }); }

// ── Tab management ────────────────────────────────────────────────────────────
async function ensureTab(sheets, tabName, headers) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests:[{ addSheet:{ properties:{ title:tabName } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values:[headers] }
    });
  }
}

async function getSheetId(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
  return sheet ? sheet.properties.sheetId : null;
}

// ── Row operations ────────────────────────────────────────────────────────────
async function findRowByContractId(sheets, tabName, contractId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!A:A`,
    });
    const values = res.data.values || [];
    for (let i = 1; i < values.length; i++) {
      if ((values[i][0]||'').trim() === contractId.trim()) return i + 1; // 1-indexed
    }
    return -1;
  } catch(e) {
    if (e.message && e.message.includes('Unable to parse range')) return -1;
    throw e;
  }
}

async function deleteRow(sheets, tabName, rowIndex1Based) {
  const sheetId = await getSheetId(sheets, tabName);
  if (sheetId === null) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests:[{
      deleteDimension: {
        range: {
          sheetId, dimension:'ROWS',
          startIndex: rowIndex1Based - 1,
          endIndex:   rowIndex1Based,
        }
      }
    }] }
  });
}

async function appendRow(sheets, tabName, headers, row) {
  await ensureTab(sheets, tabName, headers);
  const colLetter = String.fromCharCode(64 + headers.length);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A:${colLetter}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values:[row] }
  });
}

async function updateCell(sheets, tabName, rowIndex1Based, colIndex1Based, value) {
  const col = String.fromCharCode(64 + colIndex1Based);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!${col}${rowIndex1Based}`,
    valueInputOption: 'RAW',
    requestBody: { values:[[value]] }
  });
}

// ── Row builders ──────────────────────────────────────────────────────────────
function buildAssignedRow(d, status, scheduleDatetime) {
  return [
    d.contractNumber, d.contractDate, d.make||'', d.model||'', d.year||'',
    d.shellColor||'', d.cabinetColor||'', d.serialNumber||'',
    d.salesman||'', d.customerName||'', d.address||'', d.zip||'',
    d.cover||'', d.steps||'', d.waterCare||'', d.accessories||'',
    d.paid||'', d.pending||'', status||'Assigned', scheduleDatetime||''
  ];
}

function buildTBORow(d, status) {
  return [
    d.contractNumber, d.contractDate, d.make||'', d.model||'', d.year||'',
    d.shellColor||'', d.cabinetColor||'', d.serialNumber||'',
    d.salesman||'', d.customerName||'', d.address||'', d.zip||'',
    d.cover||'', d.steps||'', d.waterCare||'', d.accessories||'',
    d.paid||'', d.pending||'', status||'TBO'
  ];
}

function buildDeliveredRow(d, deliveryDate) {
  return [
    d.contractNumber, d.contractDate, deliveryDate,
    d.make||'', d.model||'', d.year||'', d.shellColor||'', d.cabinetColor||'',
    d.serialNumber||'', d.salesman||'', d.customerName||'', d.address||'', d.zip||'',
    d.cover||'', d.steps||'', d.waterCare||'', d.accessories||'',
    d.paid||'', d.pending||'', 'Delivered'
  ];
}

function buildCancelledRow(d, cancelledDate) {
  return [
    d.contractNumber, d.contractDate, cancelledDate,
    d.make||'', d.model||'', d.year||'', d.shellColor||'', d.cabinetColor||'',
    d.serialNumber||'', d.salesman||'', d.customerName||'', d.address||'', d.zip||'',
    d.cover||'', d.steps||'', d.waterCare||'', d.accessories||'',
    d.paid||'', d.pending||'', 'Cancelled'
  ];
}

function buildReceivedRow(d, receivedDate, serialPhotoUrl) {
  return [
    d.contractNumber, d.contractDate, receivedDate,
    d.make||'', d.model||'', d.year||'', d.shellColor||'', d.cabinetColor||'',
    d.serialNumber||'', serialPhotoUrl||'',
    d.salesman||'', d.customerName||'', d.address||'', d.zip||'',
    d.cover||'', d.steps||'', d.waterCare||'', d.accessories||'',
    d.paid||'', d.pending||'', 'Received'
  ];
}

// ── Inventory (read-only) ─────────────────────────────────────────────────────
async function fetchFromSheets() {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${INVENTORY_TAB}!A:Z`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h,i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

async function getInventory(forceRefresh = false) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
  if (!forceRefresh && fs.existsSync(CACHE_PATH)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH,'utf8'));
    if (Date.now() - cache.timestamp < CACHE_TTL_MS) return cache.data;
  }
  const rows = await fetchFromSheets();
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ timestamp:Date.now(), data:rows }));
  return rows;
}

async function searchInventory(query='', storeFilter='') {
  const rows = await getInventory();
  const q = query.trim().toLowerCase();
  const STORE_MAP = {
    stock:'stock', emp:'emp room',
    phoenix:'phoenix', goodyear:'goodyear',
    chandler:'chandler', surprise:'surprise', tolleson:'tolleson',
  };
  return rows.filter(row => {
    const avail = (row['Availability']||'').toLowerCase();
    if (storeFilter) {
      const target = STORE_MAP[storeFilter.toLowerCase()];
      if (target && !avail.includes(target)) return false;
    }
    if (q) {
      const hay = [row['Make'],row['Series'],row['Model'],
        row['Serial Number'],row['Shell'],row['Cabinet'],row['Availability']
      ].join(' ').toLowerCase();
      return hay.includes(q);
    }
    return true;
  });
}

function getLastSynced() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  return new Date(JSON.parse(fs.readFileSync(CACHE_PATH,'utf8')).timestamp).toISOString();
}

function invalidateCache() {
  if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
}

async function deleteInventoryRow(serialNumber) {
  if (!serialNumber) return;
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID });
  const invSheet = meta.data.sheets.find(s => s.properties.title === INVENTORY_TAB);
  if (!invSheet) return;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId:SPREADSHEET_ID, range:`${INVENTORY_TAB}!A:Z`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return;
  const headers = rows[0];
  const serialCol = headers.indexOf('Serial Number');
  if (serialCol === -1) return;
  let rowIndex = -1;
  for (let i=1; i<rows.length; i++) {
    if ((rows[i][serialCol]||'').trim() === serialNumber.trim()) { rowIndex=i; break; }
  }
  if (rowIndex === -1) { console.warn('[Drive] Serial not found in Inventory:', serialNumber); return; }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests:[{ deleteDimension:{
      range:{ sheetId:invSheet.properties.sheetId, dimension:'ROWS',
              startIndex:rowIndex, endIndex:rowIndex+1 }
    }}]}
  });
  invalidateCache();
  console.log('[Drive] Removed serial', serialNumber, 'from Inventory');
}

// ── Write on contract save ────────────────────────────────────────────────────
async function writeToAssigned(d) {
  const sheets = getSheets();
  const row = buildAssignedRow(d, 'Assigned', '');
  await appendRow(sheets, 'Assigned', ASSIGNED_HEADERS, row);
  invalidateCache();
}

async function writeToTBO(d) {
  const sheets = getSheets();
  const row = buildTBORow(d, 'TBO');
  await appendRow(sheets, 'TBO', TBO_HEADERS, row);
  invalidateCache();
}

async function writeToDelivered(d, deliveryDate) {
  const sheets = getSheets();
  const row = buildDeliveredRow(d, deliveryDate);
  await appendRow(sheets, 'Delivered', DELIVERED_HEADERS, row);
  invalidateCache();
}

// ── Status transitions ────────────────────────────────────────────────────────

// Update status/schedule in Assigned tab (for Assigned → Scheduled)
async function updateToScheduled(contractNumber, scheduledDatetime, contractData) {
  const sheets = getSheets();

  // Check if in TBO first — if so, move to Assigned
  const tboRow = await findRowByContractId(sheets, 'TBO', contractNumber);
  if (tboRow > 0) {
    await deleteRow(sheets, 'TBO', tboRow);
    const row = buildAssignedRow(contractData, 'Scheduled', scheduledDatetime);
    await appendRow(sheets, 'Assigned', ASSIGNED_HEADERS, row);
    console.log('[Drive] Moved TBO → Assigned (Scheduled):', contractNumber);
    return;
  }

  // Already in Assigned — update status and schedule datetime
  const assignedRow = await findRowByContractId(sheets, 'Assigned', contractNumber);
  if (assignedRow > 0) {
    await updateCell(sheets, 'Assigned', assignedRow, 19, 'Scheduled');       // Status col
    await updateCell(sheets, 'Assigned', assignedRow, 20, scheduledDatetime); // Schedule col
    console.log('[Drive] Updated Assigned → Scheduled:', contractNumber);
  } else {
    console.warn('[Drive] Contract not found for scheduling:', contractNumber);
  }
}

// Move to Delivered from Assigned or TBO
async function moveToDelivered(contractNumber, deliveryDate, contractData) {
  const sheets = getSheets();

  for (const tab of ['Assigned','TBO']) {
    const rowIndex = await findRowByContractId(sheets, tab, contractNumber);
    if (rowIndex > 0) {
      await deleteRow(sheets, tab, rowIndex);
      const row = buildDeliveredRow(contractData, deliveryDate);
      await appendRow(sheets, 'Delivered', DELIVERED_HEADERS, row);
      console.log('[Drive] Moved', tab, '→ Delivered:', contractNumber);
      return;
    }
  }
  // Not found — append directly (edge case: contract saved as auto-delivered)
  const row = buildDeliveredRow(contractData, deliveryDate);
  await appendRow(sheets, 'Delivered', DELIVERED_HEADERS, row);
  console.log('[Drive] Appended to Delivered (source not found):', contractNumber);
}

// Move to Cancelled from Assigned or TBO
async function moveToCancelled(contractNumber, cancelledDate, contractData) {
  const sheets = getSheets();

  for (const tab of ['Assigned','TBO']) {
    const rowIndex = await findRowByContractId(sheets, tab, contractNumber);
    if (rowIndex > 0) {
      await deleteRow(sheets, tab, rowIndex);
      const row = buildCancelledRow(contractData, cancelledDate);
      await appendRow(sheets, 'Cancelled', CANCELLED_HEADERS, row);
      console.log('[Drive] Moved', tab, '→ Cancelled:', contractNumber);
      return;
    }
  }
  console.warn('[Drive] Contract not found for cancellation:', contractNumber);
}

// Move back to Assigned from Cancelled (revert)
async function revertToAssigned(contractNumber, contractData) {
  const sheets = getSheets();

  const cancelledRow = await findRowByContractId(sheets, 'Cancelled', contractNumber);
  if (cancelledRow > 0) {
    await deleteRow(sheets, 'Cancelled', cancelledRow);
    // Add "prev. cancelled" note to status
    const row = buildAssignedRow(contractData, 'Assigned (prev. cancelled)', '');
    await appendRow(sheets, 'Assigned', ASSIGNED_HEADERS, row);
    console.log('[Drive] Reverted Cancelled → Assigned:', contractNumber);
    return;
  }
  console.warn('[Drive] Contract not found in Cancelled for revert:', contractNumber);
}

// Update serial number in TBO tab
async function updateTBOSerial(contractNumber, serialNumber) {
  const sheets = getSheets();
  const rowIndex = await findRowByContractId(sheets, 'TBO', contractNumber);
  if (rowIndex < 0) {
    // Try Assigned (if already scheduled)
    const assignedRow = await findRowByContractId(sheets, 'Assigned', contractNumber);
    if (assignedRow > 0) {
      await updateCell(sheets, 'Assigned', assignedRow, 8, serialNumber); // Serial col 8
      console.log('[Drive] Updated serial in Assigned:', contractNumber, serialNumber);
    }
    return;
  }
  await updateCell(sheets, 'TBO', rowIndex, 8, serialNumber); // Serial col 8
  console.log('[Drive] Updated serial in TBO:', contractNumber, serialNumber);
}

// Legacy updateRowStatus (kept for backward compatibility)
async function updateRowStatus(contractData, newStatus) {
  console.log('[Drive] updateRowStatus called (legacy):', contractData.contractNumber, newStatus);
}

// ── Received tab operations ──────────────────────────────────────────────────
async function moveToReceived(contractNumber, receivedDate, serialPhotoUrl, contractData) {
  const sheets = getSheets();
  const tboRow = await findRowByContractId(sheets, 'TBO', contractNumber);
  if (tboRow > 0) await deleteRow(sheets, 'TBO', tboRow);
  await appendRow(sheets, 'Received', RECEIVED_HEADERS, buildReceivedRow(contractData, receivedDate, serialPhotoUrl));
  console.log('[Drive] Moved TBO → Received:', contractNumber);
}

async function moveFromReceivedToScheduled(contractNumber, scheduledDatetime, contractData) {
  const sheets = getSheets();
  const row = await findRowByContractId(sheets, 'Received', contractNumber);
  if (row > 0) await deleteRow(sheets, 'Received', row);
  await appendRow(sheets, 'Assigned', ASSIGNED_HEADERS, buildAssignedRow(contractData, 'Scheduled', scheduledDatetime));
  console.log('[Drive] Moved Received → Assigned(Scheduled):', contractNumber);
}

async function moveFromReceivedToDelivered(contractNumber, deliveryDate, contractData) {
  const sheets = getSheets();
  const row = await findRowByContractId(sheets, 'Received', contractNumber);
  if (row > 0) await deleteRow(sheets, 'Received', row);
  await appendRow(sheets, 'Delivered', DELIVERED_HEADERS, buildDeliveredRow(contractData, deliveryDate));
  console.log('[Drive] Moved Received → Delivered:', contractNumber);
}

async function moveFromReceivedToCancelled(contractNumber, cancelledDate, contractData) {
  const sheets = getSheets();
  const row = await findRowByContractId(sheets, 'Received', contractNumber);
  if (row > 0) await deleteRow(sheets, 'Received', row);
  await appendRow(sheets, 'Cancelled', CANCELLED_HEADERS, buildCancelledRow(contractData, cancelledDate));
  console.log('[Drive] Moved Received → Cancelled:', contractNumber);
}

async function updateReceivedSerial(contractNumber, serialNumber, serialPhotoUrl) {
  const sheets = getSheets();
  const rowIndex = await findRowByContractId(sheets, 'Received', contractNumber);
  if (rowIndex < 0) { await updateTBOSerial(contractNumber, serialNumber); return; }
  await updateCell(sheets, 'Received', rowIndex, 9,  serialNumber);
  await updateCell(sheets, 'Received', rowIndex, 10, serialPhotoUrl||'');
  console.log('[Drive] Updated serial in Received:', contractNumber);
}

module.exports = {
  searchInventory, getInventory, getLastSynced, invalidateCache,
  deleteInventoryRow,
  writeToAssigned, writeToTBO, writeToDelivered,
  updateToScheduled, moveToDelivered, moveToCancelled,
  revertToAssigned, updateTBOSerial, updateRowStatus,
  moveToReceived, moveFromReceivedToScheduled,
  moveFromReceivedToDelivered, moveFromReceivedToCancelled,
  updateReceivedSerial,
};
