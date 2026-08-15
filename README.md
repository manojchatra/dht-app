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
│   └── js/util.js          Shared escHtml() — escape any user-entered string before innerHTML
├── ecosystem.config.js    PM2 process config
└── nginx.ssl.conf_proxy   nginx reverse-proxy snippet for the Node app
```

**Note on deployed pages:** in production, the HTML pages served by `server.js`'s page routes are read from `/home/DHT/web/app.deserthottubsaz.com/public_html/` on the VPS, not from this repo's local `public/` folder directly — keep both in sync when deploying.

**Static asset gotcha:** `server.js` also serves `/css`, `/img`, and `/js` via `express.static(path.join(__dirname, 'public/...'))` — i.e. from `/home/DHT/dht-app/public/`, a *different* location than `public_html/` above. On the VPS this folder didn't exist at all (css/img have historically worked because Hestia's nginx template serves them directly from `public_html/`, bypassing Node — but that rule doesn't know about new folders). Fix applied: `ln -s /home/DHT/web/app.deserthottubsaz.com/public_html /home/DHT/dht-app/public`, mirroring how local dev already works. If a *new* top-level static folder is ever added under `public/`, re-verify this symlink still covers it, or add nginx rules to match.

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

**`SESSION_SECRET` is mandatory** — `server.js` throws at startup and refuses to boot if it's missing (previously fell back to a hardcoded default silently; now fails fast instead). Always confirm it's set in `.env` before restarting on any environment.

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

**`X-Forwarded-Proto` is required for secure cookies.** `server.js` sets `app.set('trust proxy', 1)` and the session cookie is `secure: true` in production. `express-session` silently withholds `Set-Cookie` entirely (not even a non-secure one) if it doesn't believe the request came in over HTTPS — which it determines from `X-Forwarded-Proto`. Every `location` block in `nginx.ssl.conf_proxy` that proxies to Node must set `proxy_set_header X-Forwarded-Proto $scheme;` (along with `X-Real-IP` / `X-Forwarded-For`, needed for correct login rate-limiting). Missing this manifests as: login returns `200` with a valid session, but every subsequent request bounces back to `/login` — the cookie was simply never issued. Verify with `curl -i` on `/auth/login` and check for a `set-cookie` line in the raw response.

**Don't leave backup copies of `nginx.ssl.conf_proxy` in the same directory.** Hestia's include mechanism appears to pattern-match anything containing `conf_proxy` in `/home/DHT/conf/web/app.deserthottubsaz.com/`, not just the exact filename — a `nginx.ssl.conf_proxy.bak` sitting alongside the real file gets included too, causing `nginx: [emerg] duplicate location "/"`. Move backups outside that directory (e.g. `/root/`) instead.

## Known Limitations

- **Sessions are in-memory** (`express-session` `MemoryStore`) — any `pm2 restart` logs out all active users. A persistent (SQLite-backed) session store is planned; see "On The Horizon" in the project summary.
- PM2 is not on the default `$PATH` on the VPS; use the full path or `passdown-proxy`'s local binary: `/home/DHT/passdown-proxy/node_modules/.bin/pm2`.

## License

Internal/proprietary — Desert Hot Tubs.
