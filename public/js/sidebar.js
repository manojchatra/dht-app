// sidebar.js — shared sidebar: injects the nav partial into #sidebar-root,
// highlights the current section, and runs the auth check every page needs
// (was previously duplicated inline across ~14 pages).

function toggleNav(id) {
  const sub = document.getElementById('sub-' + id);
  const btn = document.getElementById('nav-' + id);
  const isOpen = sub.classList.toggle('open');
  btn.classList.toggle('nav-open', isOpen);
}

function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('mobile-open');
  document.getElementById('sidebarOverlay').classList.add('mobile-open');
}
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarOverlay').classList.remove('mobile-open');
}

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// Highlights the current section's nav item (and opens its accordion, for
// Contracts/Status) based on the current URL. Path-prefix based, so it also
// covers sub-pages (e.g. /contracts/:id, /post-delivery/admin) automatically.
function markSidebarActive() {
  const p = window.location.pathname;

  function activateGroup(navId, subId) {
    const btn = document.getElementById(navId);
    const sub = document.getElementById(subId);
    if (btn) { btn.classList.add('active'); btn.classList.add('nav-open'); }
    if (sub) sub.classList.add('open');
  }
  function activateFlat(href) {
    const el = document.querySelector('.nav-item[href="' + href + '"]');
    if (el) el.classList.add('active');
  }
  function activateSub(href) {
    const el = document.querySelector('.nav-sub-item[href="' + href + '"]');
    if (el) el.classList.add('active');
  }

  if (p.startsWith('/contracts')) activateGroup('nav-contracts', 'sub-contracts');
  if (p.startsWith('/status'))    activateGroup('nav-status', 'sub-status');
  if (p.startsWith('/inventory')) activateGroup('nav-inventory', 'sub-inventory');
  if (p.startsWith('/warehouse')) activateFlat('/warehouse');
  if (p.startsWith('/sales'))     activateFlat('/sales');
  if (p === '/contracts/new') activateSub('/contracts/new');
  if (p === '/contracts')     activateSub('/contracts');
  if (p === '/inventory/add') activateSub('/inventory/add');
  if (p === '/inventory')     activateSub('/inventory');
  if (p.startsWith('/calendar'))  activateFlat('/calendar');
  // Delivery techs land on /delivery/:id from the Acknowledgement flow — keep it lit there too.
  if (p.startsWith('/acknowledgement') || p.startsWith('/delivery/')) activateFlat('/acknowledgement');
  if (p.startsWith('/post-delivery')) activateFlat('/post-delivery');
  if (p.startsWith('/settings'))  activateFlat('/settings');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// A network-level failure (fetch rejects — offline, DNS hiccup, the mobile
// device reconnecting right as it wakes from a screen lock, etc.) must never
// be treated the same as a real "not authenticated" response, or a session
// that's still perfectly valid gets thrown away on a transient blip. Retries
// a few times before giving up; only an actual response (even one saying
// "no user") is trusted to mean "not logged in".
async function fetchAuthMe(attempt = 0) {
  try {
    const r = await fetch('/auth/me');
    return await r.json();
  } catch (e) {
    if (attempt >= 3) return 'network-error';
    await sleep(500 * Math.pow(2, attempt)); // 500ms, 1s, 2s
    return fetchAuthMe(attempt + 1);
  }
}

async function initSidebar() {
  const mount = document.getElementById('sidebar-root');

  // Both requests start immediately/concurrently — the auth check must not
  // wait on the partial fetch (it didn't, pre-refactor, when each page had
  // its own inline auth script), since pages defer their own data loading
  // to window._userRole/_onAuthReady being ready as soon as possible.
  const partialPromise = mount
    ? fetch('/partials/sidebar.html', { cache: 'no-store' }).then(r => r.text()).catch(e => { console.error('[sidebar] failed to load partial', e); return null; })
    : Promise.resolve(null);
  const authPromise = fetchAuthMe();

  const [html, u] = await Promise.all([partialPromise, authPromise]);

  if (mount && html) mount.outerHTML = html;
  markSidebarActive();

  // Persistent network failure (not a real "you're not logged in" answer) —
  // don't redirect a genuinely-still-logged-in user off to /login over a
  // connectivity problem. Leave the page as-is; a manual refresh once the
  // connection is back will get a real answer.
  if (u === 'network-error') {
    console.error('[sidebar] could not reach /auth/me after retries — not redirecting, likely a connectivity issue');
    return;
  }

  if (!u || !u.username) { window.location.href = '/login'; return; }

  const _un = document.getElementById('userName'); if (_un) _un.textContent = u.username;
  const _tNames = { team_a: 'JV Spa Movers', team_b: 'Clear Choice Movers' };
  const _ur = document.getElementById('userRole');
  const _roleLabels = { admin: 'Administrator', delivery: _tNames[u.team] || 'Delivery', warehouse: 'Warehouse', sales: 'Sales' };
  if (_ur) _ur.textContent = _roleLabels[u.role] || 'Sales';

  // Delivery role: restrict to delivery pages only (+ /settings, so they can
  // change their own password — the page itself hides every admin-only card).
  // /acknowledgement (bare, the hub list) and /acknowledgement/:id (a specific
  // signing page) are both allowed — this used to only allow the trailing-
  // slash sub-path form, which silently blocked the hub itself.
  if (u.role === 'delivery') {
    const _p = window.location.pathname;
    if (!_p.startsWith('/calendar') && !_p.startsWith('/delivery/') && !_p.startsWith('/acknowledgement') && !_p.startsWith('/settings')) {
      window.location.href = '/calendar'; return;
    }
  }

  // Warehouse role: restrict to its own dashboard + Inventory pages (+
  // /settings, same reason as delivery above).
  if (u.role === 'warehouse') {
    const _p = window.location.pathname;
    if (!_p.startsWith('/warehouse') && !_p.startsWith('/inventory') && !_p.startsWith('/settings')) {
      window.location.href = '/warehouse'; return;
    }
  }

  // Set before _onAuthReady() — pages (e.g. delivery-view.html) read this
  // inside their own _onAuthReady to make role-specific UI decisions.
  // calendar.html specifically needs _userTeam to filter events down to a
  // delivery user's own team — without it every team-assigned contract was
  // silently invisible to every delivery user's calendar, always (not just
  // after a reschedule): the filter check (c.delivery_team === userTeam)
  // could never match a real team against an undefined _userTeam.
  window._userRole = u.role;
  window._userId = u.userId;
  window._userTeam = u.team;

  // Notify deferred loaders (e.g. calendar waits for auth)
  if (typeof window._onAuthReady === 'function') window._onAuthReady();
  if (u.role === 'admin' && typeof loadNotifications === 'function') { loadNotifications(); }

  const _sb = document.getElementById('sidebar'); if (_sb) _sb.style.visibility = 'visible';
  document.body.style.visibility = 'visible';
  const _ua = document.getElementById('userAvatar'); if (_ua) _ua.textContent = u.username[0].toUpperCase();
  if (u.role === 'admin') document.querySelectorAll('.admin-only').forEach(el => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') el.style.display = 'flex';
    else el.style.display = '';
  });
  if (u.role === 'admin' || u.role === 'warehouse') document.querySelectorAll('.admin-or-warehouse').forEach(el => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') el.style.display = 'flex';
    else el.style.display = '';
  });
  // Hide nav items these roles have no route access to — otherwise clicking
  // one navigates away, briefly renders the destination page, then this
  // same script's redirect block above (or the destination page's own auth
  // check) bounces them back, showing as a blank-flash-then-reload.
  if (u.role === 'warehouse') document.querySelectorAll('.warehouse-hide').forEach(el => { el.style.display = 'none'; });
  if (u.role === 'delivery')  document.querySelectorAll('.delivery-hide').forEach(el => { el.style.display = 'none'; });
}

initSidebar();