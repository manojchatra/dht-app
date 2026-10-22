// gallery.js — full-screen photo viewer shared by the contract pages.
// openGallery(urls, startIndex): ‹ › arrows, "3 / 12" counter, ←/→ keys,
// swipe on phones, Esc / × / click outside to close, Download saves the photo
// on screen. Builds its own overlay, so a page only needs this script.
(function () {
  var urls = [], idx = 0, box, img, counter, prevBtn, nextBtn, touchX = null;

  var css = '' +
    '.gal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:400;align-items:center;justify-content:center;flex-direction:column;gap:14px}' +
    '.gal.open{display:flex}' +
    '.gal img{max-width:86vw;max-height:78vh;border-radius:8px;object-fit:contain;user-select:none}' +
    '.gal-close{position:fixed;top:14px;right:18px;color:#fff;font-size:30px;cursor:pointer;background:none;border:none;line-height:1}' +
    '.gal-nav{position:fixed;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;border:none;background:rgba(255,255,255,.16);color:#fff;font-size:26px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.gal-nav:hover{background:rgba(255,255,255,.3)}' +
    '.gal-prev{left:14px}.gal-next{right:14px}' +
    '.gal-bar{display:flex;align-items:center;gap:14px}' +
    '.gal-count{color:#fff;font-size:13px;opacity:.85;min-width:54px;text-align:center}' +
    '.gal-dl{background:#fff;color:#111;border:none;border-radius:8px;padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px}' +
    '@media(max-width:600px){.gal-nav{width:38px;height:38px;font-size:22px}.gal-prev{left:6px}.gal-next{right:6px}}';

  function build() {
    if (box) return;
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    box = document.createElement('div');
    box.className = 'gal';
    box.innerHTML =
      '<button class="gal-close" aria-label="Close">×</button>' +
      '<button class="gal-nav gal-prev" aria-label="Previous photo">‹</button>' +
      '<img alt="Photo">' +
      '<button class="gal-nav gal-next" aria-label="Next photo">›</button>' +
      '<div class="gal-bar"><span class="gal-count"></span>' +
      '<button class="gal-dl"><i class="fa-solid fa-download"></i> Download</button></div>';
    document.body.appendChild(box);
    img = box.querySelector('img'); counter = box.querySelector('.gal-count');
    prevBtn = box.querySelector('.gal-prev'); nextBtn = box.querySelector('.gal-next');
    box.querySelector('.gal-close').onclick = close;
    prevBtn.onclick = function () { step(-1); };
    nextBtn.onclick = function () { step(1); };
    box.querySelector('.gal-dl').onclick = function () {
      var a = document.createElement('a'); a.href = urls[idx];
      a.download = decodeURIComponent((urls[idx] || '').split('/').pop().split('?')[0]) || 'image';
      a.click();
    };
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    box.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX; touchX = null;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    });
    document.addEventListener('keydown', function (e) {
      if (!box.classList.contains('open')) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'Escape') close();
    });
  }

  function show() {
    img.src = urls[idx];
    var many = urls.length > 1;
    counter.textContent = many ? (idx + 1) + ' / ' + urls.length : '';
    prevBtn.style.display = nextBtn.style.display = many ? '' : 'none';
  }
  function step(d) { if (urls.length > 1) { idx = (idx + d + urls.length) % urls.length; show(); } }
  function close() { box.classList.remove('open'); img.src = ''; }

  window.openGallery = function (list, start) {
    urls = (list || []).filter(Boolean);
    if (!urls.length) return;
    build();
    idx = Math.min(Math.max(start || 0, 0), urls.length - 1);
    show();
    box.classList.add('open');
  };
})();
