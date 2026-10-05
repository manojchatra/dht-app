'use strict';
const { createTestApp, destroyTestApp } = require('./helpers/app');
const { loginAgent } = require('./helpers/fixtures');

let ctx;
beforeAll(() => { ctx = createTestApp(); });
afterAll(() => { destroyTestApp(ctx); });

const emailSender = () => require('../utils/emailSender');
const admin = () => loginAgent(ctx.app, { username: 'admin', password: 'admin123' });
const flush = () => new Promise(r => setImmediate(r)); // the email is sent after the response

describe('welcome email for new users', () => {
  beforeEach(() => emailSender().notifyUserCreated.mockReset().mockResolvedValue(null));

  test('creating a user from Settings emails them their username (never the password)', async () => {
    const agent = await admin();
    const res = await agent.post('/api/users').send({ username: 'Crew1', password: 'Secret123', role: 'delivery', team: 'team_a', name: 'Crew One', email: 'crew1@example.com' });
    await flush();

    expect(res.status).toBe(200);
    expect(emailSender().notifyUserCreated).toHaveBeenCalledWith({ name: 'Crew One', username: 'crew1', email: 'crew1@example.com' });
    expect(JSON.stringify(emailSender().notifyUserCreated.mock.calls)).not.toContain('Secret123');
  });

  test('creating a salesperson from the Sales page emails them too', async () => {
    const agent = await admin();
    const res = await agent.post('/api/sales').send({ name: 'Sam Sales', username: 'sam', email: 'sam@example.com', password: 'Secret123' });
    await flush();

    expect(res.status).toBe(200);
    expect(emailSender().notifyUserCreated).toHaveBeenCalledWith({ name: 'Sam Sales', username: 'sam', email: 'sam@example.com' });
  });

  test('the account is still created when the email fails', async () => {
    const agent = await admin();
    emailSender().notifyUserCreated.mockRejectedValue(new Error('smtp down'));
    const res = await agent.post('/api/sales').send({ name: 'Pat', username: 'pat', email: 'pat@example.com', password: 'Secret123' });
    await flush();

    expect(res.status).toBe(200);
    expect(ctx.db.prepare("SELECT 1 FROM users WHERE username='pat'").get()).toBeTruthy();
  });

  test('a duplicate username sends nothing', async () => {
    const agent = await admin();
    await agent.post('/api/sales').send({ name: 'Dup', username: 'dupe', email: 'd@example.com', password: 'Secret123' });
    emailSender().notifyUserCreated.mockClear();
    const res = await agent.post('/api/sales').send({ name: 'Dup', username: 'dupe', email: 'd@example.com', password: 'Secret123' });
    await flush();

    expect(res.status).toBe(409);
    expect(emailSender().notifyUserCreated).not.toHaveBeenCalled();
  });
});
