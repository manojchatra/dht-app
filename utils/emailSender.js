/**
 * emailSender.js — Transactional email via SMTP: the delivery-acknowledgement
 * email, plus the Stage 7 status-change notification templates (contract
 * created as TBO, order placed, received, payment recorded, delivered).
 * Requires: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env
 */
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const db         = require('../db/database');

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

// ── Generic send + Stage 7 recipient resolution ──────────────────────────────
async function sendEmail({ to, subject, text, html, attachments }) {
  const recipients = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (!recipients.length) return; // nothing to send — not an error, just a no-op
  if (!smtpConfigured()) throw new Error('SMTP not configured — add SMTP_HOST, SMTP_USER, SMTP_PASS to .env');

  await getTransporter().sendMail({
    from: `"Desert Hot Tubs" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject, text, html,
    attachments: attachments || [],
  });
  console.log(`[Email] "${subject}" sent to:`, recipients.join(', '));
}

// The "Admin" recipient set for notifications is the same manually-curated
// list used by the acknowledgement-email flow (Settings > Email Recipients),
// not a derived list of role='admin' users — confirmed with user.
function getAdminRecipients() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='email_recipients'").get();
    return row ? JSON.parse(row.value || '[]') : [];
  } catch (e) { return []; }
}

function getSalesmanEmail(contract) {
  if (!contract?.salesman_user_id) return null;
  const row = db.prepare("SELECT email FROM users WHERE id=? AND email IS NOT NULL AND email!=''").get(contract.salesman_user_id);
  return row?.email || null;
}

const footer = '\n\n— Desert Hot Tubs';

// A — contract created as To Be Ordered → salesperson + admin
async function notifyContractCreatedTBO({ contract, customerName }) {
  const to = [getSalesmanEmail(contract), ...getAdminRecipients()];
  const subject = `New Contract (To Be Ordered) — ${contract.contract_number} — ${customerName || ''}`;
  const text = [
    'A new contract has been created and is awaiting order placement.',
    '',
    `Contract #: ${contract.contract_number}`,
    `Customer: ${customerName || ''}`,
    `Make / Model: ${contract.make || ''} / ${contract.model || ''}`,
    `Store: ${contract.store || ''}`,
  ].join('\n') + footer;
  await sendEmail({ to, subject, text });
}

// C — admin moves contract to Order Placed → salesperson only
async function notifyOrderPlaced({ contract, customerName, webOrderNumber, truckNumber }) {
  const to = [getSalesmanEmail(contract)];
  const subject = `Order Placed — ${contract.contract_number} — ${customerName || ''}`;
  const text = [
    'This contract\'s order has been placed with the manufacturer.',
    '',
    `Contract #: ${contract.contract_number}`,
    `Customer: ${customerName || ''}`,
    `Web Order #: ${webOrderNumber || ''}`,
    `Truck #: ${truckNumber || ''}`,
  ].join('\n') + footer;
  await sendEmail({ to, subject, text });
}

// B/D — order received, ready to schedule → salesperson + admin
async function notifyReceived({ contract, customerName }) {
  const to = [getSalesmanEmail(contract), ...getAdminRecipients()];
  const subject = `Order Received — Ready to Schedule — ${contract.contract_number} — ${customerName || ''}`;
  const text = [
    'This order has been received into inventory and is ready to schedule for delivery.',
    '',
    `Contract #: ${contract.contract_number}`,
    `Customer: ${customerName || ''}`,
  ].join('\n') + footer;
  await sendEmail({ to, subject, text });
}

// E — every payment recorded → admin, with the receipt PDF attached
async function notifyPaymentRecorded({ contract, customerName, amount, method, totalPaid, balance, receiptPath }) {
  const to = getAdminRecipients();
  const subject = `Payment Recorded — ${contract.contract_number} — ${customerName || ''}`;
  const text = [
    `A payment of $${Math.round(amount).toLocaleString()} (${method}) was recorded.`,
    '',
    `Contract #: ${contract.contract_number}`,
    `Customer: ${customerName || ''}`,
    `Total Paid: $${Math.round(totalPaid).toLocaleString()}`,
    `Remaining Balance: $${Math.round(balance).toLocaleString()}`,
  ].join('\n') + footer;
  const attachments = (receiptPath && fs.existsSync(receiptPath))
    ? [{ filename: path.basename(receiptPath), path: receiptPath }]
    : [];
  await sendEmail({ to, subject, text, attachments });
}

// F — contract marked Delivered → salesperson, 48hr follow-up reminder
async function notifyDelivered({ contract, customerName }) {
  const to = [getSalesmanEmail(contract)];
  const subject = `Delivered — Complete Post-Delivery Follow-up — ${contract.contract_number} — ${customerName || ''}`;
  const text = [
    `${customerName || 'This customer'}'s spa has been marked delivered.`,
    'Please complete the post-delivery follow-up call within 48 hours.',
    '',
    `Contract #: ${contract.contract_number}`,
    `Customer: ${customerName || ''}`,
  ].join('\n') + footer;
  await sendEmail({ to, subject, text });
}

module.exports = {
  sendAcknowledgementEmail, smtpConfigured, sendEmail,
  getAdminRecipients, getSalesmanEmail,
  notifyContractCreatedTBO, notifyOrderPlaced, notifyReceived,
  notifyPaymentRecorded, notifyDelivered,
};
