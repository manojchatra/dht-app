/**
 * pdfGenerator.js — Desert Hot Tubs Purchase Contract PDF
 * Design: new checkbox style, selected-only options, color chips, full-width payment
 */
const pdfMake  = require('pdfmake/build/pdfmake');
const vfsFonts = require('pdfmake/build/vfs_fonts');
pdfMake.vfs = vfsFonts.pdfMake ? vfsFonts.pdfMake.vfs : vfsFonts;

const LOGO_B64 = "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";
const TICK_B64 = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAARVJREFUeNpiYKAxYIQxbLb6BACpeiA2oNDMC0BceMR7ywG4BVDD1yMp+ECm4QpQDAKOIEtYoJx+KJ0IFFxAifOBjk0AUvOhZhoyIdl8gFLDQQBqxgVYUDPRKG7hQUyxBdZbfRxAGJc8E4WGg8J7PwgD2QZUtcAaEZmwlPeAahZgMdzxqPeWD1SxgBTDQYAFhyECUEMeADUXkms4Ph+AIgyUuwuAhs4n13CcFhyFlCOwTJcANHw/OYbjjQOgAYlIljiQYzjBSEazhGTDiUpFUEscyTEcZyrCESdkAVoVdjS3QADdAlA54mCDp1QkscIxgCYKeBw0QtP5fqCCAxS63ADJTIxKvx+pTiUXPIBW+hsY6AEAAgwACPd1SF/05UsAAAAASUVORK5CYII=";

const C = {
  dark:'#111827', grey:'#9ca3af', border:'#d1d5db',
  amber:'#fef3c7', amberTxt:'#92400e',
  green:'#16a34a', greenFill:'#dcfce7',
  blue:'#1e40af', red:'#dc2626',
  sectionBg:'#e5e7eb',
};

// ── Format an ISO (YYYY-MM-DD) date as US M-DD-YYYY ───────────────────────────
function fmtUSDate(iso) {
  if (!iso) return iso;
  const p = String(iso).split('-');
  if (p.length !== 3) return iso;
  return parseInt(p[1], 10) + '-' + p[2] + '-' + p[0];
}

// ── Checkbox: PNG tick for checked, hidden completely for unchecked ──────────
function cb(label, checked, opts={}) {
  const sz = opts.size || 7.5;
  if (checked) {
    return {
      columns:[
        { image:'tick', width:10, height:10, margin:[0,1,0,0] },
        { text:label, fontSize:sz, color:C.dark, bold:true, margin:[4,1,0,0] },
      ],
      columnGap:0,
      margin:[0,2,opts.gap||10,2],
    };
  }
  // Unchecked — completely hidden, zero width
  return { text:'', width:0, margin:[0,0,0,0] };
}

// ── Show only selected options as joined text ─────────────────────────────────
function selectedOnly(items) {
  const active = items.filter(i=>i.on).map(i=>i.label);
  if (!active.length) return { text:'\u2014', fontSize:8, color:C.grey };
  return { text:active.join('  \u00B7  '), fontSize:8, bold:true, color:C.dark };
}

// ── Included badge: PNG tick + label for yes, dash for no ────────────────────
function includedBadge(yes) {
  if (yes) return {
    columns:[
      { image:'tick', width:11, height:11, margin:[0,1,0,0] },
      { text:'Included', fontSize:7, bold:true, color:C.green, margin:[4,2,0,0] },
    ],
    columnGap:0,
  };
  return { text:'\u2014', fontSize:8, color:C.grey, alignment:'center' };
}

// ── Color: show selected value only ──────────────────────────────────────────
function colorChip(value) {
  if (!value || value === 'Others') return { text: value || '\u2014', fontSize:8, color:C.grey };
  return {
    table:{ widths:['*'], body:[[{
      text:value, fontSize:8, bold:true, color:C.amberTxt,
      fillColor:C.amber, alignment:'center', margin:[8,3,8,3],
      border:[false,false,false,false],
    }]]}, layout:'noBorders', margin:[0,2,0,2],
  };
}

// ── Section head ──────────────────────────────────────────────────────────────
function sHead(title, opts={}) {
  return {
    table:{ widths:['*'], body:[[{
      text:title, fontSize:6.5, bold:true, color:C.dark,
      fillColor:C.sectionBg, margin:[4,2,4,2],
    }]]},
    layout:{ hLineColor:()=>C.border, vLineColor:()=>C.border },
    margin: opts.margin || [0,4,0,3],
  };
}

// ── Key-value ─────────────────────────────────────────────────────────────────
function kv(label, value, opts={}) {
  return {
    stack:[
      { text:label, fontSize:6, color:C.grey, margin:[0,1,0,0] },
      { text:value||'\u2014', fontSize:opts.size||8, bold:opts.bold||false,
        color:opts.color||C.dark, margin:[0,0,0,3] },
    ],
  };
}

// ── Payment row: PNG tick for selected, invisible for unselected ──────────────
function payRow(label, selected, detail, amount) {
  const iconCell = selected
    ? { image:'tick', width:12, height:12, margin:[0,2,0,0] }
    : { text:'', width:14, margin:[0,2,0,0] };
  return [
    iconCell,
    { text:label, fontSize:8, bold:selected, color:selected?C.dark:C.grey, margin:[6,3,0,3] },
    { text:detail||'', fontSize:8, color:selected?C.dark:C.grey, margin:[0,3,0,3] },
    { text:amount||'', fontSize:8, bold:selected, color:selected?C.green:C.grey,
      alignment:'right', margin:[0,3,4,3] },
  ];
}

// ── Main generator ────────────────────────────────────────────────────────────
async function generateContractPDF(contract) {
  const d   = contract.data || {};
  const cu  = d.customer    || {};
  const pr  = d.product     || {};
  const wa  = d.warranty    || {};
  const sv  = d.service     || {};
  const el  = d.electrical  || {};
  const mi  = d.misc        || {};
  const de  = d.details     || {};
  const co  = d.costing     || {};
  const pa  = d.payment     || {};
  const mfg = wa.manufacturer || {};
  const dlr = wa.dealership   || {};

  const STORES=[
    { name:'Phoenix',  addr:'20635 N Cave Creek Rd' },
    { name:'Goodyear', addr:'725 Estrella Pkwy #120' },
    { name:'Chandler', addr:'1400 S Arizona Ave #9' },
    { name:'Surprise', addr:'15278 W Bell Rd #112' },
    { name:'Tolleson', addr:'9897 W McDowell Rd' },
  ];

  // Address line — city state zip all captured
  const addressLine = [cu.address, cu.city, cu.state||'AZ', cu.zip].filter(Boolean).join(', ');

  const docDef = {
    pageSize:'A4', pageMargins:[26,26,26,26],
    defaultStyle:{ font:'Roboto', fontSize:8, color:C.dark, lineHeight:1.2 },
    images:{ logo:`data:image/png;base64,${LOGO_B64}`, tick:`data:image/png;base64,${TICK_B64}` },
    content:[

      // ── HEADER ─────────────────────────────────────────────────────────────
      { columns:[
        { image:'logo', width:130, margin:[0,2,0,0] },
        { stack:[
          { text:'PURCHASE CONTRACT', fontSize:13, bold:true, color:C.blue, alignment:'center' },
          { text:'Desert Hot Tubs', fontSize:8, color:C.grey, alignment:'center', margin:[0,2,0,0] },
        ], alignment:'center' },
        { stack:[
          { text:`Contract #: ${contract.contract_number||'\u2014'}`, fontSize:7.5, alignment:'right', bold:true },
          { text:`Date: ${d.date?fmtUSDate(d.date):'\u2014'}`, fontSize:7.5, alignment:'right', margin:[0,2,0,0] },
          { text:`Delivery: ${d.deliveryDate?fmtUSDate(d.deliveryDate):'TBD'}`, fontSize:7.5, alignment:'right' },
          { text:`Salesman: ${d.salesman||'\u2014'}`, fontSize:7.5, alignment:'right' },
        ]},
      ], margin:[0,0,0,6] },

      // ── STORES ─────────────────────────────────────────────────────────────
      { table:{ widths:Array(5).fill('*'), body:[STORES.map(s=>({
          stack:[
            { text:s.name, fontSize:7.5, bold:s.name===d.store, alignment:'center',
              color:s.name===d.store?C.amberTxt:C.grey },
            { text:s.addr, fontSize:5.5, alignment:'center',
              color:s.name===d.store?'#a16207':C.grey, margin:[0,1,0,0] },
          ],
          fillColor: s.name===d.store?C.amber:undefined,
          margin:[2,4,2,4],
        }))]},
        layout:{ hLineColor:()=>C.border, vLineColor:()=>C.border,
                 hLineWidth:()=>0.5, vLineWidth:()=>0.5 },
        margin:[0,0,0,5] },

      // ── CUSTOMER + PRODUCT ─────────────────────────────────────────────────
      { columns:[
        { width:'45%', stack:[
          sHead('CUSTOMER DETAILS', {margin:[0,0,0,3]}),
          kv('CUSTOMER NAME', cu.name, {bold:true}),
          kv('ADDRESS', addressLine),
          kv('EMAIL', cu.email),
          { columns:[kv('PHONE (HOME)',cu.phone&&cu.phone.home), kv('WORK',cu.phone&&cu.phone.work), kv('CELL',cu.phone&&cu.phone.cell)], columnGap:6 },
          kv('HOW DID YOU HEAR ABOUT US', cu.heardAbout),
          { columns:[
            kv('GATED', cu.gated?'Yes':'No'),
            cu.gated && cu.gateCode ? kv('GATE CODE', cu.gateCode) : {text:''},
          ], columnGap:6 },
        ]},
        { width:8, text:'' },
        { width:'*', stack:[
          sHead('PRODUCT DETAILS', {margin:[0,0,0,3]}),
          { columns:[
            cb('In Stock',      pr.status==='instock'),
            cb('To Be Ordered', pr.status==='tbo'),
            cb('Special Order', pr.status==='special'),
          ], margin:[0,0,0,4] },
          kv('FLOOR MODEL LOCATION', pr.floorModel),
          { columns:[kv('MAKE',pr.make), kv('SERIES',pr.series), kv('MODEL',pr.model)], columnGap:6 },
          { columns:[kv('YEAR',pr.year), kv('SERIAL NUMBER',pr.serialNumber,{bold:true})], columnGap:6 },
          { columns:[
            kv('SHELL COLOR', ''), kv('CABINET COLOR', ''), kv('COVER COLOR', ''),
          ], columnGap:6 },
          { columns:[
            colorChip(pr.shellColor||(pr.shellColorOther||'')),
            colorChip(pr.cabinetColor||(pr.cabinetColorOther||'')),
            colorChip(pr.coverColor||(pr.coverColorOther||'')),
          ], columnGap:6 },
          { columns:[
            cb('Speaker Included', pr.included&&pr.included.speaker),
            cb('Music Included',   pr.included&&pr.included.music),
          ], margin:[0,4,0,0] },
        ]},
      ], margin:[0,0,0,4] },

      // ── WARRANTY ───────────────────────────────────────────────────────────
      sHead('WARRANTY'),
      { columns:[
        { width:'48%', stack:[
          { text:'Manufacturer Warranty', fontSize:7, bold:true, margin:[0,0,0,3] },
          { columns:[
            cb('HotSpring',(mfg.brands||[]).includes('HotSpring')),
            cb('Caldera',  (mfg.brands||[]).includes('Caldera')),
            cb('WLA',      (mfg.brands||[]).includes('WLA')),
            cb('EP',       (mfg.brands||[]).includes('EP')),
          ]},
          { columns:[
            kv('COMPONENTS', mfg.componentYrs?mfg.componentYrs+' yrs':''),
            kv('SHELL',      mfg.shellYrs?mfg.shellYrs+' yrs':''),
            kv('EXT. WARRANTY', mfg.extWarrantyYrs?mfg.extWarrantyYrs+' yrs':''),
          ], columnGap:8 },
        ]},
        { width:8, text:'' },
        { width:'*', stack:[
          { text:'EMP / Dealership Warranty', fontSize:7, bold:true, margin:[0,0,0,3] },
          { columns:[
            cb('HotSpring',(dlr.brands||[]).includes('HotSpring')),
            cb('Caldera',  (dlr.brands||[]).includes('Caldera')),
            cb('WLA',      (dlr.brands||[]).includes('WLA')),
            cb('EP',       (dlr.brands||[]).includes('EP')),
          ]},
          { columns:[
            kv('COMPONENTS', dlr.componentYrs?dlr.componentYrs+' yrs':''),
            kv('SHELL',      dlr.shellYrs?dlr.shellYrs+' yrs':''),
            kv('EXT. WARRANTY', dlr.extWarrantyYrs?dlr.extWarrantyYrs+' yrs':''),
          ], columnGap:8 },
        ]},
      ], margin:[0,0,0,4] },

      // ── SERVICE + ELECTRICAL ───────────────────────────────────────────────
      sHead('SERVICE & ELECTRICAL'),
      { columns:[
        { width:'50%', stack:[
          { text:'Service', fontSize:7, bold:true, margin:[0,0,0,3] },
          { columns:[ cb('In-Town Delivery',sv.inTownDelivery), cb('Crane',sv.crane) ]},
          sv.craneFee?{ text:'Crane Fee: $'+sv.craneFee, fontSize:7, color:C.dark, margin:[0,1,0,3] }:{text:''},
          sv.outOfTownDelivery
            ? cb('Out-of-Town Delivery: $'+(sv.outOfTownDeliveryFee||'\u2014'), true)
            : cb('Out-of-Town Delivery', false),
          sv.outOfTownWarranty
            ? cb('Out-of-Town Warranty: $'+(sv.outOfTownWarrantyFee||'\u2014'), true)
            : cb('Out-of-Town Warranty', false),
        ]},
        { width:'*', stack:[
          { text:'Electrical', fontSize:7, bold:true, margin:[0,0,0,3] },
          cb('Pre-Delivery Pamphlet Provided', el.pamphletProvided),
          cb('Own Electrician & Signed Waiver', el.ownElectrician),
          el.notes?{ text:'Note: '+el.notes, fontSize:7, color:C.dark, margin:[0,3,0,0] }:{text:''},
        ]},
      ], margin:[0,0,0,4] },

      // ── MISC ───────────────────────────────────────────────────────────────
      (mi.notes||mi.monthlyCleanings)?[
        sHead('MISCELLANEOUS'),
        { columns:[
          mi.notes?{ text:mi.notes, fontSize:7.5, width:'65%' }:{text:'',width:'65%'},
          { width:'*', columns:[
            cb('Monthly Cleanings',mi.monthlyCleanings),
            mi.monthlyCleanings&&mi.cleaningPrice?{text:'$'+mi.cleaningPrice+'/mo',fontSize:7.5}:{text:''},
          ]},
        ], margin:[0,0,0,4] },
      ]:{text:''},

      // ── DETAILS TABLE ──────────────────────────────────────────────────────
      sHead('DETAILS & LINE ITEMS'),
      { table:{ widths:['*',150,52,80], headerRows:1, body:[
        [
          {text:'ITEM',fontSize:6.5,bold:true,fillColor:C.sectionBg,margin:[3,2,3,2]},
          {text:'SELECTED OPTIONS',fontSize:6.5,bold:true,fillColor:C.sectionBg,margin:[3,2,3,2]},
          {text:'PRICE',fontSize:6.5,bold:true,fillColor:C.sectionBg,alignment:'right',margin:[3,2,3,2]},
          {text:'INCLUDED',fontSize:6.5,bold:true,fillColor:C.sectionBg,alignment:'center',margin:[3,2,3,2]},
        ],
        // Spa
        [
          {text:'Spa \u2014 '+(pr.make||'')+' '+(pr.model||'')+(pr.serialNumber?' ('+pr.serialNumber+')':''),fontSize:8,margin:[3,5,3,5]},
          {text:'',margin:[3,5,3,5]},
          {text:de.spaPrice?'$'+de.spaPrice:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.spaIncluded)],margin:[3,3,3,3]},
        ],
        // Cover
        [
          {text:'U.L. Rated Matching Cover',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'F/B',on:(de.cover&&de.cover.coverType||[]).includes('F/B')},
            {label:'S/S',on:(de.cover&&de.cover.coverType||[]).includes('S/S')},
            {label:de.cover&&de.cover.brand||'',on:!!(de.cover&&de.cover.brand)},
            {label:de.cover&&de.cover.lift||'',on:!!(de.cover&&de.cover.lift)},
            {label:de.cover&&de.cover.otherLift||'',on:!!(de.cover&&de.cover.otherLift)},
          ].filter(i=>i.label))],margin:[3,5,3,5]},
          {text:de.cover&&de.cover.price?'$'+de.cover.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.cover&&de.cover.included)],margin:[3,3,3,3]},
        ],
        // Steps
        [
          {text:'Matching Steps',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'HLStep',on:de.steps&&de.steps.type==='HLStep'},
            {label:'EWStep',on:de.steps&&de.steps.type==='EWStep'},
            {label:'PolyStep',on:de.steps&&de.steps.type==='PolyStep'},
            {label:'DuraStep',on:de.steps&&de.steps.type==='DuraStep'},
          ])],margin:[3,5,3,5]},
          {text:de.steps&&de.steps.price?'$'+de.steps.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.steps&&de.steps.included)],margin:[3,3,3,3]},
        ],
        // Subpanel
        [
          {text:'Subpanel Provided',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'Yes',on:de.subpanel&&de.subpanel.provided===true},
            {label:'No',on:de.subpanel&&de.subpanel.provided===false},
            {label:(de.subpanel&&de.subpanel.amperage||'')+' Amp',on:!!(de.subpanel&&de.subpanel.amperage)},
          ].filter(i=>i.label))],margin:[3,5,3,5]},
          {text:de.subpanel&&de.subpanel.price?'$'+de.subpanel.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.subpanel&&de.subpanel.included)],margin:[3,3,3,3]},
        ],
        // Water Care System
        [
          {text:'Water Care System',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'FWSS',         on:de.waterCareSystem&&de.waterCareSystem.type==='FWSS'},
            {label:'Ozone',        on:de.waterCareSystem&&de.waterCareSystem.type==='Ozone'},
            {label:'Frog System',  on:de.waterCareSystem&&de.waterCareSystem.type==='Frog System'},
            {label:'EZ Care',      on:de.waterCareSystem&&de.waterCareSystem.type==='EZ Care'},
            {label:'None',         on:de.waterCareSystem&&de.waterCareSystem.type==='None'},
          ])],margin:[3,5,3,5]},
          {text:de.waterCareSystem&&de.waterCareSystem.price?'$'+de.waterCareSystem.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.waterCareSystem&&de.waterCareSystem.included)],margin:[3,3,3,3]},
        ],
        // Upgraded Water Care (only when FWSS selected)
        ...((de.upgradedWaterCare&&(de.upgradedWaterCare.autoDosing||de.upgradedWaterCare.fwssIq))?[[
          {text:'Upgraded Water Care',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'Auto Dosing System',on:de.upgradedWaterCare.autoDosing},
            {label:'FWSS/IQ',           on:de.upgradedWaterCare.fwssIq},
          ])],margin:[3,5,3,5]},
          {text:de.upgradedWaterCare.price?'$'+de.upgradedWaterCare.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.upgradedWaterCare.included)],margin:[3,3,3,3]},
        ]]:[]),
        // Startup
        [
          {text:'StartUp Chemicals',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'Yes',on:de.startupChemicals&&de.startupChemicals.yes===true},
            {label:'No', on:de.startupChemicals&&de.startupChemicals.yes===false},
          ])],margin:[3,5,3,5]},
          {text:de.startupChemicals&&de.startupChemicals.price?'$'+de.startupChemicals.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.startupChemicals&&de.startupChemicals.included)],margin:[3,3,3,3]},
        ],
        // CoolZone
        ...(de.coolZone&&de.coolZone.yes?[[
          {text:'CoolZone',fontSize:8,margin:[3,5,3,5]},
          {stack:[selectedOnly([
            {label:'Yes',on:true},
            {label:'Ext. Warranty',on:de.coolZone.extWarranty},
          ].filter(i=>i.on))],margin:[3,5,3,5]},
          {text:de.coolZone.price?'$'+de.coolZone.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {text:'',margin:[3,5,3,5]},
        ]]:[]),
        // Accessories
        ...((de.accessories&&(de.accessories.items&&de.accessories.items.length||de.accessories.other))?[[
          {text:'Accessories',fontSize:8,margin:[3,5,3,5]},
          {text:[...(de.accessories.items||[]),de.accessories.other||''].filter(Boolean).join(' \u00B7 '),
           fontSize:8,bold:true,color:C.dark,margin:[3,5,3,5]},
          {text:de.accessories.price?'$'+de.accessories.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {stack:[includedBadge(de.accessories.included)],margin:[3,3,3,3]},
        ]]:[]),
        // Spa Removal
        ...((de.spaRemoval&&de.spaRemoval.yes)?[[
          {text:'Spa Removal',fontSize:8,margin:[3,5,3,5]},
          {text:'Yes',fontSize:8,bold:true,color:C.dark,margin:[3,5,3,5]},
          {text:de.spaRemoval.price?'$'+de.spaRemoval.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {text:'',margin:[3,5,3,5]},
        ]]:[]),
        // Fuel Surcharge
        ...((de.fuelSurcharge&&de.fuelSurcharge.yes)?[[
          {text:'Fuel Surcharge',fontSize:8,margin:[3,5,3,5]},
          {text:'Yes',fontSize:8,bold:true,color:C.dark,margin:[3,5,3,5]},
          {text:de.fuelSurcharge.price?'$'+de.fuelSurcharge.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {text:'',margin:[3,5,3,5]},
        ]]:[]),
        // Concierge Service (post-tax)
        ...((de.concierge&&de.concierge.yes)?[[
          {text:'Concierge Service',fontSize:8,margin:[3,5,3,5]},
          {text:'Yes',fontSize:8,bold:true,color:C.dark,margin:[3,5,3,5]},
          {text:de.concierge.price?'$'+de.concierge.price:'\u2014',fontSize:8,alignment:'right',margin:[3,5,3,5]},
          {text:'',margin:[3,5,3,5]},
        ]]:[]),
      ]},
      layout:{ hLineColor:()=>C.border, vLineColor:()=>C.border,
               hLineWidth:()=>0.4, vLineWidth:()=>0.4 },
      margin:[0,0,0,5] },

      // ── COSTING (full width) ───────────────────────────────────────────────
      sHead('COSTING'),
      { table:{ widths:['*',140], body:[
        co.subtotal    ?[{text:'Subtotal',fontSize:8},{text:'$'+co.subtotal,fontSize:8,alignment:'right'}]:null,
        co.taxAmount   ?[{text:'Tax ('+(co.taxPercent||'')+'%)',fontSize:8},{text:'$'+co.taxAmount,fontSize:8,alignment:'right'}]:null,
        co.productTotal?[{text:'Product Total',fontSize:8},{text:'$'+co.productTotal,fontSize:8,alignment:'right'}]:null,
        co.serviceTotal?[{text:'Service Total',fontSize:8},{text:'$'+co.serviceTotal,fontSize:8,alignment:'right'}]:null,
        [{text:'GRAND TOTAL',fontSize:10,bold:true,color:C.blue},{text:co.grandTotal?'$'+co.grandTotal:'\u2014',fontSize:10,bold:true,alignment:'right',color:C.blue}],
      ].filter(Boolean)},
      layout:{ hLineColor:()=>C.border, vLineColor:()=>'white', hLineWidth:()=>0.4 },
      margin:[0,0,0,8] },

      // ── PAYMENT (full width) ───────────────────────────────────────────────
      sHead('PAYMENT'),
      { table:{ widths:[16,90,'*',90], body:[
        payRow('Cheque', pa.cheque&&pa.cheque.selected,
               pa.cheque&&pa.cheque.selected&&pa.cheque.number?'Cheque #'+pa.cheque.number+(pa.cheque.amount?' \u00B7 $'+pa.cheque.amount:''):'',
               pa.cheque&&pa.cheque.selected&&pa.cheque.amount?'$'+pa.cheque.amount:''),
        payRow('Credit Card', pa.creditCard&&pa.creditCard.selected,
               pa.creditCard&&pa.creditCard.selected&&pa.creditCard.lastFour?'Card ending '+pa.creditCard.lastFour:'',
               pa.creditCard&&pa.creditCard.selected&&pa.creditCard.amount?'$'+pa.creditCard.amount:''),
        payRow('Cash', pa.cash&&pa.cash.selected, pa.cash&&pa.cash.selected&&pa.cash.amount?'$'+pa.cash.amount:'', pa.cash&&pa.cash.selected&&pa.cash.amount?'$'+pa.cash.amount:''),
        payRow('Finance', pa.finance&&pa.finance.selected,
               pa.finance&&pa.finance.selected&&pa.finance.plan?pa.finance.plan:'',
               pa.finance&&pa.finance.selected&&pa.finance.amount?'$'+pa.finance.amount:''),
        pa.depositDays?[
          {text:'',border:[false,false,false,false]},
          {text:'Non-refundable deposit after '+pa.depositDays+' days',fontSize:7.5,color:C.grey,
           colSpan:2,border:[false,false,false,false],margin:[6,3,0,3]},
          {},
          {text:pa.depositAmount?'$'+pa.depositAmount:'',fontSize:7.5,color:C.grey,
           alignment:'right',border:[false,false,false,false],margin:[0,3,4,3]},
        ]:null,
        [
          {text:'',border:[false,true,false,false],borderColor:[C.border,C.border,C.border,C.border]},
          {text:'DUE PRIOR TO DELIVERY',fontSize:9,bold:true,color:C.red,
           colSpan:2,border:[false,true,false,false],
           borderColor:[C.border,C.border,C.border,C.border],margin:[6,5,0,4]},
          {},
          {text:pa.duePriorToDelivery?'$'+pa.duePriorToDelivery:'$0',
           fontSize:10,bold:true,color:parseFloat(pa.duePriorToDelivery||0)>0?C.red:C.dark,
           alignment:'right',border:[false,true,false,false],
           borderColor:[C.border,C.border,C.border,C.border],margin:[0,5,4,4]},
        ],
      ].filter(Boolean)},
      layout:{ hLineColor:()=>C.border, vLineColor:()=>'white', hLineWidth:()=>0.4 },
      margin:[0,0,0,8] },

      // ── TERMS ──────────────────────────────────────────────────────────────
      { canvas:[{type:'line',x1:0,y1:0,x2:515,y2:0,lineWidth:0.4,lineColor:C.border}], margin:[0,2,0,3] },
      { text:"Any additional delivery or set up trips will be at $225 minimum per trip. Any cancellation after the deposit becomes non-refundable will be assessed a minimum charge of 10% of the total sales price. There are no returns or refunds after delivery date. All warranty service calls will be subject to a $50 minimum trip charge. Desert Hot Tubs is not responsible for any verbal agreements outside the terms of this purchase agreement. Customer is required to provide a 110V or 220V electrical installation to the manufacturer\u2019s specifications prior to delivery.",
        fontSize:6.5, color:C.grey, lineHeight:1.4, margin:[0,0,0,8] },

      // ── SIGNATURE ──────────────────────────────────────────────────────────
      { columns:[
        { width:'45%', stack:[
          { canvas:[{type:'line',x1:0,y1:0,x2:200,y2:0,lineWidth:0.7,lineColor:C.dark}] },
          { text:'Customer Signature', fontSize:6.5, color:C.grey, margin:[0,3,0,0] },
        ]},
        { width:'*', text:'' },
        { width:'25%', stack:[
          { canvas:[{type:'line',x1:0,y1:0,x2:120,y2:0,lineWidth:0.7,lineColor:C.dark}] },
          { text:'Date', fontSize:6.5, color:C.grey, margin:[0,3,0,0] },
        ]},
      ]},
    ],
  };

  return new Promise((resolve,reject) => {
    try { pdfMake.createPdf(docDef).getBuffer(buf => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      resolve(b);
    }); }
    catch(err){ reject(err); }
  });
}

module.exports = { generateContractPDF };
