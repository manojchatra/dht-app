# Desert Hot Tubs — Sales & Delivery Portal: Full Project Summary
 
---
 
## Project Overview
 
Full-stack internal web application for Desert Hot Tubs (DHT), a multi-location spa retailer in the Phoenix metro area. Hosted at `app.deserthottubsaz.com` on a Contabo VPS. Manages sales contracts, customer records, delivery scheduling, payment tracking, and delivery acknowledgements across five showrooms: Phoenix, Goodyear, Chandler, Surprise, and Tolleson.
 
**Stack:** Node.js/Express, SQLite (better-sqlite3), PM2, nginx, Google Sheets API, Google Calendar API, nodemailer (Brevo SMTP), pdfmake, multer, FullCalendar.js, sharp
 
---
 
## Infrastructure
 
```
Contabo VPS (Ubuntu 24) — IP: 164.68.120.23
├── nginx (SSL termination, proxy for /delivery/, /acknowledgement)
├── PM2 — dht-app (port 3001), passdown-proxy (port 3000)
├── Exim4 (port 25 — local relay fallback)
├── /home/DHT/dht-app/
│   ├── routes/         contracts, payments, auth, users, delivery,
│   │                   settings-api, notifications
│   ├── services/       driveInventory.js, googleCalendar.js
│   ├── utils/          pdfGenerator.js, acknowledgementPDF.js,
│   │                   receiptGenerator.js, emailSender.js,
│   │                   imageUtils.js, activityLogger.js
│   ├── db/database.js
│   └── uploads/contracts/
├── /home/DHT/data/dht-app.db
├── /home/DHT/data/activity.log      ← append-only text audit trail
└── /home/DHT/web/.../public_html/   ← Static HTML pages
```
 
**nginx.ssl.conf_proxy includes:**
- `location = /acknowledgement` → proxied to Node (hub page)
- `location ~ ^/(delivery|acknowledgement)/[0-9]+$` → proxied to Node
---
 
## Environment Variables (.env)
 
```
GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY=...
INVENTORY_FILE_ID=...
GOOGLE_CALENDAR_ID=...@group.calendar.google.com
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<brevo-login-email>
SMTP_PASS=<brevo-smtp-key>
SMTP_FROM=deliveries@deserthottubsaz.com
SESSION_SECRET=...
```
 
**SMTP notes:**
- Brevo used for email. `SMTP_FROM` must be set separately — Brevo SMTP username is an API key, not From address.
- Domain `deserthottubsaz.com` verified in Brevo with DKIM + DMARC. SPF includes VPS IP.
- Contabo blocks outbound ports 465/587 to external SMTP. Brevo at `smtp-relay.brevo.com:587` works because Brevo is whitelisted.
- `.env` passwords with `$$` must use single-quote wrapping: `SMTP_PASS='value$$'`
---
 
## User Roles
 
| Role | Access |
|---|---|
| admin | Full app — contracts, status, calendar, acknowledgement hub, settings, notifications |
| sales | Contracts + Calendar |
| delivery | Calendar + `/delivery/:id` + `/acknowledgement/:id` only |
 
Delivery users have `team` field: `team_a` (JV Spa Movers) or `team_b` (Clear Choice Movers). Multiple logins per team allowed.
 
---
 
## Contract Workflow
 
```
In Stock  → Assigned  → Scheduled → Delivered  (terminal)
TBO       → Received  → Scheduled → Delivered  (terminal)
Any       → Cancelled → Assigned  (revert)
```
 
**Gates:** Serial number + photo → Received. Balance $0 → Scheduled. Past delivery date → warning.
 
---
 
## Contract Numbers
 
Format: `DHT{YY}{MM}{STORE}{SEQ:05d}` e.g. `DHT2607PH00001`
 
Year/month from form date field. Global counter in `settings` table. Store codes: PH, GY, CH, SU, TO.
 
---
 
## File Storage — Per-Contract Folders
 
```
/uploads/contracts/DHT2607PH00001/
    contract.jpg / contract.pdf        ← handwritten contract
    cheque.jpg
    serial-photo.jpg                   ← required at Received
    delivery-photo-1.jpg ... -5.jpg    ← delivery evidence photos
    extra-1-Label.jpg
    exception-1.jpg                    ← exception photos from ack form
    sig-customer.png                   ← uncompressed signatures
    sig-team.png
    acknowledgement-YYYY-MM-DD.pdf     ← generated on delivery
    contract.pdf                       ← cached on first download
    receipt-{id}.pdf
```
 
**Image compression:** `utils/imageUtils.js` — sharp, 2000px, JPEG q80, auto-rotate. Applied to: contract image, cheque, extra images, serial photo, delivery photos, exception photos.
 
---
 
## Google Sheets & Calendar
 
**Sheets tabs:** Assigned | TBO | Received | Delivered | Cancelled. Row finding by Contract ID (column A).
 
**Calendar:** Team colors — JV Spa Movers = Lavender (1), Clear Choice Movers = Banana (5). Events created/updated/deleted on schedule/reschedule/cancel/deliver.
 
---
 
## Delivery Flow
 
1. Admin schedules → assigns team + slot → Google Calendar event created
2. Delivery user: Calendar → click event → `/delivery/:id`
3. Admin: Acknowledgement hub → Scheduled tab → `+` → `/delivery/:id`
4. `/delivery/:id`: contract details (no pricing). Admin sees full sidebar + "Back to Acknowledgement". Delivery sees no sidebar + "Back to Calendar".
5. "Start Delivery Acknowledgement" → `/acknowledgement/:id`
6. Form sections:
   - **Delivery Photos** (NEW — first section) — 1 required, up to 5. Slot grid with camera capture. Compressed and saved as `delivery-photo-1..5.jpg`.
   - Items Delivered — 11 checkbox items
   - Product Details — Steps Model, Cover Lifter
   - **Water Care Installed** — 7-item checkbox group (FreshWater Salt System, FreshWater IQ, Auto Dosing, Standard Water Care, Ozone, Frog System, Other + text box)
   - Water Care Parts — pre-ticked by contract water care type
   - Acknowledgements (optional)
   - Exceptions + photo (exception photos now compressed)
   - Customer + Team signatures (canvas, touch-enabled)
7. Submit: Save & Mark Delivered / Send Email & Mark Delivered
8. On save: delivery photos + exception photos saved and compressed, PDF generated, contract marked delivered, calendar event deleted, activity logged, notification created.
---
 
## Acknowledgement Hub (`/acknowledgement`)
 
**Scheduled tab:** `+` button → `/delivery/:id`. "Generate Acknowledgement Form" modal lists all scheduled contracts.
 
**Completed tab:** Delivered contracts with saved ack PDF. Eye → open PDF in browser. Search by name. Filter by delivery date (MST).
 
---
 
## Activity Logging
 
**Storage:** SQLite `activity_log` table + `/home/DHT/data/activity.log` text file.
 
**Event types:** CONTRACT_CREATED, CONTRACT_UPDATED, CONTRACT_DELETED, STATUS_CHANGED, PAYMENT_RECORDED, SERIAL_ASSIGNED, SCHEDULED, ACK_SUBMITTED, EMAIL_SENT, MARK_RECEIVED, FAILED_DELIVERY.
 
**Timestamps:** All in MST (`America/Phoenix` — no DST in Arizona).
 
**Contract detail timeline:** Admin only. Shows 5 most recent entries, "Show N more" expands. Loaded asynchronously — non-blocking.
 
---
 
## Dashboard Notifications
 
- **Triggers:** Scheduled (green), Delivered (green), Received (green), Payment recorded (green), Failed delivery (red — automated: scheduled + past datetime)
- **Rolling window:** 10 most recent (oldest dropped at 11th)
- **Persistence:** Dismissed permanently per notification (stored in DB)
- **Failed delivery auto-detect:** Runs on every dashboard load — queries scheduled contracts with past `scheduled_datetime`, creates red notification if not already present
- **Admin only**
---
 
## PDF Branding
 
All three PDFs (contract, acknowledgement, payment receipt) now include the DHT logo in the header. Acknowledgement PDF uses PNG tick marks (`TICK_B64`) — same as contract PDF, since Roboto font doesn't include `✓` glyph.
 
---
 
## Email (Brevo SMTP)
 
Provider: `smtp-relay.brevo.com:587` (STARTTLS). From: `deliveries@deserthottubsaz.com` (set via `SMTP_FROM` — separate from `SMTP_USER` which is Brevo API key). Domain verified in Brevo with DKIM + DMARC. 15s timeout. Email failure never blocks Mark Delivered.
 
---
 
## Timezone
 
All time displays use `America/Phoenix` (MST, no DST):
- `formatSlot()` on status board
- `fmtSlot()` on acknowledgement hub
- `deliveryView` slot display
- FullCalendar `timeZone: 'America/Phoenix'`
- Activity log timestamps stored as UTC, displayed as MST
- Scheduled datetimes in DB are naive MST strings — always interpreted as Phoenix time
---
 
## Mobile Responsive
 
- **All pages:** `body{visibility:hidden}` — revealed after auth (eliminates content flash)
- **Hamburger:** `padding-top:56px` on main content on mobile (no overlap with heading)
- **Payment history:** Table on desktop, card layout on mobile (< 600px)
- **Settings cards:** Side-by-side on desktop, stacked on mobile (< 600px)
- **User management:** Table on desktop, cards on mobile
- **Acknowledgement form:** Mobile-first single column, full-width signature canvas, bottom sticky submit bar
- **Delivery photos grid:** 5-slot responsive grid
---
 
## Shared Utilities
 
| File | Purpose |
|---|---|
| `utils/imageUtils.js` | `compressImage()` + `compressAndGate()` — sharp compression shared by all routes |
| `utils/activityLogger.js` | `logActivity()` + `addNotification()` + `mstNow()` — used by contracts, delivery, payments |
| `utils/emailSender.js` | Brevo SMTP, port-aware (no auth on port 25), `SMTP_FROM` support |
| `utils/activityLogger.js` | Writes to SQLite `activity_log` + `/home/DHT/data/activity.log` text file |
 
---
 
## Navigation (All Pages)
 
- **Logo** → clickable link to `/dashboard` on every page
- **Acknowledgement** nav item → `/acknowledgement` hub (not status tab)
- **Received** in Status sub-nav on all pages
- **Sidebar** visibility:hidden until auth completes (no flicker)
---
 
## Key Technical Learnings (Cumulative)
 
| Learning | Detail |
|---|---|
| SMTP_FROM vs SMTP_USER | Brevo SMTP user is API key; `SMTP_FROM` env var needed for From address |
| dotenv `$$` | Wrap passwords with `$$` in single quotes in `.env`: `SMTP_PASS='pass$$'` |
| Brevo sender validation | From address must be verified sender in Brevo Senders & IP |
| pdfmake `✓` char | Roboto font has no tick glyph — use `TICK_B64` PNG image for checked, `canvas rect` for unchecked |
| pdfmake `_calcWidth` | Table rows must have exactly N cells matching N widths array entries |
| NAV_JS null elements | `getElementById('x').textContent` throws on pages without sidebar. Always null-guard. |
| FullCalendar url property | Wraps events in internal `<a>` — conflicts with eventClick. Remove `url`, use eventClick exclusively. |
| _onAuthReady timing | All role-based UI and data loading must run inside `window._onAuthReady` callback |
| NAV_JS snapshot embedding | Pages generated with embedded NAV_JS from early snapshot miss the `_onAuthReady` hook call — verify 2+ occurrences per page |
| goToDelivery scope | Function referenced in dynamically built innerHTML must be defined at script top-level |
| json_extract for names | `COALESCE(json_extract(c.data,'$.customer.name'), cu.name)` — each contract carries its own name |
| imageUtils shared module | `compressAndGate` must be in a shared util — not inline in contracts.js — so delivery.js can import it |
| Activity log await | Cannot use `await` in non-async function. Use `.then()` chain or make function async. |
| Received nav missing | Pages generated before Received was added to sub-status nav need explicit Received `<a>` item |
| PM2 cluster + MemoryStore | Sessions per-process. Run `pm2 start -i 1` (single instance) as workaround. |
| nginx try_files | `/acknowledgement` (no ID) needs `location = /acknowledgement` exact match — otherwise nginx 404 before Node |
| formatSlot timezone | `toLocaleTimeString()` uses browser timezone without explicit `timeZone: 'America/Phoenix'` option |
 
---
 
## Versions
 
| Version | Key Deliverables |
|---|---|
| V1–V2 | Foundation |
| V3 | Major rebuild |
| V4–V7 | PDF, rate limiter, storage, bug fixes |
| V8 | Bidirectional Google Sheets sync |
| V9 | Received status, slot scheduling, FullCalendar |
| V10 | Delivery role, acknowledgement form, Google Calendar, Brevo email |
| V11 | Bug fixes: goToDelivery, _onAuthReady, PNG ticks, customer name, SMTP_FROM, nav fixes |
| V12 | Delivery photos, compression everywhere, activity log, dashboard notifications, MST timezone, mobile responsive, logo branding all PDFs, water care checkboxes, body flash fix, Received nav all pages |
 
---
 
## On The Horizon
 
- Customer Tab: hub for delivered contracts, service history, checklists
- Post-Delivery Follow-up page
- SQLite-backed sessions (fix PM2 MemoryStore — currently single instance)
- Delay notification icon on overdue scheduled cards
- Zip-code colour coding on calendar (4 Arizona regions)
- Delivery user management: reassignment flow when crew changes
- Ghostscript for PDF compression: `apt-get install ghostscript -y`
- Settings page: Calendar ID + SMTP config fields (currently `.env` only)