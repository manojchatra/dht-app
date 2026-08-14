# Desert Hot Tubs — Sales & Delivery Portal

Internal web application for Desert Hot Tubs (DHT), a multi-location spa retailer in the Phoenix metro area. Manages sales contracts, customer records, delivery scheduling, payment tracking, and delivery acknowledgements across five showrooms: Phoenix, Goodyear, Chandler, Surprise, and Tolleson.

Production: `https://app.deserthottubsaz.com`

For full feature documentation, workflows, and cumulative technical learnings, see [DHT-project-summary-v12.md](./DHT-project-summary-v12.md).

## Stack

- **Backend:** Node.js / Express
- **Database:** SQLite (`better-sqlite3`)
- **Process manager:** PM2
- **Reverse proxy:** nginx (via Hestia Control Panel)
- **Integrations:** Google Sheets API, Google Calendar API, Brevo SMTP (via `nodemailer`)
- **PDFs:** `pdfmake`
- **File uploads:** `multer`, `sharp` (image compression)
- **Frontend:** Static HTML/JS/CSS, FullCalendar.js

## Project Structure

```
├── server.js              Entry point — routes, auth, static page serving
├── db/database.js         SQLite connection + schema
├── middleware/auth.js     Session-based auth (requireAuth, requireAdmin, etc.)
├── routes/                contracts, payments, auth, users, delivery,
│                          settings-api, notifications, inventory
├── services/               driveInventory.js, googleCalendar.js
├── utils/                  pdfGenerator, acknowledgementPDF, receiptGenerator,
│                          emailSender, imageUtils, activityLogger
├── public/                 Source HTML pages (login, dashboard, contracts, etc.)
├── ecosystem.config.js    PM2 process config
└── nginx.ssl.conf_proxy   nginx reverse-proxy snippet for the Node app
```

**Note on deployed pages:** in production, the HTML pages served by `server.js`'s page routes are read from `/home/DHT/web/app.deserthottubsaz.com/public_html/` on the VPS, not from this repo's local `public/` folder directly — keep both in sync when deploying.

## Local Development

```bash
npm install
cp .env.example .env   # fill in real values
npm start               # runs on http://localhost:3001
```

## Environment Variables

See `.env.example`. Required at minimum:

```
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
INVENTORY_FILE_ID=
GOOGLE_CALENDAR_ID=
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=deliveries@deserthottubsaz.com
SESSION_SECRET=
```

`.env` values containing `$` should be single-quoted (e.g. `SMTP_PASS='value$$'`) to avoid shell/dotenv expansion issues.

## Deployment (Contabo VPS, Hestia Control Panel)

The app runs under PM2 on port 3001, behind nginx (Hestia-managed) which terminates SSL and reverse-proxies to Node.

```bash
pm2 start ecosystem.config.js   # first deploy
pm2 restart dht-app             # after a server.js/routes change (drops active sessions — MemoryStore)
```

Static HTML page edits (files under `public/`, deployed to `.../public_html/`) take effect immediately — no restart needed.

**Hestia-specific gotcha:** this domain's nginx vhost uses a custom web template (`dht-node`) at `/usr/local/hestia/data/templates/web/nginx/php-fpm/dht-node.{tpl,stpl}` rather than Hestia's `default` template, so that Node routing survives Hestia rebuilds/SSL renewals without a base-template `location /` block conflicting with the app's own proxy rules. If this domain's template is ever reset to `default` in Hestia, the app will stop being reachable (nginx will serve static/PHP fallback content instead of proxying to Node) — reassign it with:

```bash
sudo /usr/local/hestia/bin/v-change-web-domain-tpl DHT app.deserthottubsaz.com dht-node
sudo nginx -t && sudo systemctl reload nginx
```

## Known Limitations

- **Sessions are in-memory** (`express-session` `MemoryStore`) — any `pm2 restart` logs out all active users. A persistent (SQLite-backed) session store is planned; see "On The Horizon" in the project summary.
- PM2 is not on the default `$PATH` on the VPS; use the full path or `passdown-proxy`'s local binary: `/home/DHT/passdown-proxy/node_modules/.bin/pm2`.

## License

Internal/proprietary — Desert Hot Tubs.
