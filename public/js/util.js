// util.js — shared front-end helpers
// escHtml: HTML-escape a value before interpolating it into innerHTML.
// Use for any user-entered string (names, notes, addresses, emails, etc.)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// soldAtLabel: "Costco – Gilbert" for a booth sale (contract data.saleChannel),
// '' for a showroom sale. Same wording as utils/saleChannel.js on the server.
function soldAtLabel(sc) {
  var names = { costco: 'Costco', walmart: 'Walmart', event: 'Other event' };
  if (!sc || !names[sc.channel]) return '';
  return names[sc.channel] + (sc.location ? ' – ' + sc.location : '');
}

// azToday: today's date in Arizona (MST all year) as YYYY-MM-DD — the default
// for date pickers. new Date().toISOString() is UTC, "tomorrow" after 5 pm.
function azToday() {
  return new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
}

// azDateTime: a server UTC timestamp ("2026-10-25 23:15:00", SQLite
// datetime('now')) shown in Arizona time, e.g. "Oct 25, 2026, 04:15 PM".
function azDateTime(utc) {
  if (!utc) return '';
  var d = new Date(String(utc).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(utc) ? '' : 'Z'));
  if (isNaN(d)) return String(utc);
  return d.toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// confirmDialog: a Proceed / Cancel popup (the browser's confirm() can't name
// its buttons). Resolves true for Proceed, false for Cancel / outside click / Esc.
function confirmDialog(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay open';
    ov.style.zIndex = '300'; // above the modal that opened it
    ov.innerHTML = '<div class="modal-box" style="max-width:420px" role="dialog" aria-modal="true">'
      + '<h2 style="font-size:15px;font-weight:600;margin-bottom:10px">' + escHtml(opts.title || 'Please confirm') + '</h2>'
      + '<p style="font-size:13px;line-height:1.5;margin-bottom:16px;white-space:pre-line">' + escHtml(message) + '</p>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button type="button" class="btn btn-secondary" data-act="no">' + escHtml(opts.cancelText || 'Cancel') + '</button>'
      + '<button type="button" class="btn btn-primary" data-act="yes">' + escHtml(opts.okText || 'Proceed') + '</button>'
      + '</div></div>';
    function done(v) { document.removeEventListener('keydown', onKey); ov.remove(); resolve(v); }
    function onKey(e) { if (e.key === 'Escape') done(false); }
    ov.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act) done(act.dataset.act === 'yes'); else if (e.target === ov) done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    ov.querySelector('[data-act="yes"]').focus();
  });
}

// assignSerial: Assign SI. No. When the serial is a free In-stock spa in
// inventory the server asks first: the popup says the contract will be linked
// to that inventory item; Proceed links it, Cancel goes back to the serial box.
// Resolves { ok, linked } / { cancelled } / { error }.
async function assignSerial(contractId, serial) {
  async function send(link) {
    var r = await fetch('/api/contracts/' + contractId + '/serial', { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serialNumber: serial, linkInventory: link }) });
    return { r: r, j: await r.json() };
  }
  var res = await send(false);
  if (res.r.status === 409 && res.j.needsConfirm) {
    if (!(await confirmDialog(res.j.message, { title: 'Link to inventory?', okText: 'Proceed' }))) return { cancelled: true };
    res = await send(true);
  }
  if (!res.r.ok) return { error: res.j.error || 'Failed' };
  return { ok: true, linked: !!res.j.linked };
}

// shrinkPhoto: a camera photo made smaller before upload (same 2000px / JPEG 80%
// the server uses), so several full-size phone photos stay under the server's
// 20 MB upload limit. Anything that isn't an image (a PDF), or that the browser
// can't decode, or that wouldn't get smaller, is returned unchanged.
function shrinkPhoto(file) {
  if (!file || !/^image\//.test(file.type)) return Promise.resolve(file);
  return new Promise(function(resolve){
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function(){
      URL.revokeObjectURL(url);
      var scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      var c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function(b){
        resolve(b && b.size < file.size ? new File([b], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type:'image/jpeg' }) : file);
      }, 'image/jpeg', 0.8);
    };
    img.onerror = function(){ URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// deleteUserRequest: deletes a user (admin). A salesperson with contracts gets
// a Proceed / Cancel popup first — their contracts are kept but unlinked from
// the login. Resolves { contracts } / { cancelled }; throws with the error.
async function deleteUserRequest(id) {
  var r = await fetch('/api/users/' + id, { method: 'DELETE' });
  var j = await r.json();
  if (r.status === 409 && j.needsConfirm) {
    if (!(await confirmDialog(j.message, { title: 'Delete salesperson?', okText: 'Delete' }))) return { cancelled: true };
    r = await fetch('/api/users/' + id + '?confirm=1', { method: 'DELETE' });
    j = await r.json();
  }
  if (!r.ok) throw new Error(j.error || 'Failed');
  return { contracts: j.contracts || 0 };
}

// cleaningText: Monthly Cleanings details, e.g. "3 months · Included" or
// "$45/mo · 6 months" ('' if none). Same wording as the contract PDF.
function cleaningText(mi) {
  mi = mi || {};
  var months = mi.cleaningMonths ? mi.cleaningMonths + ' month' + (String(mi.cleaningMonths) === '1' ? '' : 's') : '';
  if (mi.cleaningIncluded) return [months, 'Included'].filter(Boolean).join(' · ');
  return [mi.cleaningPrice ? '$' + mi.cleaningPrice + '/mo' : '', months].filter(Boolean).join(' · ');
}

// moneyLooksWrong: true for an amount written wrongly, like "20,0300" (a comma
// in the wrong place — read as $200,300 once). "", "20300", "20,300" and
// "$20,300.50" are fine. Same rule as utils/money.js on the server.
function moneyLooksWrong(v) {
  var s = String(v == null ? '' : v).trim();
  return s !== '' && !/^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s);
}

// newIdempotencyKey: a fresh id for one submit attempt (contract creation,
// payment recording). Carrying the SAME key through a resubmit — a browser
// Back navigation, a double-click — lets the server recognize it as the same
// attempt and return the original result instead of creating a duplicate.
function newIdempotencyKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'idk-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

// thumbUrl: the small card-size copy of an uploaded photo (server makes it on
// first request — middleware/thumbnails.js). The full photo stays the link target.
function thumbUrl(u) {
  return u ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'thumb=1' : u;
}

// LIST_PAGE / listFooter: long lists (View Contracts, Inventory) show 50 rows,
// then "Show 50 more" / "Show all". Search, filters and counts still cover the
// whole list. listFooter(el, shown, total, noun, onMore, onAll) draws the bar
// under the list; the page keeps `shown` and resets it to LIST_PAGE whenever
// the search or a filter changes.
var LIST_PAGE = 50;
function listFooter(el, shown, total, noun, onMore, onAll) {
  if (!el) return;
  var n = Math.min(shown, total), left = total - n;
  if (total <= LIST_PAGE) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML =
    '<div class="count">' + (left > 0 ? 'Showing <b>' + n + '</b> of <b>' + total + '</b> ' + noun : 'All <b>' + total + '</b> ' + noun + ' shown') + '</div>' +
    '<div class="progress"><span style="width:' + Math.round(n / total * 100) + '%"></span></div>' +
    (left > 0 ? '<button type="button" class="btn btn-secondary btn-sm" data-more><i class="fa-solid fa-angles-down"></i> Show ' + Math.min(LIST_PAGE, left) + ' more</button>' : '') +
    (left > LIST_PAGE ? '<button type="button" class="link-btn" data-all>Show all</button>' : '');
  var more = el.querySelector('[data-more]'), all = el.querySelector('[data-all]');
  if (more) more.onclick = onMore;
  if (all) all.onclick = onAll;
}
