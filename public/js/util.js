// util.js — shared front-end helpers
// escHtml: HTML-escape a value before interpolating it into innerHTML.
// Use for any user-entered string (names, notes, addresses, emails, etc.)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
