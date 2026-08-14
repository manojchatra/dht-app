/**
 * emailSender.js — Delivery acknowledgement email via SMTP
 * Requires: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env
 */
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  const port = parseInt(process.env.SMTP_PORT) || 465;
  const opts = {
    host:              process.env.SMTP_HOST || 'localhost',
    port,
    secure:            port === 465,
    tls:               { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
  };
  // Port 25 = local relay, no auth needed
  if (port !== 25 && process.env.SMTP_USER && process.env.SMTP_PASS) {
    opts.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  }
  return nodemailer.createTransport(opts);
}

function fmtDate(isoDate) {
  const d = new Date((isoDate || new Date().toISOString().slice(0,10)) + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' });
}

async function sendAcknowledgementEmail({ contract, pdfPath, recipients }) {
  if (!smtpConfigured()) throw new Error('SMTP not configured — add SMTP_HOST, SMTP_USER, SMTP_PASS to .env');
  if (!fs.existsSync(pdfPath))  throw new Error('Acknowledgement PDF not found at: ' + pdfPath);
  if (!recipients || recipients.length === 0) throw new Error('No recipients specified');

  const d         = JSON.parse(contract.data || '{}');
  const cu        = d.customer || {};
  const pr        = d.product  || {};
  const date      = fmtDate(contract.delivery_date);
  const custName  = cu.name  || contract.customer_name || 'Customer';
  const address   = [(cu.address||''), (cu.city||''), (cu.zip||'')].filter(Boolean).join(', ');
  const make      = contract.make  || pr.make  || '';
  const model     = contract.model || pr.model || '';
  const serial    = contract.serial_number || pr.serialNumber || '';
  const shell     = pr.shellColor   || '';
  const cabinet   = pr.cabinetColor || '';

  const subject = `Delivery Acknowledgement — ${contract.contract_number} — ${date} — ${custName}`;
  const text    = [
    `${date} Delivery`,
    '',
    `Customer Name: ${custName}`,
    `Address: ${address}`,
    `Make / Model: ${make} / ${model}`,
    `Serial: ${serial}`,
    `Shell Color: ${shell}   Cabinet Color: ${cabinet}`,
    '',
    'Your signed delivery acknowledgement is attached.',
    'Thank you for your purchase from Desert Hot Tubs.',
    '— Desert Hot Tubs / deliveries@deserthottubsaz.com',
  ].join('\n');

  await getTransporter().sendMail({
    from:        `"Desert Hot Tubs" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to:          recipients.join(', '),
    subject,
    text,
    attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
  });

  console.log('[Email] Acknowledgement sent to:', recipients.join(', '));
}

module.exports = { sendAcknowledgementEmail, smtpConfigured };
