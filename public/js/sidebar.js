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

async function initSidebar() {
  const mount = document.getElementById('sidebar-root');

  // Both requests start immediately/concurrently — the auth check must not
  // wait on the partial fetch (it didn't, pre-refactor, when each page had
  // its own inline auth script), since pages defer their own data loading
  // to window._userRole/_onAuthReady being ready as soon as possible.
  const partialPromise = mount
    ? fetch('/partials/sidebar.html').then(r => r.text()).catch(e => { console.error('[sidebar] failed to load partial', e); return null; })
    : Promise.resolve(null);
  const authPromise = fetch('/auth/me').then(r => r.json()).catch(() => null);

  const [html, u] = await Promise.all([partialPromise, authPromise]);

  if (mount && html) mount.outerHTML = html;
  markSidebarActive();

  if (!u || !u.username) { window.location.href = '/login'; return; }

  const _un = document.getElementById('userName'); if (_un) _un.textContent = u.username;
  const _tNames = { team_a: 'JV Spa Movers', team_b: 'Clear Choice Movers' };
  const _ur = document.getElementById('userRole');
  const _roleLabels = { admin: 'Administrator', delivery: _tNames[u.team] || 'Delivery', warehouse: 'Warehouse', sales: 'Sales' };
  if (_ur) _ur.textContent = _roleLabels[u.role] || 'Sales';

  // Delivery role: restrict to delivery pages only
  if (u.role === 'delivery') {
    const _p = window.location.pathname;
    if (!_p.startsWith('/calendar') && !_p.startsWith('/delivery/') && !_p.startsWith('/acknowledgement/')) {
      window.location.href = '/calendar'; return;
    }
  }

  // Warehouse role: restrict to its own dashboard + Inventory pages
  if (u.role === 'warehouse') {
    const _p = window.location.pathname;
    if (!_p.startsWith('/warehouse') && !_p.startsWith('/inventory')) {
      window.location.href = '/warehouse'; return;
    }
  }

  // Set before _onAuthReady() — pages (e.g. delivery-view.html) read this
  // inside their own _onAuthReady to make role-specific UI decisions.
  window._userRole = u.role;
  window._userId = u.userId;

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
}

initSidebar();