// util.js — shared front-end helpers
// escHtml: HTML-escape a value before interpolating it into innerHTML.
// Use for any user-entered string (names, notes, addresses, emails, etc.)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// newIdempotencyKey: a fresh id for one submit attempt (contract creation,
// payment recording). Carrying the SAME key through a resubmit — a browser
// Back navigation, a double-click — lets the server recognize it as the same
// attempt and return the original result instead of creating a duplicate.
function newIdempotencyKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'idk-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}
