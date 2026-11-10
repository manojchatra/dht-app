'use strict';
// scripts/fix-contract-date.js (services/contractDateFix.js): an old sale saved
// with today's date gets its real sale date; the number takes the new year/month
// and keeps its sequence, and its folder, photo paths, log and payments follow.
const fs   = require('fs');
const path = require('path');
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent, createContract } = require('./helpers/fixtures');

let ctx, admin, fix, today;
beforeAll(async () => {
  ctx = createTestApp();
  fix = require('../services/contractDateFix');
  today = require('../utils/arizona').phoenixToday();
  admin = await loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
});
afterAll(() => { destroyTestApp(ctx); });

const uploadsDir = () => process.env.UPLOADS_DIR;
const row = id => ctx.db.prepare('SELECT * FROM contracts WHERE id=?').get(id);
const plan = (number, date) => fix.planDateFix(ctx.db, number, date, { today, uploadsDir: uploadsDir() });
// An old sale entered today with today's sale date by mistake (delivered long ago).
const mistake = () => createContract(admin, { date: today, deliveryDate: '2026-09-25' });

describe('dates and numbers', () => {
  test('dates are read as M-DD-YYYY, M/DD/YYYY or YYYY-MM-DD; impossible dates are refused', () => {
    expect(fix.parseSaleDate('9-20-2026')).toBe('2026-09-20');
    expect(fix.parseSaleDate('09/20/2026')).toBe('2026-09-20');
    expect(fix.parseSaleDate('2026-09-20')).toBe('2026-09-20');
    for (const bad of ['2-30-2026', '13-01-2026', 'Sept 20', '']) expect(fix.parseSaleDate(bad)).toBeNull();
  });

  test('the number takes the new year/month and keeps its store code and sequence', () => {
    expect(fix.numberForDate('DHT2611PH00098', '2026-09-20')).toBe('DHT2609PH00098');
    expect(fix.numberForDate('DHT2611GY00087', '2025-12-01')).toBe('DHT2512GY00087');
    expect(fix.numberForDate('OLD-123', '2026-09-20')).toBeNull();
  });
});

describe('fixing a contract', () => {
  test('sale date, number, folder, photo paths, signing payment, log and notifications follow', async () => {
    const { contractId, contractNumber } = await mistake();
    const seq = contractNumber.slice(-5);
    const before = row(contractId);
    expect(before.back_entered).toBe(1);
    expect(before.extra_images).toContain(contractNumber); // the signature, in the contract's folder
    ctx.db.prepare("INSERT INTO notifications (contract_id, contract_num, event_type, message) VALUES (?,?,?,?)")
      .run(contractId, contractNumber, 'PAYMENT', `${contractNumber} — payment recorded`);
    // A payment recorded later keeps its date.
    ctx.db.prepare("INSERT INTO payments (contract_id, amount, method, date, created_at) VALUES (?,?,?,?, datetime('now','+1 day'))")
      .run(contractId, 100, 'cash', today);

    const p = plan(contractNumber, '9-20-2026');
    expect(p.after).toEqual({ date: '2026-09-20', number: 'DHT2609PH' + seq });
    expect(p.payments).toHaveLength(1);
    expect(p.folder.exists).toBe(true);
    fix.applyDateFix(ctx.db, p);

    const c = row(contractId);
    const NEW = 'DHT2609PH' + seq;
    expect([c.date, c.contract_number, JSON.parse(c.data).date]).toEqual(['2026-09-20', NEW, '2026-09-20']);
    const sig = JSON.parse(c.extra_images).find(i => i.label === 'Customer Signature').path;
    expect(sig).toContain(path.join('contracts', NEW, 'sig-contract-customer.png'));
    expect(fs.existsSync(sig)).toBe(true);
    expect(fs.existsSync(path.join(uploadsDir(), 'contracts', contractNumber))).toBe(false);

    const pays = ctx.db.prepare('SELECT amount, date FROM payments WHERE contract_id=? ORDER BY id').all(contractId);
    expect(pays).toEqual([{ amount: 5000, date: '2026-09-20' }, { amount: 100, date: today }]);
    expect(ctx.db.prepare('SELECT DISTINCT contract_num FROM activity_log WHERE contract_id=?').all(contractId)).toEqual([{ contract_num: NEW }]);
    expect(ctx.db.prepare('SELECT contract_num, message FROM notifications WHERE contract_id=?').get(contractId))
      .toEqual({ contract_num: NEW, message: `${NEW} — payment recorded` });

    // The PDF is rebuilt under the new number, into the renamed folder.
    const pdf = await admin.get(`/api/contracts/${contractId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-disposition']).toContain(NEW);
    expect(fs.existsSync(path.join(uploadsDir(), 'contracts', NEW, 'contract.pdf'))).toBe(true);
  }, 30000);

  test('a contract that was not entered after delivery keeps its payment dates', async () => {
    const { contractId, contractNumber } = await createContract(admin, { date: today });
    const p = plan(contractNumber, '10-01-2026');
    expect(p.payments).toEqual([]);
    fix.applyDateFix(ctx.db, p);
    expect(ctx.db.prepare('SELECT date FROM payments WHERE contract_id=?').get(contractId).date).toBe(today);
    expect(row(contractId).contract_number).toBe('DHT2610PH' + contractNumber.slice(-5));
  });

  test('refused: future or same date, unknown contract, a calendar event, a number already taken', async () => {
    const { contractId, contractNumber } = await mistake();
    expect(() => plan(contractNumber, '1-01-2099')).toThrow(/in the future/);
    expect(() => plan(contractNumber, 'soon')).toThrow(/isn't a date/);
    expect(() => plan(contractNumber, today)).toThrow(/already has the sale date/);
    expect(() => plan('DHT0000XX00000', '9-20-2026')).toThrow(/not found/);

    ctx.db.prepare("UPDATE contracts SET calendar_event_id='evt1' WHERE id=?").run(contractId);
    expect(() => plan(contractNumber, '9-20-2026')).toThrow(/calendar event/);
    ctx.db.prepare('UPDATE contracts SET calendar_event_id=NULL WHERE id=?').run(contractId);

    const other = await mistake();
    ctx.db.prepare('UPDATE contracts SET contract_number=? WHERE id=?').run('DHT2609PH' + contractNumber.slice(-5), other.contractId);
    expect(() => plan(contractNumber, '9-20-2026')).toThrow(/already used/);
    expect(row(contractId).contract_number).toBe(contractNumber); // nothing changed
  });

  test('a delivery date before the new sale date is warned about', async () => {
    const { contractNumber } = await mistake();
    expect(plan(contractNumber, '10-01-2026').warnings[0]).toMatch(/after the delivery date \(2026-09-25\)/);
  });

  test('a failed save puts the folder back', async () => {
    const { contractId, contractNumber } = await mistake();
    const p = plan(contractNumber, '9-21-2026');
    p.payments = [{ id: 'not-a-number' }];
    const broken = { ...ctx.db, transaction: () => () => { throw new Error('disk full'); } };
    expect(() => fix.applyDateFix(broken, p)).toThrow(/disk full/);
    expect(fs.existsSync(path.join(uploadsDir(), 'contracts', contractNumber))).toBe(true);
    expect(row(contractId).contract_number).toBe(contractNumber);
  });
});

test('the script is wired to the Sheet and Customer Record updates', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/fix-contract-date.js'), 'utf8');
  expect(src).toMatch(/drive\.fixContractRowNumberAndDate\(before\.number, after\.number, after\.date\)/);
  expect(src).toMatch(/if \(renumber\) await removeCustomerRecord\(before\.number\);/);
  expect(src).toMatch(/backup-db\.js'\), '--manual'\]/);
  expect(typeof require('../services/driveInventory').fixContractRowNumberAndDate).toBe('function');
});
