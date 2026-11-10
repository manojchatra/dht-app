# Desert Hot Tubs — Sales & Delivery Portal: Full Project Summary

*Last updated: 2026-09-28 (covers `main` + the `v13-workflow` branch).*

---

## Project Overview

Full-stack internal web application for Desert Hot Tubs (DHT), a multi-location spa retailer in the Phoenix metro area. Hosted at `app.deserthottubsaz.com` on a Contabo VPS. Manages sales contracts, customer records, inventory and warehouse receiving, delivery scheduling, payment tracking, delivery acknowledgements, and post-delivery follow-up across five showrooms (regions): Phoenix, Goodyear, Chandler, Surprise, and Tolleson.

**Stack:** Node.js/Express, SQLite (better-sqlite3), PM2, nginx, Google Sheets API, Google Calendar API, nodemailer (Brevo SMTP), pdfmake, multer, sharp, FullCalendar.js, BarcodeDetector API (+ ZXing WASM polyfill), Jest/Supertest

---

## Infrastructure

```
Contabo VPS (Ubuntu 24) — IP: 164.68.120.23
├── nginx (SSL termination, proxy for /delivery/, /acknowledgement)
├── PM2 (root user)  — dht-app (port 3001, cluster mode, 1 instance)
├── PM2 (DHT user)   — passdown-proxy (port 3000) — separate PM2, not in root's `pm2 list`
├── Exim4 (port 25 — local relay fallback)
├── /home/DHT/dht-app/
│   ├── routes/         contracts, customers, payments, auth, users, sales,
│   │                   delivery, post-delivery, warehouse, inventory,
│   │                   inventory-items, settings-api, notifications
│   ├── services/       driveInventory.js (all Google Sheets I/O),
│   │                   googleCalendar.js, customers.js
│   ├── utils/          pdfGenerator.js, acknowledgementPDF.js,
│   │                   receiptGenerator.js, emailSender.js, reviewEmail.js,
│   │                   imageUtils.js, activityLogger.js
│   ├── middleware/auth.js
│   ├── db/database.js  schema + additive migrations (run on every start)
│   ├── scripts/        one-off/maintenance scripts (see Scripts below)
│   ├── tests/          Jest + Supertest suites
│   ├── public/ → symlinked to public_html/ (see gotcha below)
│   └── uploads/        contracts/<contract#>/, inventory/<serial>/, warehouse-tmp/
├── /home/DHT/data/dht-app.db
├── /home/DHT/data/activity.log      ← append-only text audit trail
├── /home/DHT/backups/db/            ← SQLite backups (backup-db.js): 14 nightly + 10 manual
└── /home/DHT/web/.../public_html/   ← Static HTML pages + css/img/js/partials/
```

**nginx.ssl.conf_proxy includes:**
- `location = /acknowledgement` → proxied to Node (hub page)
- `location ~ ^/(delivery|acknowledgement)/[0-9]+$` → proxied to Node
- `location /` → catch-all proxy to Node (all other routes, incl. `/auth/login`, API)
- **No** `location /uploads/` block: uploads are served by Node, which checks the login and who may see each contract's files (`middleware/contractFiles.js`). The old nginx alias served them to anyone without a login — removed Oct 2026.
- Every proxied block sets `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` — required for the login rate-limiter (real client IP) and secure session cookies (real protocol); see Key Technical Learnings.

**Deploying:** pages are edited in the repo's `public/` and uploaded to `public_html/` — no restart needed. Anything under `routes/`, `services/`, `utils/`, `db/`, `server.js` needs `pm2 restart dht-app` as root. Logins are kept in the database (`sessions` table, utils/sqliteSessionStore.js), so a restart no longer logs anyone out; a login lasts 6 hours. The user is re-read on every request: deactivating or deleting an account logs it out at once, role/team changes apply on the next click.

**Two PM2s on the server:** each Linux user has its own PM2, and `pm2 list` only shows the current user's apps.

| App | Manage with | Notes |
|---|---|---|
| dht-app | `pm2 list` / `pm2 restart dht-app` (as root) | Global PM2 (7.0.3) is on root's `$PATH` |
| passdown-proxy | `sudo -u DHT pm2 list` / `sudo -u DHT pm2 restart <name>` | DHT user's PM2 (7.0.1). A version-mismatch warning is harmless; `pm2 update` for this user restarts Passdown. |

After `pm2 update` or any change to the app list, run `pm2 save` for that user so apps come back after a reboot. In `ss -ltnp`, both ports show as owned by `PM2 … God` (cluster mode) — not by `node`.

---

## Environment Variables (.env)

```
PORT=3001
NODE_ENV=production
SESSION_SECRET=...            # mandatory — server refuses to start without it
GOOGLE_CLIENT_EMAIL=...       # service account used for Sheets + Calendar
GOOGLE_PRIVATE_KEY=...
INVENTORY_FILE_ID=...         # the Google Sheet all tabs below live in
GOOGLE_CALENDAR_ID=...@group.calendar.google.com
GOOGLE_PLACES_KEY=...         # address suggestions; Places API (New) only, restricted to the server's IPv4 + IPv6. Empty = no suggestions
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<brevo-login-email>
SMTP_PASS=<brevo-smtp-key>
SMTP_FROM=deliveries@deserthottubsaz.com
# Optional overrides (used by tests/scripts): DB_PATH, UPLOADS_DIR, ACTIVITY_LOG_PATH, DB_BACKUP_DIR
```

⚠️ `.env.example` still lists `GOOGLE_KEY_FILE` — the code no longer reads it; Google auth uses `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`.

**SMTP notes:**
- Brevo used for email. `SMTP_FROM` must be set separately — Brevo SMTP username is an API key, not From address.
- Domain `deserthottubsaz.com` verified in Brevo with DKIM + DMARC. SPF includes VPS IP.
- Contabo blocks outbound ports 465/587 to external SMTP. Brevo at `smtp-relay.brevo.com:587` works because Brevo is whitelisted.
- `.env` passwords with `$$` must use single-quote wrapping: `SMTP_PASS='value$$'`

---

## User Roles

| Role | Access |
|---|---|
| admin | Everything — contracts, status board, customers, inventory, warehouse, sales, calendar, acknowledgement hub, post-delivery admin, settings, notifications |
| sales | Own contracts only (list, detail, dashboard counts, post-delivery follow-up are all scoped by `salesman_user_id`). Can create contracts, schedule, record payments. Salesman is always themself. View-only Inventory (`/inventory`, no Add): every spa, customer name and contract number shown, but linked only on their own contracts; Finance hidden (left out by `GET /api/inventory-items`, the only inventory-items route sales may use). |
| warehouse | `/warehouse` receiving dashboard + Inventory pages (+ Settings for own password). Sees no pricing — the contracts API (`/api/contracts`) and spa search (`/api/inventory`) are admin + sales only. |
| delivery | Calendar (`/api/delivery/calendar`: own team + unassigned, no prices) + `/delivery/:id` + `/acknowledgement` hub/form (+ Settings for own password). Scoped to own team. |

Delivery users have a `team` field: `team_a` (JV Spa Movers) or `team_b` (Clear Choice Movers). Multiple logins per team allowed.

Users have `name`, `email`, `active`. Sales users are created from the **Sales** section; admin/warehouse/delivery from **Settings → User Management**. Any role can change their own password in Settings. Sidebar items a role can't reach are hidden (`warehouse-hide`, `delivery-hide`, `admin-only` classes). **Deleting** a user (Settings, or Delete on a salesperson's page): one with contracts is asked to confirm first — the contracts are kept, still showing their name as salesperson, but are unlinked from the login (`salesman_user_id` cleared), so emails and follow-ups for them go to the office only.

---

## Contract Workflow

```
In Stock  → Assigned ────────────────→ Scheduled → Delivered  (terminal)
Ordered   → To Be Ordered → Order Placed → Received → Scheduled → Delivered
Any (not Delivered) → Cancelled → Assigned  (revert — In Stock contracts only, for now)
```

**Gates:**
- **Order Placed** — only from TBO; requires Web Order # and Truck #.
- **Received** — only from Order Placed (a TBO contract always goes through Order Placed); admin on the status board or warehouse. Serial number + serial photo (warehouse flow also requires a SKU photo). In-Stock contracts skip Received.
- **Scheduled** — only from Assigned, Received, or Scheduled (reschedule); serial number required, balance must be $0, date/time required; one booking per team per overlapping slot. **Slots are 1 hour** (Nov 2026): Schedule / Reschedule offer a start every hour from 6:00 AM to 5:00 PM and 1, 2, 3 or 4 hours (2 by default); the portal calendar's week/day views show 1-hour rows. Older 2- and 4-hour bookings keep their times, and the overlap check (in minutes) still counts them.
- **Cancel** — admin: status dropdown on Assigned / Scheduled, ⋮ menu on TBO / Order Placed / Received (Order Placed warns that the factory order isn't cancelled). A cancelled TBO contract can't be reverted yet (restore-to-previous-status is on hold).
- **Delivered** — serial required; **balance must be $0** (status dropdown and the Received card's Deliver button — "DHT… still owes $X — record the payment before marking it Delivered.", checked on the page and by the server); terminal (no further changes). The crew's **acknowledgement is never blocked** by a balance (the spa is already there — e.g. an edit after scheduling raised the total): the office gets a red `DELIVERED_OWING` notification "DHT… delivered with $X still owed", also in the activity log.
- Past delivery date on a new contract → contract saved straight to Delivered (historical entry, `back_entered=1`), with a warning if a balance is owed. No signature needed, no dashboard notification, no To Be Ordered email, not in the dashboard's Recent Contracts; a typed serial is linked (or added to Inventory as Sold); payments on the form are dated with the sale date (a current contract's with the day it's saved). With the acknowledgement case and a bounced cheque voided after delivery, these are the only ways a Delivered contract owes money.
- **Only these moves** (`STATUS_MOVES` in `routes/contracts.js`): Assigned → Scheduled / Delivered / Cancelled; TBO → Order Placed / Cancelled; Order Placed → Received / Cancelled; Received → Scheduled / Delivered / Cancelled; Scheduled → Scheduled (reschedule) / Delivered / Cancelled; Cancelled → Assigned (In Stock only). **Scheduled → Assigned is refused** (it left the calendar event live) — unschedule is #11, on hold; the Scheduled card's dropdown has no Assigned.
- **Mark Received** (admin `POST /:id/received`, warehouse `POST /api/warehouse/:id/receive`) runs under the contract lock (a double-tap's second request gets "already received"). The serial is checked with `receiveSerialConflict` (refused if sold to another contract, or not In-stock / Ordered) and the spa linked with `linkReceivedUnit` (`services/orderedStock.js`): reserved on-order unit, else the inventory spa with that serial, else a new Sold unit — both routes. Whatever the serial box held before (a salesperson's remark on a TBO sale) is kept in the MARK_RECEIVED log as "Serial was: …".
- **New Contract's Grand Total** is worked out again by the server (`utils/contractTotals.js`); more than 1¢ off the page's → refused "The totals don't add up — refresh the page and try again."

**Editing a contract** — **Edit contract** on the contract page (or **Edit** in the card ⋮ menu on Status and View Contracts — not on Delivered / Cancelled cards) opens `/contracts/:id/edit`: New Contract's own form (`create-contract.html`) in edit mode (`js/contract-edit.js`), filled in from the contract. Saved with `POST /api/contracts/:id/edit` (`services/contractEdit.js`).
- Admin, or the contract's own salesperson. The handwritten contract stays the legal one — edits correct what was typed in; no re-signing, no copy of the old PDF.
- **Editable until Delivered:** customer & delivery address, requested delivery date, Sold at, spa colours / speaker / year / series (make and model only if no spa is linked), warranty, electrical, notes, monthly cleanings, every line item (options, price, Included), services and fees, spa removal, fuel surcharge, discount, tax %. Images can be removed with × (not the signature, serial / SKU or delivery photos; the file is deleted) and **added** with the Add image slots (label required, up to 5, compressed like Add Image, saved into the contract folder with the rest of the edit).
- **Locked (greyed out):** contract number, store, sale date, salesperson, payments at signing (Record / Void on the contract page), signature. The server ignores these fields even if sent.
- **The spa — admin only** (`services/contractSpa.js`, Nov 2026; replaces Assign SI. No on the pages). A salesperson sees Inventory Search, the serial and In Stock / To Be Ordered locked (the server ignores them). For an admin they work as on New Contract and **the card moves with a switch**:
  - **Switching** only while Assigned, To Be Ordered or Order Placed. **In Stock → To Be Ordered**: the spa goes back to In-stock (also one added for a typed serial), the serial box is cleared (or back to the old remark), card → To Be Ordered, Sheet row → TBO tab. **To Be Ordered / Order Placed → In Stock**: the floor spa is linked and Sold (or added), card → Assigned, Sheet row → Assigned tab; a reserved on-order unit goes back to unreserved on-order stock; an Order Placed contract with only a typed Web Order # / Truck # leaves its factory spa as on-order stock (like cancelling); Web Order # / Truck # are cleared. Clicking In Stock opens Inventory Search.
  - **Received / Scheduled:** another spa of the same kind only (calendar event updated); no switching.
  - **Typed serial (checked when the box is left):** a free In-stock spa → "Spa found in inventory" (on a To Be Ordered contract: "Switch to In Stock?"); its own spa → nothing; sold elsewhere / not In-stock → refused. **Not in Inventory** on an In Stock or Scheduled contract → popup **Move to To Be Ordered** (switchable only) / **Re-enter** / **Add to Inventory** (added as Sold on save, Finance box shown). On To Be Ordered / Order Placed the box is a remark — saved as typed, no popup (refused only if it names a spa in Inventory). A Received contract's serial is just corrected.
  - **× on Inventory Search** (or clearing the serial) on an In Stock contract → **Move to To Be Ordered** / pick another spa. 
  - **On-order stock** (a spa on a truck, picked in Inventory Search) on a **To Be Ordered or Order Placed** contract → "Link on-order spa?" → reserved for the contract on save; the contract takes its Web Order # / Truck #, a To Be Ordered card moves to **Order Placed** (ORDER_PLACED notification + email, as Move to Order Placed), the Sheet row is rewritten on the Order Placed tab. Typed Web Order # / Truck # are replaced (no extra on-order unit — the picked spa is that order); a spa it had reserved goes back to unreserved on-order stock. Refused on In Stock / Received / Scheduled. (Fix for DHT2611GY00087, 2026-11-06.)
  - The server checks it all again; a spa to link that the page didn't confirm comes back as "Link to inventory?" first. Make / model are locked while a spa is linked.
  - In Stock → To Be Ordered on an Assigned contract with a deposit is allowed (the money stays on the contract). Prices don't follow the spa — change the spa price on the same page.
- **After Delivered / Cancelled:** only phones, email and gate details.
- Totals are recalculated by the server (`utils/contractTotals.js`, same as New Contract) **only when a price, line item, fee, discount or tax % changed** — a contact or colour fix leaves the saved totals alone. The page's Grand Total must match the server's (else "The totals don't add up"). Refused if the new total is below what's been paid (void the extra payment and re-record; refund outside the portal). A Scheduled contract that now owes money is flagged but keeps its booking. Receipts rebuild with the corrected totals.
- Name, phones and email also update the shared customer record; the delivery address is this contract's only.
- A reason is required; each save is one `CONTRACT_EDITED` log entry listing the spa change (switch with card move, serial old → new, spa linked / added, details, spas returned, on-order stock kept, order numbers cleared), every field old → new, removed and added images and the reason. The Sheet row (by header names), Customer Record rows, calendar event and contract PDF follow.
- Amounts with a comma in the wrong place (`20,0300`) are refused on New Contract, Record Payment and the edit page (`utils/money.js`).

**Cancel vs Delete:**
- **Cancel** — a real customer backed out. Contract, payments, PDFs and history are kept (the contract terms charge for cancellations after the deposit becomes non-refundable) — **keep a forfeited deposit's contract Cancelled rather than deleting it**, or its payment record is lost. No payments can be recorded on a cancelled contract (money kept or refunded is handled outside the portal); its card shows "Cancelled" instead of "Due", and Record Payment is hidden. Any linked spa goes back to **In-stock**. Reverting re-claims the spa only if it hasn't been sold meanwhile (logged either way).
- **Order Placed spa** — cancelling or deleting an Order Placed contract never loses the spa on the truck: reserved on-order stock goes back to unreserved `Ordered`; a contract with only a typed Web Order # / Truck # gets an unreserved `Ordered` unit added (make, series, model, colours, speaker, year, Web Order #, Truck #, plus an Inventory Items Sheet row) — `keepOrderedSpa` in `services/orderedStock.js`. The warehouse receives it as general stock (no customer name). Logged as "Returned to stock: on-order stock (Web Order # …)".
- **Delete** (admin only) — mistakes and test entries. Permanently removes the contract, its payments, activity, notifications, uploads folder (and its card thumbnails), Sheet rows and calendar event. An undelivered linked spa goes back to In-stock (a delivered one stays Sold, unlinked). The spa's inventory unit is never deleted — even one the contract or the stock import created; a mistyped serial is removed by hand from Inventory. If that was the customer's last contract, the customer is deleted too.

---

## Contract Numbers

Format: `DHT{YY}{MM}{STORE}{SEQ:05d}` e.g. `DHT2607PH00001`

Year/month from form date field. Global counter in `settings.contract_sequence`. Store codes: PH, GY, CH, SU, TO.

---

## Customers

The **customer record is the source of truth** for a customer's name, phone and email. Each contract also keeps a snapshot of the customer details *as signed* (in `contracts.data`) — used for the contract PDF and the contract detail page — plus its **own delivery address**, so one customer can own spas at two addresses.

| Shown where | Name / phone / email from | Address from |
|---|---|---|
| Lists, status board, warehouse, delivery, post-delivery, Customer Record tab | Customer record | Contract (delivery address) |
| Contract PDF, contract detail page | Contract snapshot (as signed) | Contract snapshot |

- **Customer ID:** `DHT-C00001`, from `settings.customer_sequence`. Never reused, even after a customer is deleted. Shown on the contract detail page.
- **Phone numbers:** always 10 digits, stored and shown as `602-112-2111`. The form auto-inserts dashes while typing and cleans pasted numbers (`(602) 112 2111`, `+1 602…`). At least one of Cell / Home / Work is required. Validated again server-side.
- **Linking a contract to an existing customer:** only via the **"Existing customer?" popup** on New Contract — never guessed. The popup searches once a full phone number or email is entered (never by name alone; the name only confirms a phone/email match), shows up to 5 matches, and runs again on Preview & Save as a safety net.
  - *Use this customer* → contract links to that record; phone/email/address on the record update to the new contract's, **the name is never overwritten**, old values go to the activity log (`CUSTOMER_LINKED`).
  - *No, this is a new customer* → new customer record with a new ID.
  - *Unlink* (banner) only undoes the link; Preview & Save asks again, so a duplicate customer is only ever created deliberately.
- **Continue Editing** on the preview opens `/contracts/new?resume=1`, which fills the form again from the draft in sessionStorage (`contractForm.fill` in `js/contract-edit.js`, shared with the Edit page): fields, spa pick, linked customer, signature. Photos uploaded for the preview are listed as attached and reused unless removed (×) or replaced.
- **Address suggestions (New Contract + Edit):** typing 3+ characters in Address lists up to 5 addresses from Google (US, Arizona first) with the required "Google Maps" label; a pick fills Address, City, State and Zip. `routes/address.js` asks Google so the key stays in `.env`; logged-in users only, 60 lookups a minute each. No key, or Google down: no list, and the address is typed by hand. Not filtered by place type (Google checks only a place's primary type, which could hide real homes), so a business can appear.
- **No Customers page yet.** `GET /api/customers/:id` (customer + all contracts, admin) exists so a future Customers tab or the service app is a page-only job. `GET /api/customers/search` backs the popup (admin + sales).
- **History:** before this change, contract save matched customers by email (or name + zip) and overwrote the record — different people sharing an email were merged into one customer. `scripts/migrate-customers.js` splits those apart (see Scripts).

---

## Inventory & Warehouse

**DB-backed inventory** (`inventory` table, `routes/inventory-items.js`, pages `/inventory` and `/inventory/add`).

- **Availability:** `In-stock`, `Ordered` (on order, no serial yet — has Web Order # / Truck #), `Hold`, `Sold`.
- **Adding an On Order spa that's already on a contract:** if its Web Order #, make and model match an Order Placed contract with no spa reserved yet, Add Inventory asks "Reserve for DHT…" (added reserved for that customer; the contract takes its Truck # and its Order Placed Sheet row is rewritten; logged on the contract) or "Add as general stock" (as before). Without this the spa was listed twice — the contract plus "free" on-order stock someone else could sell.
- **Locations:** Warehouse, Back Room (formerly "EMP Room" — imports still accept "EMP"), Phoenix / Goodyear / Chandler / Surprise / Tolleson Floor, Costco, Walmart (booth displays).
- **Colours** (`utils/colours.js`): the **SKU List** tab is the standard. New Contract's shell / cabinet buttons are that brand's SKU List colours (live, via `/api/inventory/colours`) plus extras for brands/colours the SKU List lacks (WLA, LifeSmart, HotSpring Driftwood/Gray/Mocha/Ash), with "Others" always available. Known variants are saved in SKU List spelling (Tuscan Sun → Tuscan, Nickel → Brushed Nickel, HotSpring Diamond → Diamond Weave, Caldera Taupe → Natural Taupe …). `scripts/normalize-colours.js` fixes existing inventory.
- **Sold at** (`utils/saleChannel.js`): New Contract records Showroom (default) / Costco / Walmart / Other event + optional booth location, in `data.saleChannel`. The store still sets the contract number, tax, PDF header and review link (pick the delivering showroom for a booth sale). Shown on the contract card/detail/PDF, an "All channels" filter, staff emails and a "Sold At" column appended to the contract Sheet tabs. City and Zip are required.
- **Add to Inventory:** *In Hand* (scan SKU + serial) or *On Order* (Web Order # + Truck #). SKU scan looks the product up in the **SKU List** Sheet tab (tolerates formatting differences, a trailing `.NN` suffix, and suggests a close match for 1–2 character typos) and auto-fills Make/Series/Model/Colors/Speaker.
- **Barcode scanning** (`public/js/barcode-scanner.js`): Code 128 only, native `BarcodeDetector` where available (Android Chrome), self-hosted ZXing WASM polyfill elsewhere (iOS Safari). Strips the GS1 `]C1` prefix.
- **Take Photo fallback:** every Scan button has a **Take Photo** button beside it (phone camera) for labels that won't scan — staff type the serial/SKU by hand and attach the photo.
- **Picking a spa on a contract:** New Contract's inventory search offers `In-stock` units (picking one marks it **Sold** and links it to the contract) and, listed after them, unreserved **on-order stock** (`Ordered`, "On order · Truck … · WO …"; hidden when a store filter is set).
- **Selling on-order stock** (`services/orderedStock.js`): picking an on-order unit sets the contract to To Be Ordered on the paperwork, but it is saved straight to **Order Placed** with that unit's Web Order # / Truck #, and the unit is **reserved** (`availability='Ordered'` + `contract_id`). Admin gets "New Contract (Already On Order)" instead of the To Be Ordered email, so the spa isn't ordered twice. A reserved unit shows "Ordered · Reserved DHT…" on the Inventory page and can't be received or re-labelled there. Receiving the contract (Warehouse or admin Mark Received) writes the serial onto that same unit (Sold) — no second unit. Cancel/delete before receipt returns it to unreserved `Ordered`.
- **New Contract's Inventory Search** has an **×** once a spa is picked: it clears the pick and everything it filled in (serial, make, series, model, year, colours, speaker tick, on-order note, Finance) — the serial too, since the server links the spa by serial. In Stock / To Be Ordered stays. On the Edit page (admin) it also offers Move to To Be Ordered on an In Stock contract.
- **Assign SI. No** — **taken off every page on 2026-11-05** (the spa is changed on Edit contract, above). The API `PATCH /api/contracts/:id/serial` is kept (admin, under the contract lock; refused on Delivered and Cancelled):
  - Sold to another contract, or in inventory but not In-stock → refused.
  - A free In-stock spa → popup "Link to inventory?" listing the contract details that will change (old → new) and the spa going back to stock. On Proceed the spa is Sold and linked, and the contract takes its make, series, model, year, shell and cabinet colours (a blank inventory field keeps the contract's value; prices and the speaker tick are not touched). Use this for a colour or model swap; the Sheet row is rewritten in full.
  - Not in inventory → Assigned / Scheduled: a Sold unit is added (like New Contract; Finance set later in Inventory). To Be Ordered / Order Placed: serial only (salespeople type remarks there).
  - Whatever spa the contract had goes back to stock (a unit added for a typed serial is removed instead). Logged as `SERIAL_ASSIGNED` with the old serial, details changed and spa returned.
- **Admin: Move to Order Placed** lists unreserved on-order units of the contract's make/model; admin can link one instead of entering a new Web Order # / Truck #.
- Inventory editing is admin-only; the Finance field on a unit drives the finance indicator icon on contract cards/detail.

**Warehouse dashboard** (`/warehouse`, `routes/warehouse.js`): one queue of everything awaiting receipt — Order-Placed contracts (no pricing shown) plus unreserved Ordered general stock (reserved stock appears once, as its contract) — searchable by Web Order # / Truck #.
- Receiving a **customer contract** requires serial number + serial photo + SKU photo; creates/links the inventory row (Sold), moves the contract to Received.
- Receiving **general stock** requires the serial; photo optional; unit becomes In-stock.

---

## Payments

- Payments recorded from View Contracts or contract detail; method cash / cheque / credit card / finance. Cheque payments can attach a **cheque photo**.
- Payment method details required when selected (cheque #, card last 4, finance lender) — client and server.
- Grand Total must be > $0 (server-validated). Amount can't exceed the remaining balance. Refused on a **cancelled** contract.
- **Record Payment** (card ⋮ menu and contract page) shows only while money is owed — hidden on fully paid and cancelled contracts.
- Each payment generates a PDF receipt and updates Paid/Pending in whichever Sheet tab the contract's row is in.
- **Void** (admin, reason required) — for a wrong amount, a duplicate, the wrong contract, or a bounced cheque / reversed card. The payment stays in Payment History crossed out with the reason, but no longer counts toward Total Paid, the balance, the scheduling check or the Sheet. Its receipt is regenerated stamped VOID. To correct an amount: void it, then record the right one. Logged as `PAYMENT_VOIDED`.
- Default dates (payments, Mark Delivered, received date, date pickers, New Contract sale date) are today in **Arizona** time.

---

## Contracts List (`/contracts`)

Card grid with search (customer, serial, make, contract #, salesman) and filters: **Region** (store), Status, Payment, **Year**, **Brand**, **Salesman** (hidden for sales users), **Contract date From / To**. Sorted by contract date, newest first (same date: newest entered first), so a back-dated contract sits at its own date. Year/Brand/Salesman options are built from the data. Filters are mirrored into the URL (bookmarkable, survive refresh and payment/image reloads); stat cards count the filtered set; "Clear filters" appears when any filter is set. Cancelled contracts never count as Payment Pending.

**Long lists — 50 at a time** (View Contracts, Inventory, every Status tab): the first 50, then "Show 50 more" / "Show all" under the list (`listFooter` in `public/js/util.js`). Search, filters and counts still cover the whole list; a new search or filter starts again at 50, a reload after a payment / image / delete keeps what was shown. The whole list still loads in one request — fine into the thousands.

**Status cards without a serial:** Assigned / Received / Scheduled show a red "No serial number" (only contracts from before the 28 Oct 2026 In Stock rule can reach it — fix on Edit contract); To Be Ordered / Order Placed show a grey "Serial at receiving" (normal until the spa arrives).

**Status page filters:** a **date range** (From / To, each optional, inclusive) next to the search — the date follows the tab: Scheduled = delivery slot date, Delivered = delivered date, every other tab = sale date (the label beside the dates says which). It combines with the search, including the per-tab match counts and "Found in…" links. **Clear filters** (shown while a filter is set) empties the search and both dates.

**Acknowledgement page filters** (`acknowledgement-hub.html`, every role that opens it — delivery users see only their team's deliveries): one bar above the Scheduled and Completed tabs — search (name, contract #, serial, address, store), From / To dates (the delivery slot date on Scheduled, the delivered date on Completed), per-tab match counts, "Found in …" links and **Clear filters**. Generate Acknowledgement Form still lists every scheduled delivery.

**Scheduled status card (admin):** **Reschedule** is a button on the card (beside the status dropdown), no longer in the ⋮ menu.

**Status page search:** one box above the cards filters the open tab by name, contract #, serial, spa, salesman, phone, store, Web Order # or Truck #; while searching, each tab shows its match count, and an empty tab offers "Found in Scheduled (2)…" links. The Delivered tab is sorted by contract date, newest first (like View Contracts); the other tabs list newest entered first.

**Card photos are thumbnails:** `/uploads/…jpg?thumb=1` answers with a 160 px copy (`middleware/thumbnails.js`, ~8 KB instead of ~400 KB), made on first request and kept in `uploads/.thumbs/` (rebuilt when the photo changes; never served directly; skipped by the backup). Card and inventory photos load lazily (only when scrolled into view); clicking still opens the full photo.

---

## File Storage — Per-Contract Folders

```
/uploads/contracts/DHT2607PH00001/
    contract.jpg / contract.pdf        ← handwritten contract
    cheque.jpg
    serial-photo.jpg                   ← required at Received
    delivery-photo-1.jpg ... -10.jpg   ← delivery evidence photos
    extra-1-Label.jpg                  ← supporting docs (images or PDFs)
    exception-1.jpg                    ← exception photos from ack form
    sig-customer.png                   ← uncompressed signatures
    sig-team.png
    acknowledgement-YYYY-MM-DD.pdf     ← generated on delivery
    contract.pdf                       ← cached on first download
    receipt-{id}.pdf
/uploads/inventory/<serial>/           ← serial-photo.jpg, sku-photo.jpg
```

**Image compression:** `utils/imageUtils.js` — sharp, 2000px, JPEG q80, auto-rotate. Applied to every uploaded image (contract, cheque, extra images, serial/SKU photos, delivery and exception photos); PDFs are accepted for supporting docs.

---

## Google Sheets & Calendar

All tabs live in the one spreadsheet `INVENTORY_FILE_ID`. The Sheet is a **mirror** — the app's database is the real record; editing the Sheet never changes the app.

| Tab | Written by the app | Row key |
|---|---|---|
| Assigned, TBO, Order Placed, Received, Delivered, Cancelled | Each contract is **one row that moves** to the tab matching its status | Contract ID (col A) |
| **Customer Record** | One row per contract that **never moves**; updated in place on every status/serial/delivery change. Columns: Customer ID, Contract Number, Name, Phone (Cell → Home → Work), Address, City, Brand, Model, Serial Number, Delivery Date (only once delivered), Salesman, Status, Contract Date, Series. Written by column position, so new columns go at the end and columns must not be moved by hand | Contract Number (col B) |
| Inventory Items | One row per unit; Availability kept in sync | Serial Number (col A) |
| SKU List | Read-only (maintained by hand) — SKU lookup source | SKU |
| Inventory | Legacy read-only tab (old in-stock picker); a sold serial's row is removed | Serial Number |

Tabs are created automatically the first time they're needed. Sheet writes are always non-fatal (logged, never block the app).

**Manual edits to the Sheet:** rows are found by searching the key column every time, so sorting/filtering/deleting rows (right-click → Delete row) is safe. Don't clear a row's contents (leaves a gap new rows can land in), and never rename tabs, change the header row, insert/move columns (the app writes to fixed column positions), or edit the key column. A manually deleted contract row may reappear on the next status move (or not, depending on the move); a deleted Customer Record row is re-added on that contract's next change.

**Calendar:** Team colors — JV Spa Movers = Lavender (1), Clear Choice Movers = Banana (5). Events created/updated/deleted on schedule/reschedule/cancel/deliver/delete.

---

## Delivery Flow

1. Admin (or the contract's salesperson) schedules → assigns team + slot → Google Calendar event created
2. Delivery user: Calendar → click event → `/delivery/:id`
3. Admin/delivery: Acknowledgement hub → Scheduled tab → `+` → `/delivery/:id`
4. `/delivery/:id`: contract details (no pricing), address = the contract's delivery address. Admin sees full sidebar + "Back to Acknowledgement". Delivery sees no sidebar + "Back to Calendar".
5. "Start Delivery Acknowledgement" → `/acknowledgement/:id`
6. Form sections:
   - **Delivery Photos** — 1 required, up to 10. Slot grid with camera capture. Shrunk in the browser (2000px, JPEG 80%) before upload to stay under nginx's 20 MB request limit, compressed again on the server and saved as `delivery-photo-1..10.jpg`. A photo still over 2 MB is skipped, not recorded.
   - Items Delivered — 11 checkbox items; ticking "Other" shows a required text box, printed on the PDF as "Other: …"
   - Product Details — Steps Model, Cover Lifter
   - **Water Care Installed** — 7-item checkbox group (FreshWater Salt System, FreshWater IQ, Auto Dosing, Standard Water Care, Ozone, Frog System, Other + text box)
   - Water Care Parts — pre-ticked by contract water care type
   - Acknowledgements (optional)
   - Exceptions + photo
   - Customer + Team signatures (canvas, touch-enabled)
7. Submit: Save & Mark Delivered / Send Email & Mark Delivered (recipient picker: customer, salesperson, admin list — sends to exactly who's ticked)
8. On save: photos saved and compressed, PDF generated, contract marked delivered, calendar event deleted, Sheets updated, activity logged, notification created. The server also requires a delivery photo, and uses the contract as read under the lock (an edit saved meanwhile isn't written over).
9. **Who can email an acknowledgement:** the recipient list (`GET /api/delivery/email-recipients/:id`) — admin, or the delivery team the contract is scheduled for; resending later (`POST /api/delivery/send-ack/:id`, the contract page) — admin only.

---

## Acknowledgement Hub (`/acknowledgement`)

**Scheduled tab:** `+` button → `/delivery/:id`. "Generate Acknowledgement Form" modal lists all scheduled contracts. Delivery users see only their team's.

**Completed tab:** Delivered contracts with saved ack PDF. Eye → open PDF in browser. Search by name. Filter by delivery date (MST).

---

## Post-Delivery Follow-up (`/post-delivery`)

- **Sales** (own contracts) / admin: list of delivered contracts; a feedback form per contract — contacted?, Google review left?, 1–5 ratings (delivery, installation, explanation, confidence, overall), concerns.
- **Admin** (`/post-delivery/admin`): all delivered contracts with feedback status, view any feedback, mark completed manually.

---

## Email

Provider: `smtp-relay.brevo.com:587` (STARTTLS). From: `deliveries@deserthottubsaz.com`. 15s timeout. Email failure never blocks the action that triggered it.

| Email | To | When |
|---|---|---|
| Delivery acknowledgement (PDF attached) | Whoever is ticked in the recipient picker | Send Email & Mark Delivered |
| Contract created as TBO | Salesperson + admin list | New ordered contract |
| Order placed | Salesperson | TBO → Order Placed |
| Received | Salesperson + admin list | Marked received |
| Delivered | Salesperson | Marked delivered |
| Payment recorded (receipt + cheque photo attached) | Admin list | Payment recorded |
| Google review request | Customer | ~24h after delivery (`utils/reviewEmail.js` polls every 15 min, max 3 attempts). Link = the contract's store's review URL from Settings; blank URL = no email. Contracts auto-delivered at creation are never emailed. |

"Admin list" = **Settings → Email Recipients** (hand-curated, not every admin user).

---

## Activity Logging

**Storage:** SQLite `activity_log` table + `/home/DHT/data/activity.log` text file.

**Event types:** CONTRACT_CREATED, STATUS_CHANGED, SCHEDULED, ORDER_PLACED, MARK_RECEIVED, ACK_SUBMITTED, PAYMENT_RECORDED, FAILED_DELIVERY, CUSTOMER_LINKED, PAYMENT_VOIDED, DELIVERED_OWING, INVENTORY_RELEASED, INVENTORY_RECLAIM, PDF_SUBMITTED / PDF_ADMIN_COMPLETED (post-delivery feedback), and user management (USER_CREATED, USER_UPDATED, USER_DELETED, USER_ROLE_CHANGED, USER_PASSWORD_RESET, PASSWORD_CHANGED).

**Timestamps:** All in MST (`America/Phoenix` — no DST in Arizona).

**Contract detail timeline:** Admin only. Shows 5 most recent entries, "Show N more" expands. Loaded asynchronously — non-blocking.

---

## Dashboard & Notifications

- **Stats:** contract counts by status, by showroom, by salesman (showroom/salesman stats hidden for sales users, whose counts are their own).
- **Notifications (admin only):** Contract created, Order placed, Received, Scheduled, Delivered, Payment recorded (green); Not delivered (red — automated: scheduled + past datetime, one per missed slot). Not-delivered alerts are listed first, outside the 10 newest, until dismissed or the contract is delivered / rescheduled / cancelled.
- **Rolling window:** 10 most recent. **Dismiss** is permanent per notification (stored in DB).

---

## PDF Branding

All three PDFs (contract, acknowledgement, payment receipt) include the DHT logo in the header. Acknowledgement PDF uses PNG tick marks (`TICK_B64`) — same as contract PDF, since Roboto font doesn't include `✓` glyph.

---

## Timezone

All time displays use `America/Phoenix` (MST, no DST):
- `formatSlot()` on status board
- `fmtSlot()` on acknowledgement hub
- `deliveryView` slot display
- FullCalendar `timeZone: 'America/Phoenix'`
- Activity log timestamps stored as UTC, displayed converted to Arizona time (MST)
- Scheduled datetimes in DB are naive MST strings — always interpreted as Phoenix time

---

## Mobile Responsive

- **All pages:** `body{visibility:hidden}` — revealed after auth (eliminates content flash)
- **Hamburger:** `padding-top:56px` on main content on mobile (no overlap with heading); Sign Out reachable on mobile
- **Payment history:** Table on desktop, card layout on mobile (< 600px)
- **Settings cards:** Side-by-side on desktop, stacked on mobile (< 600px)
- **User management:** Table on desktop, cards on mobile
- **Acknowledgement form:** Mobile-first single column, full-width signature canvas, bottom sticky submit bar
- **Delivery photos grid:** 5-slot responsive grid

---

## Navigation (All Pages)

- **Shared sidebar:** `public/partials/sidebar.html` injected by `public/js/sidebar.js` (was duplicated across 14 pages). `sidebar.js` also runs the auth check every page needs, sets `window._userRole` / `_userId` / `_userTeam`, then calls the page's `window._onAuthReady`.
- **Menu:** Dashboard · Contracts (New / View) · Status (Assigned, TBO, Order Placed, Received, Scheduled, Delivered, Cancelled) · Warehouse · Inventory (Add / View) · Sales · Calendar · Acknowledgement · Post-Delivery Follow-up · Settings · Sign Out
- **Accordion:** only one group open at a time — opening one collapses the other (no sidebar scrollbar). The current page's group opens on load.
- **Logo** → `/dashboard` on every page.
- A network blip while checking auth retries instead of logging the user out.

---

## Shared Utilities & Services

| File | Purpose |
|---|---|
| `services/driveInventory.js` | Every Google Sheets read/write (contract tabs, Customer Record, Inventory Items, SKU List) |
| `services/customers.js` | Phone formatting/validation, customer numbers, popup matching, Customer Record sync, orphan-customer cleanup |
| `services/googleCalendar.js` | Delivery calendar events |
| `utils/imageUtils.js` | `compressImage()` + `compressAndGate()` — sharp compression shared by all routes |
| `utils/activityLogger.js` | `logActivity()` + `addNotification()` + `mstNow()` — SQLite `activity_log` + text file |
| `utils/emailSender.js` | Brevo SMTP, port-aware (no auth on port 25), `SMTP_FROM` support, notification templates + recipient resolution |
| `utils/reviewEmail.js` | Delayed Google-review email queue + poller |
| `public/js/util.js` | `escHtml()` — escape any user-entered string before `innerHTML` |
| `public/js/barcode-scanner.js` | Camera + decode-loop wrapper (see Inventory) |

---

## Scripts (`scripts/`)

| Script | Use |
|---|---|
| `backup-db.js` | Online SQLite backup to `backups/db/`. Nightly (from `nightly-backup.sh`) keeps the last 14; `--manual` (run automatically by every `--apply` script, and by hand before any migration) writes `dht-app-manual-*.db`, last 10 kept separately. |
| `migrate-customers.js` | One-time customer clean-up. No flag = report only. `--apply` splits wrongly merged customers, creates customers for contracts without one, formats phones, deletes customers with no contracts, numbers everyone. `--fix-phone DHT-C00006 cell 6021122111` fixes a reported number. `--sync-sheet` (re)writes every Customer Record row, about 2.5 seconds a row to stay inside Google's quota, and lists any it couldn't write; safe to repeat. It overwrites hand edits in those columns and re-adds rows deleted by hand. |
| `fix-contract-date.js` | Corrects a saved contract's sale date: `<contract#> --date 9-20-2026` reports, `--apply` backs up then saves. The number takes the new year/month and keeps its sequence (DHT2611PH00098 → DHT2609PH00098) — folder, photo paths, activity log and notifications follow; signing payments of a back-entered contract move to the new date; Sheet row (Contract ID / Contract Date) and Customer Record updated. Refuses future dates, a number already taken, and renumbering a contract with a calendar event. Logic in `services/contractDateFix.js`. |
| `import-existing-inventory.js` | One-time import of the physical-stock sheet into the DB (quota-aware). |
| `fix-stock-location.js` | One-off location correction for imported stock. |
| `list-test-data.js` / `cleanup-test-data.js` | Find / remove test users and contracts before handover. |
| `verify-payment-sync.js` | Compare DB payment totals with Paid/Pending in the Sheet. |

All scripts run on the server from the app directory (they use the same `db/database.js`).

---

## Tests

`npm test` — Jest + Supertest. `tests/helpers/app.js` boots a real `server.js` against a throwaway SQLite DB and uploads dir, with Google Sheets, Calendar and email **mocked** (never touches production). When adding a new `driveInventory` export that routes call, add it to that mock list.

Suites: contracts, contract status workflow, payments, notifications, cheque photo + review email, inventory release, customers (phones, IDs, linking, search, delete, Customer Record).

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
| _onAuthReady timing | All role-based UI and data loading must run inside `window._onAuthReady` callback (set by `sidebar.js` after auth) |
| goToDelivery scope | Function referenced in dynamically built innerHTML must be defined at script top-level |
| Customer name source | ~~`COALESCE(json_extract(c.data,'$.customer.name'), cu.name)`~~ superseded: name/phone/email now come from the customer record (`COALESCE(cu.name, json…)`), address from the contract snapshot. The snapshot stays the signed record for PDFs. |
| Never auto-match customers | Matching by email/name silently merged different people (shared family email) and overwrote names. Link only on explicit staff confirmation. |
| imageUtils shared module | `compressAndGate` must be in a shared util — not inline in contracts.js — so delivery.js can import it |
| Activity log await | Cannot use `await` in non-async function. Use `.then()` chain or make function async. |
| PM2 cluster | Run a single instance (`pm2 start -i 1`) — the in-process locks (utils/asyncLock.js, the Sheet queue) assume one process. Sessions are in SQLite, not MemoryStore. |
| nginx try_files | `/acknowledgement` (no ID) needs `location = /acknowledgement` exact match — otherwise nginx 404 before Node |
| formatSlot timezone | `toLocaleTimeString()` uses browser timezone without explicit `timeZone: 'America/Phoenix'` option |
| trust proxy + secure cookies | `cookie.secure:true` behind nginx requires `app.set('trust proxy', 1)` **and** nginx forwarding `X-Forwarded-Proto` on every proxied location block — otherwise `express-session` silently withholds `Set-Cookie` entirely (login returns 200, but no cookie is ever issued; every next request bounces to `/login`). Diagnose with `curl -i` on `/auth/login`, check for `set-cookie` in the raw response. |
| Hestia `conf_proxy` glob include | Hestia's include for a domain's conf dir appears to match any filename containing `conf_proxy`, not just the exact name — a `nginx.ssl.conf_proxy.bak` left alongside the real file gets included too, causing `duplicate location "/"`. Keep backups outside that directory. |
| Node's own static routes vs Hestia | `server.js` serves `/css`, `/img`, `/js`, `/partials` from `/home/DHT/dht-app/public/` — a different path than `public_html/`. Fixed with `ln -s public_html /home/DHT/dht-app/public`. Re-verify if a new top-level static folder is added. |
| Stored XSS via innerHTML | Any user-entered string concatenated into `innerHTML` without escaping is a stored-XSS path from a low-privilege role into a higher one. Use `escHtml()` from `public/js/util.js` — and make sure the page actually loads `util.js`. |
| Payment method fields must be conditionally required | Validate both client-side and server-side — server-side is the real guarantee. |
| Field name drift: `data` blob vs Sheets summary | The Sheets summary once read `details.waterCare.type` while the form sends `details.waterCareSystem` — silently blank column. Grep summary-building code against real form field names. |
| Sheets quotas | Bulk scripts must batch/throttle Sheets reads and writes — per-row calls hit the read and write quotas. |
| Sheets fixed column positions | Contract tabs are updated by column number (e.g. Paid = col 17 on Assigned). New columns must be appended at the end, never inserted. |
| Inventory must follow the contract | Anything that ends a sale before delivery (cancel, delete) must return the unit to In-stock — otherwise it silently vanishes from the in-stock picker. |
| Route order vs router-wide gates | `PATCH /users/me/password` must be registered before `router.use(requireAdmin)` or it's unreachable for non-admins. |
| `req.originalUrl` in mounted middleware | `req.path` has the mount prefix stripped; use `req.originalUrl` to detect `/api/` requests. |
| Barcode formats | GS1 Code 128 decodes with a `]C1` prefix and SKUs carry a `.NN` suffix — strip both before matching. |

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
| V13 | Security hardening: stored-XSS escaping, login rate-limiter on real client IP, secure session cookies + mandatory `SESSION_SECRET`, payment validation. Calendar day-view fixes, favicon, weekly DB backup script, Sales self-serve scheduling. |
| V14 (`v13-workflow` branch) | Shared sidebar; user Name/Email; **Order Placed** status; **DB-backed inventory** + SKU List lookup + Ordered stock; **Warehouse role** + receiving dashboard; finance indicator; **Sales section** with per-salesperson scoping; **Stage 7 email notifications**; **Post-Delivery Follow-up** scoped to salesperson; Jest/Supertest test suite; full contract-delete cleanup; WASM barcode scanning; cheque photos on payments; delayed **Google-review email**; contract list filters (Year/Brand/Salesman/Region, URL-saved); **Take Photo** fallback for unreadable barcodes; single-open sidebar accordion. |
| V15 (`v13-workflow` branch) | **Customer records:** `DHT-C` customer IDs, customer record as source of truth, per-contract delivery address, 10-digit `602-112-2111` phones, "Existing customer?" popup (phone/email), **Customer Record** Sheet tab, `migrate-customers.js`. **Stock fix:** cancel/delete returns the spa to In-stock. |

---

## On The Horizon

- **Customers tab + profile page** — the API (`GET /api/customers/:id`) is ready; page-only job.
- **Customer edit screen** (fix a phone/email without a new contract; merge duplicates).
- **Service app** (separate): appointment booking → technician visit → notes → invoice. Would read customers/spas from this app over an API (API-key auth, versioned endpoints) and link Passdown customers (IDs like `c-0001`) to `DHT-C` numbers via phone.
- Installed-spa records (serial, install address, delivery date, warranty) for the service side.
- Delay notification icon on overdue scheduled cards
- Zip-code colour coding on calendar (4 Arizona regions)
- Delivery user management: reassignment flow when crew changes
- Ghostscript for PDF compression: `apt-get install ghostscript -y`
- Settings page: Calendar ID + SMTP config fields (currently `.env` only)
- Clean up `.env.example` (`GOOGLE_KEY_FILE` → `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`)
