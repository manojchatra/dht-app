/**
 * Checks the email connection: connects and logs in to the SMTP server in
 * .env, with the mail server's certificate checked (as the app now does).
 * Sends nothing.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/check-smtp.js
 */
require('dotenv').config();
const { getTransporter, smtpConfigured } = require('../utils/emailSender');

if (!smtpConfigured()) {
  console.log('SMTP is not configured in .env (SMTP_HOST / SMTP_USER / SMTP_PASS) — emails are not sent.');
  process.exit(1);
}
getTransporter().verify()
  .then(() => { console.log(`OK: connected and logged in to ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465}, certificate valid.`); process.exit(0); })
  .catch(e => { console.error(`FAILED: ${e.message}`); process.exit(1); });
