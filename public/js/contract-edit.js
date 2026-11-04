// contract-edit.js — editing a saved contract.
//  - Contract page (contract-detail.html): canEditContract() decides whether the
//    "Edit contract" button shows.
//  - /contracts/:id/edit: New Contract's own form (create-contract.html) opened
//    in edit mode — filled in from the contract, the fields that can't change
//    locked, images removable with ×, and "Save changes" (with a reason) in
//    place of Preview & Save. The server takes only the editable fields and
//    does every check (POST /api/contracts/:id/edit, services/contractEdit.js).
// Needs js/util.js.

// Admin, or the contract's own salesperson.
function canEditContract(c) {
  if (window._userRole === 'admin') return true;
  return window._userRole === 'sales' && c.salesman_user_id === window._userId;
}
function contractClosed(c) { return c.status === 'delivered' || c.status === 'cancelled'; }

(function () {
  var m = location.pathname.match(/^\/contracts\/(\d+)\/edit\/?$/);
  if (!m) return; // not the edit page
  var EDIT_ID = +m[1];
  var removeImages = {};

  // Runs after the page's own start-up (salespeople list) once the login is known.
  var pageAuthReady = window._onAuthReady;
  window._onAuthReady = async function () {
    if (pageAuthReady) await pageAuthReady();
    try { await startEdit(); }
    catch (e) { showToast(e.message || 'Could not open the contract', 'error'); }
  };

  var $ = function (id) { return document.getElementById(id); };
  function setVal(id, v) { var el = $(id); if (el) el.value = v == null ? '' : v; }
  function setChk(id, on) { var el = $(id); if (el) el.checked = !!on; }
  function setRadio(name, v) { document.querySelectorAll('[name="' + name + '"]').forEach(function (r) { r.checked = (v !== undefined && v !== null && r.value === String(v)); }); }
  function setMulti(cls, values) {
    var list = (Array.isArray(values) ? values : String(values || '').split(',')).map(function (s) { return String(s).trim(); });
    document.querySelectorAll('.' + cls).forEach(function (b) { b.checked = list.indexOf(b.value) >= 0; });
  }
  function setDate(hidden, text, v) { setVal(hidden, v || ''); if (typeof syncTextFromDate === 'function') syncTextFromDate(hidden, text); }
  function lock(el, note) {
    if (!el) return;
    el.classList.add('edit-locked');
    el.querySelectorAll && el.querySelectorAll('input,select,textarea,button').forEach(function (x) { x.disabled = true; });
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) el.disabled = true;
    if (note) el.title = note;
  }
  var yn = function (b) { return b ? 'yes' : (b === false ? 'no' : ''); };

  async function startEdit() {
    // The form's own buttons get their handlers when the page has loaded.
    if (document.readyState === 'loading') await new Promise(function (ok) { document.addEventListener('DOMContentLoaded', ok); });
    var r = await fetch('/api/contracts/' + EDIT_ID);
    var c = await r.json();
    if (!r.ok) throw new Error(c.error || 'Contract not found');
    var d = c.data || {};
    if (!canEditContract(c) || !(d.customer || d.product || d.costing)) {
      showToast('This contract can\'t be edited here', 'error');
      setTimeout(function () { location.href = '/contracts/' + EDIT_ID; }, 1200); return;
    }
    var closed = contractClosed(c);
    var cu = d.customer || {}, ph = cu.phone || {}, pr = d.product || {}, w = d.warranty || {},
        sv = d.service || {}, el = d.electrical || {}, mi = d.misc || {}, de = d.details || {}, co = d.costing || {}, pa = d.payment || {};
    var g = function (k) { return de[k] || {}; };

    document.title = 'Edit ' + c.contract_number + ' — DHT';
    var h1 = document.querySelector('.page-header h1');
    if (h1) h1.innerHTML = 'Edit Contract <span style="color:var(--accent)">' + escHtml(c.contract_number) + '</span>';

    // ── Fill the form from the contract ──
    selectedStore = d.store || c.store || '';
    document.querySelectorAll('.store-chip').forEach(function (x) { x.classList.toggle('active', x.dataset.store === selectedStore); });
    var sc = d.saleChannel || { channel: 'showroom' };
    var chan = document.querySelector('.chan-btn[data-channel="' + (sc.channel || 'showroom') + '"]');
    if (chan) chan.click();
    setVal('boothLocation', sc.location || '');
    setDate('saleDate', 'saleDateText', d.date || c.date);
    setDate('deliveryDate', 'deliveryDateText', d.deliveryDate || '');
    var sel = $('salesman');
    if (sel) {
      var uid = String(c.salesman_user_id || d.salesmanUserId || '');
      if (uid && !sel.querySelector('option[value="' + uid + '"]')) { var o = document.createElement('option'); o.value = uid; o.textContent = d.salesman || c.salesman || 'Salesperson'; sel.appendChild(o); }
      sel.value = uid;
    }

    setVal('custName', cu.name); setVal('custEmail', cu.email); setVal('custAddress', cu.address);
    setVal('custCity', cu.city); setVal('custState', cu.state || 'AZ'); setVal('custZip', cu.zip);
    setVal('custCell', ph.cell); setVal('custHome', ph.home); setVal('custWork', ph.work);
    setVal('custHeard', cu.heardAbout);
    setRadio('gated', cu.gated ? 'yes' : 'no'); setVal('gateCode', cu.gateCode);
    if ($('gateCode')) $('gateCode').style.display = cu.gated ? 'block' : 'none';
    linkedCustomer = { id: c.customer_id }; // the "existing customer?" popup is for new contracts

    selectedStatus = pr.status || c.product_status || '';
    document.querySelectorAll('.status-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.status === selectedStatus); });
    if ($('floorModelRow')) $('floorModelRow').style.display = selectedStatus === 'instock' ? 'block' : 'none';
    setVal('floorModel', pr.floorModel);
    setVal('prodMake', pr.make); setVal('prodSeries', pr.series); setVal('prodModel', pr.model); setVal('prodYear', pr.year);
    setVal('prodSerial', c.serial_number || pr.serialNumber); confirmedSerial = c.serial_number || pr.serialNumber || '';
    if ($('spaSerial')) $('spaSerial').textContent = c.serial_number || pr.serialNumber || '—';
    updateSeriesDl(pr.make || '');
    selectedShell = ''; selectedCabinet = '';
    renderColourChips();
    selectChipFromValue('shellChips', coloursFor('shell'), normColour('shell', pr.shellColor), 'shellColorOther', function (v) { selectedShell = v; });
    selectChipFromValue('cabinetChips', coloursFor('cabinet'), normColour('cabinet', pr.cabinetColor), 'cabinetColorOther', function (v) { selectedCabinet = v; });
    selectChipFromValue('coverChips', COVER_COLORS, pr.coverColor, 'coverColorOther', function (v) { selectedCover = v; });
    setChk('inclSpeaker', pr.included && pr.included.speaker);

    var mfg = w.manufacturer || {}, dlr = w.dealership || {};
    setMulti('mfg-brand', mfg.brands); setVal('mfgComp', mfg.componentYrs); setVal('mfgShell', mfg.shellYrs); setVal('mfgCabinet', mfg.cabinetYrs);
    setMulti('dlr-brand', dlr.brands); setVal('dlrComp', dlr.componentYrs); setVal('dlrShell', dlr.shellYrs); setVal('dlrCabinet', dlr.cabinetYrs);

    setChk('svcInTown', sv.inTownDelivery); setChk('svcOutTown', sv.outOfTownDelivery);
    setChk('svcCrane', sv.crane); toggleCraneFee(); setVal('craneFee', sv.craneFee);
    setVal('svcOutTownFee', sv.outOfTownDeliveryFee);
    setChk('svcOutWarranty', sv.outOfTownWarranty); setVal('svcOutWarrantyFee', sv.outOfTownWarrantyFee);

    setChk('elecPamphlet', el.pamphletProvided); setChk('elecOwnElec', el.ownElectrician); setVal('elecNotes', el.notes);

    setVal('miscNotes', mi.notes); setChk('miscCleanings', mi.monthlyCleanings);
    if ($('cleaningPriceRow')) $('cleaningPriceRow').style.display = mi.monthlyCleanings ? 'flex' : 'none';
    setVal('miscCleaningPrice', mi.cleaningPrice); setVal('miscCleaningMonths', mi.cleaningMonths); setChk('miscCleaningIncl', mi.cleaningIncluded);

    setVal('dtSpaPrice', de.spaPrice);
    setMulti('cover-type', g('cover').coverType); setMulti('cover-brand', g('cover').brand); setMulti('cover-lift', g('cover').lift);
    setVal('coverLiftOther', g('cover').otherLift); setVal('dtCoverPrice', g('cover').price); setChk('dtCoverIncl', g('cover').included);
    var stepsKnown = ['HLStep', 'EWStep', 'PolyStep', 'DuraStep'].indexOf(g('steps').type) >= 0;
    setRadio('steps', stepsKnown ? g('steps').type : null); setVal('stepsOther', stepsKnown ? '' : g('steps').type);
    setVal('dtStepsPrice', g('steps').price); setChk('dtStepsIncl', g('steps').included);
    setRadio('subpanel', yn(g('subpanel').provided)); onSubpanelChange(); setRadio('subpanelAmp', g('subpanel').amperage);
    setVal('dtSubpanelPrice', g('subpanel').price); setChk('dtSubpanelIncl', g('subpanel').included);
    setRadio('waterCareSystem', g('waterCareSystem').type); onWaterCareChange();
    setVal('dtWaterSysPrice', g('waterCareSystem').price); setChk('dtWaterSysIncl', g('waterCareSystem').included);
    setChk('wcAutoDosing', g('upgradedWaterCare').autoDosing); setChk('wcFwssIq', g('upgradedWaterCare').fwssIq);
    setVal('dtUpgradedWaterPrice', g('upgradedWaterCare').price); setChk('dtUpgradedWaterIncl', g('upgradedWaterCare').included);
    setRadio('startup', yn(g('startupChemicals').yes)); setVal('dtStartupPrice', g('startupChemicals').price); setChk('dtStartupIncl', g('startupChemicals').included);
    setRadio('coolzone', yn(g('coolZone').yes)); setChk('coolzoneExt', g('coolZone').extWarranty); setVal('dtCoolzonePrice', g('coolZone').price);
    setMulti('acc-item', g('accessories').items); setVal('accOther', g('accessories').other);
    setVal('dtAccPrice', g('accessories').price); setChk('dtAccIncl', g('accessories').included);
    setRadio('spaRemoval', yn(g('spaRemoval').yes)); setVal('dtSpaRemovalPrice', g('spaRemoval').price);
    setRadio('fuelSurcharge', yn(g('fuelSurcharge').yes)); setVal('dtFuelPrice', g('fuelSurcharge').price);
    setRadio('discount', yn(g('discount').yes));
    if ($('discountReasonRow')) $('discountReasonRow').style.display = g('discount').yes ? 'block' : 'none';
    setVal('dtDiscountReason', g('discount').reason); setVal('dtDiscountPrice', g('discount').amount);
    setVal('costTaxPct', co.taxPercent);

    setChk('payChequeSel', pa.cheque && pa.cheque.selected); setVal('payChequeNum', pa.cheque && pa.cheque.number); setVal('payChequeAmt', pa.cheque && pa.cheque.amount);
    setChk('payCCSel', pa.creditCard && pa.creditCard.selected); setVal('payCCLastFour', pa.creditCard && pa.creditCard.lastFour); setVal('payCCAmt', pa.creditCard && pa.creditCard.amount);
    setChk('payCashSel', pa.cash && pa.cash.selected); setVal('payCashAmt', pa.cash && pa.cash.amount);
    setChk('payFinanceSel', pa.finance && pa.finance.selected); setVal('payFinancePlan', pa.finance && pa.finance.plan); setVal('payFinanceAmt', pa.finance && pa.finance.amount);
    setVal('payDepositDays', pa.depositDays); setVal('payDepositAmt', pa.depositAmount);
    recalcAll();
    if ($('payDuePrior')) { $('payDuePrior').value = Number(c.due_prior || 0).toFixed(2); }

    // ── Lock what can't change ──
    var ALWAYS = 'Can\'t be changed here';
    document.querySelectorAll('.store-chip').forEach(function (x) { lock(x, ALWAYS); });
    lock($('saleDateText') && $('saleDateText').parentElement, ALWAYS);
    lock($('salesman'), ALWAYS);
    document.querySelectorAll('.status-btn').forEach(function (b) { lock(b, 'In Stock / To Be Ordered is changed from the Status page'); });
    lock($('floorModelRow'), ALWAYS);
    lock($('invTrigger') && $('invTrigger').parentElement, 'The spa is changed with Assign SI. No');
    lock($('prodSerial'), 'The serial is changed with Assign SI. No on the contract page');
    lock($('prodFinanceWrap'), ALWAYS);
    if (c.linked_unit_id) {
      lock($('prodMake'), 'Comes from the linked spa (' + (c.linked_unit_serial || 'on order') + ')');
      lock($('prodModel'), 'Comes from the linked spa (' + (c.linked_unit_serial || 'on order') + ')');
    }
    var payCard = $('payChequeSel') && $('payChequeSel').closest('.card');
    lock(payCard, 'Payments are recorded or voided on the contract page');
    if (payCard) addNote(payCard, 'Payments taken at signing — shown for reference. Record or void payments on the contract page.');
    var sigCard = $('contractSig') && $('contractSig').closest('.card');
    if (sigCard) sigCard.style.display = 'none';

    if (closed) {
      // Delivered / Cancelled: only phones, email and gate.
      var OPEN = ['custCell', 'custHome', 'custWork', 'custEmail', 'gateCode'];
      document.querySelectorAll('main input, main select, main textarea, main .chip, main .chan-btn, main .status-btn').forEach(function (x) {
        if (OPEN.indexOf(x.id) >= 0 || x.name === 'gated') return;
        lock(x, 'This contract is ' + (c.status === 'delivered' ? 'Delivered' : 'Cancelled') + ' — only contact details can be changed');
      });
      var firstCard = document.querySelector('main .card');
      if (firstCard) firstCard.insertAdjacentHTML('beforebegin', '<div class="edit-banner"><i class="fa-solid fa-lock"></i> ' + escHtml(c.contract_number) + ' is '
        + (c.status === 'delivered' ? 'Delivered' : 'Cancelled') + ' — only phones, email and gate details can be changed.</div>');
    }

    showImages(c, closed);
    showSaveBar(c);
  }

  function addNote(card, text) {
    var p = document.createElement('p'); p.className = 'helper'; p.style.margin = '0 0 10px';
    p.innerHTML = '<i class="fa-solid fa-lock"></i> ' + escHtml(text);
    var head = card.querySelector('.card-header'); if (head) head.after(p);
  }

  // The contract's images with × to remove (not the signature, serial / SKU or delivery photos).
  function showImages(c, closed) {
    var card = $('contractImg') && $('contractImg').closest('.card');
    if (!card) return;
    var keep = function (url, label) {
      return /sig-contract-customer/i.test(url) || /signature/i.test(label || '')
        || /^(serial number photo|sku barcode photo|delivery photo)/i.test(label || '') || /(serial-photo|sku-photo|delivery-photo)/i.test(url);
    };
    var imgs = [];
    if (c.contract_image_url) imgs.push({ url: c.contract_image_url, label: 'Contract' });
    if (c.cheque_image_url) imgs.push({ url: c.cheque_image_url, label: 'Cheque' });
    (c.extra_images_data || []).forEach(function (i) { imgs.push({ url: i.url, label: i.label || '' }); });
    card.innerHTML = '<div class="card-header"><i class="fa-solid fa-images"></i>Images</div>'
      + '<p class="helper" style="margin-bottom:10px">' + (closed ? 'Images can\'t be removed once the contract is closed.' : 'Tap × to remove an image when you save. New images are added with Add Image on the contract page.') + '</p>'
      + (imgs.length ? '<div class="edit-imgs">' + imgs.map(function (im) {
          var isPdf = /\.pdf$/i.test(im.url), canRemove = !closed && !keep(im.url, im.label);
          return '<div class="edit-img" data-url="' + escHtml(im.url) + '">'
            + (isPdf ? '<a href="' + escHtml(im.url) + '" target="_blank" class="edit-pdf"><i class="fa-solid fa-file-pdf"></i></a>' : '<img src="' + escHtml(im.url) + '" alt="">')
            + '<div class="edit-img-label">' + escHtml(im.label || 'Image') + '</div>'
            + (canRemove ? '<button type="button" class="edit-img-x" title="Remove this image">×</button>' : '')
            + '</div>';
        }).join('') + '</div>' : '<p class="helper">No images.</p>');
    card.querySelectorAll('.edit-img-x').forEach(function (b) {
      b.addEventListener('click', function () {
        var box = b.closest('.edit-img'), url = box.dataset.url;
        if (removeImages[url]) { delete removeImages[url]; box.classList.remove('to-remove'); b.textContent = '×'; b.title = 'Remove this image'; }
        else { removeImages[url] = true; box.classList.add('to-remove'); b.textContent = '↺'; b.title = 'Keep this image'; }
      });
    });
  }

  function showSaveBar(c) {
    var bar = document.querySelector('.action-bar');
    if (!bar) return;
    bar.innerHTML = '<div style="flex:1;min-width:240px"><label class="lbl">Reason for the change *</label>'
      + '<textarea id="editReason" rows="2" maxlength="300" style="width:100%" placeholder="e.g. Steps were included on the handwritten contract"></textarea></div>'
      + '<div style="display:flex;gap:10px;align-items:flex-end">'
      + '<a href="/contracts/' + c.id + '" class="btn btn-secondary">Cancel</a>'
      + '<button type="button" class="btn-preview-save" id="editSaveBtn"><i class="fa-solid fa-check"></i> Save changes</button></div>';
    bar.style.alignItems = 'flex-end'; bar.style.flexWrap = 'wrap';
    $('editSaveBtn').addEventListener('click', function () { saveEdit(c); });
  }

  async function saveEdit(c) {
    var btn = $('editSaveBtn'), reason = ($('editReason').value || '').trim();
    if (!reason) { showToast('Enter the reason for the change', 'error'); $('editReason').focus(); return; }
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    try {
      var r = await fetch('/api/contracts/' + c.id + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form: collectData(), reason: reason, removeImages: Object.keys(removeImages) }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error || 'Failed to save');
      var msg = 'Saved' + (j.totals ? ' — Grand Total $' + j.totals.grandTotal.toFixed(2) + ', balance $' + Number(j.balance).toFixed(2) : '');
      if (j.owesWhileScheduled) msg += ' — this scheduled delivery now owes money';
      showToast(msg, j.owesWhileScheduled ? 'error' : 'success');
      setTimeout(function () { location.href = '/contracts/' + c.id; }, j.owesWhileScheduled ? 2500 : 900);
    } catch (e) {
      showToast(e.message, 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Save changes';
    }
  }
})();
