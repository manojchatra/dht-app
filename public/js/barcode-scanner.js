// BarcodeScanner — thin camera + decode-loop wrapper around window.BarcodeDetector
// (native where the browser has it, e.g. Android Chrome; falls back to the
// vendored WASM polyfill from barcode-detector.polyfill.js where it doesn't,
// e.g. iOS Safari). Only ever scans Code 128 / GS1-128 — the only symbology
// this app reads — restricting formats keeps each decode attempt fast.
//
// API is shaped to match the old Html5Qrcode usage it replaces, to keep each
// call site's surrounding code (thumbnail display, input-filling, SKU
// lookup, etc.) unchanged:
//   var scanner = new BarcodeScanner('regionId');
//   scanner.start(function(decodedText, photoBlob){ ... })
//          .catch(function(err){ ... camera/permission/unsupported error ... });
//   scanner.stop();
(function () {
  'use strict';

  // Self-host the WASM binary instead of the polyfill's jsDelivr default —
  // no third-party CDN dependency for a business-critical scan flow.
  if (window.BarcodeDetectionAPI && window.BarcodeDetectionAPI.prepareZXingModule) {
    window.BarcodeDetectionAPI.prepareZXingModule({
      overrides: { locateFile: function (path) { return '/js/' + path; } }
    });
  }

  var DECODE_INTERVAL_MS = 200;

  // Only one scanner (across the whole page, not just one modal) may run at
  // a time — starting a new one stops whichever other one is currently
  // active, instead of leaving both cameras open and both scan regions
  // visible/stacked at once.
  var activeScanner = null;

  // Code 128 barcodes containing GS1 data (FNC1 in the first position, common
  // for these long numeric SKU/serial labels) decode with a leading AIM
  // symbology identifier — "]C1" (or "]C0"/"]C2"/"]C4" for other Code 128
  // variants) — glued onto the front of the value, e.g. "]C1141101309700.26"
  // instead of "141101309700.26". That prefix is meant to be separate
  // metadata (identifying which symbology was read), not part of the actual
  // barcode content, so strip it before handing the value back.
  function stripSymbologyIdentifier(text) {
    return text.replace(/^\]C[0-9]/, '');
  }

  function BarcodeScanner(regionId) {
    this.regionId = regionId;
    this.video = null;
    this.stream = null;
    this.canvas = null;
    this.ctx = null;
    this.timer = null;
    this.detector = null;
    this.running = false;
  }

  // Resolves once the camera is live and scanning has started; rejects on
  // permission denial, missing region element, or an unsupported browser —
  // callers should .catch() this the same way they caught Html5Qrcode's
  // .start() promise before.
  BarcodeScanner.prototype.start = function (onDetect) {
    var self = this;
    var region = document.getElementById(this.regionId);
    if (!region) return Promise.reject(new Error('Scan region not found: ' + this.regionId));
    if (!window.BarcodeDetector) return Promise.reject(new Error('Barcode scanning is not supported in this browser'));

    if (activeScanner && activeScanner !== this) activeScanner.stop();

    this.detector = new window.BarcodeDetector({ formats: ['code_128'] });

    // 'ideal' (not 'exact'/'min') — degrades gracefully on a camera that can't
    // hit 1080p rather than failing getUserMedia outright. Without an explicit
    // resolution, browsers fall back to a conservative default for a live
    // preview stream, well below what the same camera captures for a still
    // photo — small/dense barcodes that read fine in a photo can come through
    // soft and undecodable at that lower live-preview resolution.
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    })
      .then(function (stream) {
        self.stream = stream;
        self._applyContinuousFocus(stream);
        self._enablePinchZoom(stream, region);
        self.video = document.createElement('video');
        self.video.setAttribute('playsinline', 'true'); // required for inline (non-fullscreen) playback on iOS Safari
        self.video.muted = true;
        self.video.srcObject = stream;
        region.innerHTML = '';
        region.appendChild(self.video);
        return self.video.play();
      })
      .then(function () {
        self.canvas = document.createElement('canvas');
        self.ctx = self.canvas.getContext('2d');
        self.running = true;
        activeScanner = self;
        self.timer = setInterval(function () { self._tick(onDetect); }, DECODE_INTERVAL_MS);
      });
  };

  // Chrome on Android supports a 'focusMode' track constraint (continuous
  // autofocus) beyond the standard getUserMedia spec — no other browser
  // (desktop Chrome, any Safari) exposes camera focus control at all, so
  // this only helps Android and is a silent no-op everywhere else. Small
  // barcodes going soft/out-of-focus with no way to refocus was otherwise
  // unfixable from the web page's side.
  BarcodeScanner.prototype._applyContinuousFocus = function (stream) {
    var track = stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return;
    try {
      var caps = track.getCapabilities();
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
    } catch (e) { /* getCapabilities/applyConstraints unsupported — ignore */ }
  };

  // Two-finger pinch to zoom, mapped onto the camera's native optical/hybrid
  // zoom via the (non-standard, Chrome-only) 'zoom' track constraint — same
  // Android-only situation as focus: no other browser exposes camera zoom
  // control, so this is a silent no-op on iOS Safari and desktop. There, the
  // fallback is physically moving the phone closer, or the higher base
  // resolution above giving the decoder more to work with either way.
  BarcodeScanner.prototype._enablePinchZoom = function (stream, region) {
    var track = stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return;
    var caps;
    try { caps = track.getCapabilities(); } catch (e) { return; }
    if (!caps.zoom || typeof caps.zoom.min !== 'number' || typeof caps.zoom.max !== 'number') return;

    // Without this, the browser's own page-zoom gesture recognizer competes
    // with our pinch handler for the same two-finger touch — the symptom is
    // exactly "pinching zooms the whole page instead of just the video".
    // 'touch-action' isn't inherited, but the browser still honors an
    // ancestor's restriction for touches starting inside it, so setting it
    // once on the region (rather than the not-yet-created video element)
    // covers the video too.
    var prevTouchAction = region.style.touchAction;
    region.style.touchAction = 'none';

    var startDist = null;
    var startZoom = caps.zoom.min;
    try { startZoom = track.getSettings().zoom || startZoom; } catch (e) { /* use caps.zoom.min */ }

    function distance(touches) {
      var dx = touches[0].clientX - touches[1].clientX;
      var dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function onTouchStart(e) {
      if (e.touches.length !== 2) return;
      startDist = distance(e.touches);
      try { startZoom = track.getSettings().zoom || startZoom; } catch (err) { /* keep prior value */ }
    }
    function onTouchMove(e) {
      if (e.touches.length !== 2 || !startDist) return;
      e.preventDefault(); // stop the page itself from scrolling/zooming under the pinch
      var scale = distance(e.touches) / startDist;
      var zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, startZoom * scale));
      track.applyConstraints({ advanced: [{ zoom: zoom }] }).catch(function () {});
    }
    function onTouchEnd() { startDist = null; }

    region.addEventListener('touchstart', onTouchStart, { passive: true });
    region.addEventListener('touchmove', onTouchMove, { passive: false });
    region.addEventListener('touchend', onTouchEnd, { passive: true });

    this._zoomCleanup = function () {
      region.removeEventListener('touchstart', onTouchStart);
      region.removeEventListener('touchmove', onTouchMove);
      region.removeEventListener('touchend', onTouchEnd);
      region.style.touchAction = prevTouchAction;
    };
  };

  BarcodeScanner.prototype._tick = function (onDetect) {
    if (!this.running || !this.video || this.video.readyState < 2) return;
    var w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    var self = this;
    this.detector.detect(this.canvas)
      .then(function (results) {
        if (!self.running || !results.length) return;
        var text = stripSymbologyIdentifier(results[0].rawValue);
        self.canvas.toBlob(function (blob) {
          if (!self.running) return; // stopped while toBlob was pending
          self.stop();
          onDetect(text, blob);
        }, 'image/jpeg', 0.85);
      })
      .catch(function () { /* no barcode in this frame — expected, ignored, same as the old per-frame no-op callback */ });
  };

  BarcodeScanner.prototype.stop = function () {
    if (activeScanner === this) activeScanner = null;
    this.running = false;
    if (this._zoomCleanup) { this._zoomCleanup(); this._zoomCleanup = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stream) { this.stream.getTracks().forEach(function (t) { t.stop(); }); this.stream = null; }
    if (this.video) {
      var region = document.getElementById(this.regionId);
      if (region && this.video.parentNode === region) region.removeChild(this.video);
      this.video = null;
    }
  };

  window.BarcodeScanner = BarcodeScanner;
})();
