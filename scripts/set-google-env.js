/**
 * Point the app at a (new) Google service account, Sheet and Calendar by
 * writing the four Google lines of .env straight from the service-account
 * JSON key — no hand-copying of the private key.
 *
 * Usage (on the server, from /home/DHT/dht-app):
 *   node scripts/set-google-env.js <key.json> <sheet-id> <calendar-id>
 *
 * Backs up .env to .env.bak-<timestamp> first; other lines are left untouched.
 * Restart the app afterwards (pm2 restart dht-app).
 */
const fs = require('fs');
const path = require('path');

const [keyFile, sheetId, calendarId] = process.argv.slice(2);
if (!keyFile || !sheetId || !calendarId) {
  console.log('Usage: node scripts/set-google-env.js <key.json> <sheet-id> <calendar-id>');
  process.exit(1);
}

const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
if (!key.client_email || !key.private_key) throw new Error(`${keyFile} is not a service-account key (no client_email / private_key)`);

const envPath = path.join(__dirname, '../.env');
const original = fs.readFileSync(envPath, 'utf8');
const backup = `${envPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.writeFileSync(backup, original, { mode: 0o600 });

const values = {
  GOOGLE_CLIENT_EMAIL: key.client_email,
  // One line, newlines as \n, double-quoted — the app turns \n back into newlines.
  GOOGLE_PRIVATE_KEY: '"' + key.private_key.replace(/\r?\n/g, '\\n') + '"',
  INVENTORY_FILE_ID: sheetId.trim(),
  GOOGLE_CALENDAR_ID: calendarId.trim(),
};

let out = original;
for (const [name, value] of Object.entries(values)) {
  const line = new RegExp(`^${name}=.*$`, 'm');
  out = line.test(out) ? out.replace(line, () => `${name}=${value}`) : out.replace(/\n?$/, `\n${name}=${value}\n`);
}
fs.writeFileSync(envPath, out, { mode: 0o600 });

console.log(`.env updated (backup: ${path.basename(backup)})`);
console.log(`  GOOGLE_CLIENT_EMAIL = ${values.GOOGLE_CLIENT_EMAIL}`);
console.log(`  GOOGLE_PRIVATE_KEY  = (from ${path.basename(keyFile)}, ${key.private_key.length} chars)`);
console.log(`  INVENTORY_FILE_ID   = ${values.INVENTORY_FILE_ID}`);
console.log(`  GOOGLE_CALENDAR_ID  = ${values.GOOGLE_CALENDAR_ID}`);
console.log('Now restart: pm2 restart dht-app');
