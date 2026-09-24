// tests/helpers/app.js — spins up a real server.js instance per test file,
// pointed at a throwaway SQLite DB / uploads dir / activity log, with the
// Google Sheets, Google Calendar and email integrations mocked out so tests
// never touch production data or external services.
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

function createTestApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dht-test-'));

  process.env.DB_PATH           = path.join(tmpDir, 'test.db');
  process.env.UPLOADS_DIR       = path.join(tmpDir, 'uploads');
  process.env.ACTIVITY_LOG_PATH = path.join(tmpDir, 'activity.log');
  process.env.SESSION_SECRET    = 'test-session-secret';
  process.env.NODE_ENV          = 'test';

  jest.resetModules();

  jest.doMock('../../services/googleCalendar', () => ({
    createCalendarEvent: jest.fn().mockResolvedValue(null),
    updateCalendarEvent: jest.fn().mockResolvedValue(null),
    deleteCalendarEvent: jest.fn().mockResolvedValue(null),
    calendarConfigured:  jest.fn().mockReturnValue(false),
  }));

  jest.doMock('../../services/driveInventory', () => ({
    writeToAssigned:              jest.fn().mockResolvedValue(null),
    writeToTBO:                   jest.fn().mockResolvedValue(null),
    writeToDelivered:             jest.fn().mockResolvedValue(null),
    updateToScheduled:            jest.fn().mockResolvedValue(null),
    moveToDelivered:              jest.fn().mockResolvedValue(null),
    moveToCancelled:              jest.fn().mockResolvedValue(null),
    revertToAssigned:             jest.fn().mockResolvedValue(null),
    updateTBOSerial:              jest.fn().mockResolvedValue(null),
    moveToOrderPlaced:            jest.fn().mockResolvedValue(null),
    moveToReceived:               jest.fn().mockResolvedValue(null),
    moveFromReceivedToScheduled:  jest.fn().mockResolvedValue(null),
    moveFromReceivedToDelivered:  jest.fn().mockResolvedValue(null),
    moveFromReceivedToCancelled:  jest.fn().mockResolvedValue(null),
    updateReceivedSerial:         jest.fn().mockResolvedValue(null),
    deleteInventoryRow:           jest.fn().mockResolvedValue(null),
    updateInventoryItemField:     jest.fn().mockResolvedValue(null),
    updatePaymentInSheet:         jest.fn().mockResolvedValue(null),
  }));

  jest.doMock('../../utils/emailSender', () => ({
    notifyContractCreatedTBO:  jest.fn().mockResolvedValue(null),
    notifyOrderPlaced:         jest.fn().mockResolvedValue(null),
    notifyReceived:            jest.fn().mockResolvedValue(null),
    notifyPaymentRecorded:     jest.fn().mockResolvedValue(null),
    notifyDelivered:           jest.fn().mockResolvedValue(null),
    sendAcknowledgementEmail:  jest.fn().mockResolvedValue(null),
    sendEmail:                 jest.fn().mockResolvedValue(null),
    sendReviewRequestEmail:    jest.fn().mockResolvedValue(null),
    getStoreReviewUrl:         jest.fn().mockReturnValue('https://g.page/r/test/review'),
  }));

  const app = require('../../server');
  const db  = require('../../db/database');

  return { app, db, tmpDir };
}

function destroyTestApp(ctx) {
  if (ctx?.db) ctx.db.close();
  if (ctx?.tmpDir) fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

module.exports = { createTestApp, destroyTestApp };
