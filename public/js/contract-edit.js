// contract-edit.js — editing a saved contract.
//  - Contract page and the card ⋮ menus: canEditContract() (js/util.js) decides
//    whether "Edit contract" shows.
//  - /contracts/:id/edit: New Contract's own form (create-contract.html) opened
//    in edit mode — filled in from the contract, the fields that can't change
//    locked, images removable with × or added with a label, the spa / serial /
//    In Stock ↔ To Be Ordered for an admin, and "Save changes" (with a reason)
//    in place of Preview & Save. The server takes only the editable fields and
//    does every check (POST /api/contracts/:id/edit, services/contractEdit.js,
//    services/contractSpa.js).
// Needs js/util.js (canEditContract, choiceDialog).
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

    selectedStatus = c.product_status || pr.status || ''; // the server compares with product_status
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
    lock($('floorModelRow'), ALWAYS);
    setupSpa(c, closed);
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

  // ── The spa (admin only) ──────────────────────────────────────────────────
  // Inventory Search, the serial and In Stock / To Be Ordered work as on New
  // Contract, and the card moves with a switch when the edit is saved
  // (services/contractSpa.js). Switching only while Assigned / To Be Ordered /
  // Order Placed; Received / Scheduled can take another spa of the same kind.
  var C = null, canSwap = false, canSwitch = false, addInvSerial = '', serialBefore = '', quiet = false;
  var STATUS_NAME = { assigned: 'Assigned', tbo: 'To Be Ordered', order_placed: 'Order Placed', received: 'Received', scheduled: 'Scheduled' };
  function unlock(el) {
    if (!el) return;
    el.classList.remove('edit-locked'); el.title = '';
    el.querySelectorAll && el.querySelectorAll('input,select,textarea,button').forEach(function (x) { x.disabled = false; });
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) el.disabled = false;
  }
  // Make / model come from a linked inventory spa.
  function makeModelFromSpa(serial) {
    if (serial) { lock($('prodMake'), 'Comes from the linked spa (' + serial + ')'); lock($('prodModel'), 'Comes from the linked spa (' + serial + ')'); }
    else { unlock($('prodMake')); unlock($('prodModel')); }
  }
  function setKind(kind) {
    selectedStatus = kind;
    document.querySelectorAll('.status-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.status === kind); });
    if ($('floorModelRow')) $('floorModelRow').style.display = kind === 'instock' ? 'block' : 'none';
    refreshFinanceChoice();
  }
  function clearSerialBox() {
    clearOrderedUnit(); // an on-order pick too
    ['invTrigger', 'prodSerial', 'prodFinance'].forEach(function (id) { if ($(id)) $(id).value = ''; });
    if ($('invClear')) $('invClear').style.display = 'none';
    if ($('spaSerial')) $('spaSerial').textContent = '—';
    confirmedSerial = ''; addInvSerial = '';
  }
  function moveToTbo() {
    setKind('tbo');
    clearSerialBox();
    // Back to the salesperson's remark if the contract started as To Be Ordered.
    if (C.product_status !== 'instock' && C.serial_number) { $('prodSerial').value = C.serial_number; confirmedSerial = C.serial_number; }
    makeModelFromSpa('');
    refreshFinanceChoice();
    showToast('Moves to To Be Ordered when you save — the spa goes back to stock', 'success');
  }

  function setupSpa(c, closed) {
    C = c;
    var isAdmin = window._userRole === 'admin';
    canSwap = isAdmin && !closed;
    canSwitch = canSwap && ['assigned', 'tbo', 'order_placed'].indexOf(c.status) >= 0;
    var linkedSerial = c.linked_unit_id ? (c.linked_unit_serial || 'on order') : '';

    // The New Contract handlers on the status buttons are swapped for these.
    document.querySelectorAll('.status-btn').forEach(function (b) {
      var nb = b.cloneNode(true); b.replaceWith(nb);
      if (!canSwitch) {
        lock(nb, !isAdmin ? 'Only an admin can switch In Stock / To Be Ordered'
          : c.contract_number + ' is ' + (STATUS_NAME[c.status] || c.status) + ' — In Stock / To Be Ordered can\'t be switched now');
        return;
      }
      nb.addEventListener('click', async function () {
        if (quiet || nb.dataset.status === selectedStatus) return;
        if (nb.dataset.status === 'tbo') {
          var sn = ($('prodSerial').value || '').trim();
          var ok = await confirmDialog('Move ' + c.contract_number + ' to To Be Ordered?'
            + (sn ? '\n\n' + sn + ' goes back to In-stock and the serial is cleared.' : '')
            + '\n\nThe card moves to To Be Ordered when you save.', { title: 'Switch to To Be Ordered', okText: 'Move to To Be Ordered' });
          if (ok) moveToTbo();
        } else {
          setKind('instock');
          clearSerialBox(); // a remark isn't a serial
          showToast('Pick the spa in Inventory Search or type its serial', 'success');
          openInvModal();
        }
      });
    });

    var searchRow = $('invTrigger') && $('invTrigger').parentElement.parentElement;
    if (!canSwap) {
      var why = isAdmin ? 'This contract is closed' : 'Only an admin can change the spa';
      lock(searchRow, why); lock($('prodSerial'), why); lock($('prodFinanceWrap'), why);
      if (linkedSerial) makeModelFromSpa(linkedSerial);
      return;
    }
    if (linkedSerial) {
      makeModelFromSpa(linkedSerial);
      if (c.linked_unit_serial) {
        $('invTrigger').value = (c.make || '') + ' ' + (c.model || '') + ' - ' + c.linked_unit_serial;
        $('invClear').style.display = 'block';
      } else {
        // Reserved on-order stock: shown; another on-order spa can be picked instead.
        $('invTrigger').value = (c.make || '') + ' ' + (c.model || '') + ' - On order (Truck ' + (c.truck_number || '—') + ')';
      }
    }

    // Inventory Search pick. On-order stock (on a truck, no serial yet) is
    // reserved for a To Be Ordered / Order Placed contract — it takes the spa's
    // Web Order # / Truck # and runs as Order Placed. An In-stock spa on a To Be
    // Ordered contract asks before it becomes In Stock.
    var ncSelectUnit = selectUnit;
    selectUnit = async function (row, alreadyAsked) {
      if (row.availability === 'Ordered') {
        if (['tbo', 'order_placed'].indexOf(c.status) < 0 || selectedStatus === 'instock') {
          showToast('On-order stock can only be linked to a To Be Ordered or Order Placed contract', 'error'); return;
        }
        closeInvModal();
        var okOrder = await confirmDialog(spaText(Object.assign({}, row, { serial_number: 'On order' }))
          + '\nTruck ' + (row.truck_number || '—') + ' · Web Order # ' + (row.web_order_number || '—')
          + '\n\nReserve this spa for ' + c.contract_number + '? It takes this Web Order # and Truck #'
          + (c.status === 'tbo' ? ' and the card moves to Order Placed' : '') + ' when you save.',
          { title: 'Link on-order spa?', okText: 'Reserve this spa' });
        if (!okOrder) return;
        quiet = true;
        try { ncSelectUnit(row); } finally { quiet = false; }
        setKind('tbo');
        addInvSerial = '';
        makeModelFromSpa('on order');
        return;
      }
      if (selectedStatus === 'tbo' && canSwitch && !alreadyAsked) {
        closeInvModal();
        var ok = await confirmDialog(spaText(row) + '\n\nSwitch ' + c.contract_number + ' to In Stock with this spa? The card moves to Assigned when you save.',
          { title: 'Switch to In Stock?', okText: 'Switch to In Stock', cancelText: 'Keep To Be Ordered' });
        if (!ok) return;
      }
      quiet = true;
      try { ncSelectUnit(row); } finally { quiet = false; }
      if (canSwitch) setKind('instock'); else setKind(selectedStatus); // Received / Scheduled keep their kind
      addInvSerial = '';
      makeModelFromSpa(row.serial_number || '');
    };

    // × on Inventory Search: an In Stock contract then needs another spa, or To Be Ordered.
    var ncClear = clearSpaSelection;
    clearSpaSelection = async function () {
      ncClear();
      addInvSerial = '';
      makeModelFromSpa('');
      if (selectedStatus === 'instock' && canSwitch) {
        var pick = await choiceDialog('The spa is cleared. ' + c.contract_number + ' is In Stock, so it needs another spa — or move it to To Be Ordered.',
          { title: 'Spa cleared', choices: [{ value: 'tbo', label: 'Move to To Be Ordered' }, { value: 'pick', label: 'Pick another spa', primary: true }] });
        if (pick === 'tbo') moveToTbo(); else if (pick === 'pick') openInvModal();
      }
    };

    // A typed serial is checked against inventory when the box is left.
    var serialBox = $('prodSerial');
    serialBox.removeEventListener('change', checkTypedSerial);
    serialBox.addEventListener('focus', function () { serialBefore = serialBox.value; });
    serialBox.addEventListener('change', onSerialChange);
  }

  function spaText(u) {
    return (u.serial_number || 'Spa') + ': ' + [u.make, u.series, u.model, u.year].filter(Boolean).join(' ')
      + '\nShell: ' + (u.shell_color || '—') + ' · Cabinet: ' + (u.cabinet_color || '—') + (u.location ? '\nLocation: ' + u.location : '');
  }

  async function onSerialChange() {
    var input = $('prodSerial'), serial = (input.value || '').trim();
    var reenter = function () { input.value = serialBefore; confirmedSerial = serialBefore; refreshFinanceChoice(); input.focus(); };
    addInvSerial = '';
    if (!serial) {
      if (selectedStatus === 'instock' && canSwitch) {
        var go = await choiceDialog(C.contract_number + ' is In Stock, so it needs its spa — or move it to To Be Ordered.',
          { title: 'Serial cleared', choices: [{ value: 'tbo', label: 'Move to To Be Ordered' }, { value: 're', label: 'Re-enter', primary: true }] });
        if (go === 'tbo') moveToTbo(); else reenter();
      }
      return;
    }
    if (serial.toUpperCase() === String(confirmedSerial || '').toUpperCase()) return;
    var j;
    try { j = await fetch('/api/inventory/serial-exists?serial=' + encodeURIComponent(serial)).then(function (r) { return r.json(); }); }
    catch (e) { return; } // the server checks again on save
    if ((input.value || '').trim() !== serial || !j) return;
    var inHandTbo = selectedStatus === 'tbo' && !canSwitch; // Received / Scheduled from To Be Ordered
    if (j.exists) {
      var u = j.unit || {};
      if (j.linkedTo === C.contract_number) { confirmedSerial = u.serial_number || serial; return; } // its own spa
      if (!j.available) {
        showToast(j.linkedTo ? 'Serial ' + u.serial_number + ' is already sold to ' + j.linkedTo + '.'
          : 'Spa ' + u.serial_number + ' is "' + (u.availability || '') + '" in inventory, not In-stock — it can\'t be sold.', 'error');
        reenter(); return;
      }
      var switching = selectedStatus === 'tbo' && canSwitch;
      var ok = await confirmDialog(spaText(u) + '\n\n' + (switching
          ? 'Switch ' + C.contract_number + ' to In Stock with this spa? The card moves to Assigned when you save.'
          : 'Use this spa? Make, model and colours are filled in from inventory.'),
        { title: 'Spa found in inventory', okText: switching ? 'Switch to In Stock' : 'Use this spa', cancelText: 'Re-enter' });
      if (!ok) { reenter(); return; }
      selectUnit(Object.assign({}, u, { availability: 'In-stock' }), true);
      return;
    }
    // Not in inventory: on To Be Ordered it's a remark; a received spa's serial is only corrected.
    if ((selectedStatus === 'tbo' && !inHandTbo) || C.status === 'received') return;
    var choices = [];
    if (canSwitch) choices.push({ value: 'tbo', label: 'Move to To Be Ordered' });
    choices.push({ value: 're', label: 'Re-enter' }, { value: 'add', label: 'Add to Inventory', primary: true });
    var pick = await choiceDialog(serial + ' isn\'t in Inventory.\n\nAdd to Inventory adds it as Sold to this contract when you save (make, model and colours from this page).',
      { title: 'Serial not found', choices: choices });
    if (pick === 'add') {
      addInvSerial = serial; confirmedSerial = serial;
      $('invTrigger').value = ''; $('invClear').style.display = 'none';
      makeModelFromSpa('');
      refreshFinanceChoice();
      showToast(serial + ' will be added to Inventory as Sold when you save', 'success');
    } else if (pick === 'tbo') moveToTbo();
    else reenter();
  }

  // What the server needs about the spa (ignored unless the user is an admin).
  function spaForm() {
    var serial = ($('prodSerial').value || '').trim(), up = serial.toUpperCase();
    return { status: selectedStatus, serial: serial,
      orderedUnitId: selectedOrderedUnitId || null, // on-order stock picked (asked about already)
      confirmed: !!selectedOrderedUnitId || (!!serial && up === String(confirmedSerial || '').toUpperCase()),
      addToInventory: !!serial && up === addInvSerial.toUpperCase(),
      finance: $('prodFinance') ? $('prodFinance').value : '' };
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
    // New Contract's "Add Image" slots (label + photo) stay for adding images.
    var adder = $('extraImgSlots') && $('extraImgSlots').parentElement;
    card.innerHTML = '<div class="card-header"><i class="fa-solid fa-images"></i>Images</div>'
      + '<p class="helper" style="margin-bottom:10px">' + (closed ? 'Images can\'t be added or removed here once the contract is closed — use Add Image on the contract page.' : 'Tap × to remove an image. Removed and added images are saved with the other changes.') + '</p>'
      + (imgs.length ? '<div class="edit-imgs">' + imgs.map(function (im) {
          var isPdf = /\.pdf$/i.test(im.url), canRemove = !closed && !keep(im.url, im.label);
          return '<div class="edit-img" data-url="' + escHtml(im.url) + '">'
            + (isPdf ? '<a href="' + escHtml(im.url) + '" target="_blank" class="edit-pdf"><i class="fa-solid fa-file-pdf"></i></a>' : '<img src="' + escHtml(im.url) + '" alt="">')
            + '<div class="edit-img-label">' + escHtml(im.label || 'Image') + '</div>'
            + (canRemove ? '<button type="button" class="edit-img-x" title="Remove this image">×</button>' : '')
            + '</div>';
        }).join('') + '</div>' : '<p class="helper">No images.</p>');
    if (adder && !closed) {
      adder.style.marginTop = '16px';
      var title = adder.querySelector('[style*="font-weight:500"]'), help = adder.querySelector('.helper');
      if (title) title.textContent = 'Add images';
      if (help) help.textContent = 'Each new image needs a label (e.g. Waiver, Site Photo)';
      card.appendChild(adder);
    }
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

  // New images from the Add image slots: [{ file, label }], or { error }.
  function newImages() {
    var out = [];
    for (var i = 1; i <= extraImgCount; i++) {
      var f = $('extraImg' + i), l = $('extraLabel' + i);
      if (!f || !f.files[0]) continue;
      var label = (l && l.value || '').trim();
      if (!label) { if (l) l.focus(); return { error: 'Enter a label for each new image' }; }
      out.push({ file: f.files[0], label: label });
    }
    return out;
  }

  async function saveEdit(c) {
    var btn = $('editSaveBtn'), reason = ($('editReason').value || '').trim();
    if (!reason) { showToast('Enter the reason for the change', 'error'); $('editReason').focus(); return; }
    var imgs = newImages();
    if (imgs.error) { showToast(imgs.error, 'error'); return; }
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    try {
      var form = collectData();
      form.spa = spaForm();
      var payload = { form: form, reason: reason, removeImages: Object.keys(removeImages), newImageLabels: imgs.map(function (x) { return x.label; }) };
      var files = [];
      for (var k = 0; k < imgs.length; k++) files.push(await shrinkPhoto(imgs[k].file)); // same as New Contract
      var send = async function () {
        if (!files.length) {
          return fetch('/api/contracts/' + c.id + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        }
        var fd = new FormData();
        fd.append('payload', JSON.stringify(payload));
        files.forEach(function (f) { fd.append('newImages', f); });
        return fetch('/api/contracts/' + c.id + '/edit', { method: 'POST', body: fd });
      };
      var r = await send();
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 409 && j.needsConfirm) {
        // The server found a spa to link that wasn't confirmed on the page.
        if (!(await confirmDialog(j.message, { title: 'Link to inventory?', okText: 'Proceed' }))) throw new Error('Not saved');
        form.spa.confirmed = true;
        r = await send();
        j = await r.json().catch(function () { return {}; });
      }
      if (!r.ok) throw new Error(j.error || 'Failed to save');
      var msg = 'Saved' + (j.movedTo ? ' — card moved to ' + j.movedTo : '')
        + (j.totals ? ' — Grand Total $' + j.totals.grandTotal.toFixed(2) + ', balance $' + Number(j.balance).toFixed(2) : '');
      if (j.owesWhileScheduled) msg += ' — this scheduled delivery now owes money';
      showToast(msg, j.owesWhileScheduled ? 'error' : 'success');
      setTimeout(function () { location.href = '/contracts/' + c.id; }, j.owesWhileScheduled ? 2500 : 900);
    } catch (e) {
      showToast(e.message, 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Save changes';
    }
  }
})();
