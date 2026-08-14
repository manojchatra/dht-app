/**
 * acknowledgementPDF.js — Delivery Acknowledgement PDF generator
 * Uses pdfmake (already a project dependency)
 */
const PdfPrinter = require('pdfmake');
const fs         = require('fs');
const path       = require('path');

const TICK_B64 = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAARVJREFUeNpiYKAxYIQxbLb6BACpeiA2oNDMC0BceMR7ywG4BVDD1yMp+ECm4QpQDAKOIEtYoJx+KJ0IFFxAifOBjk0AUvOhZhoyIdl8gFLDQQBqxgVYUDPRKG7hQUyxBdZbfRxAGJc8E4WGg8J7PwgD2QZUtcAaEZmwlPeAahZgMdzxqPeWD1SxgBTDQYAFhyECUEMeADUXkms4Ph+AIgyUuwuAhs4n13CcFhyFlCOwTJcANHw/OYbjjQOgAYlIljiQYzjBSEazhGTDiUpFUEscyTEcZyrCESdkAVoVdjS3QADdAlA54mCDp1QkscIxgCYKeBw0QtP5fqCCAxS63ADJTIxKvx+pTiUXPIBW+hsY6AEAAgwACPd1SF/05UsAAAAASUVORK5CYII=";

const LOGO_B64 = "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";

const FONTS = {
  Roboto: {
    normal:      path.join(__dirname,'../node_modules/pdfmake/build/vfs_fonts.js').replace('vfs_fonts.js','') + '../fonts/Roboto-Regular.ttf',
    bold:        path.join(__dirname,'../node_modules/pdfmake/build/vfs_fonts.js').replace('vfs_fonts.js','') + '../fonts/Roboto-Medium.ttf',
    italics:     path.join(__dirname,'../node_modules/pdfmake/build/vfs_fonts.js').replace('vfs_fonts.js','') + '../fonts/Roboto-Italic.ttf',
    bolditalics: path.join(__dirname,'../node_modules/pdfmake/build/vfs_fonts.js').replace('vfs_fonts.js','') + '../fonts/Roboto-MediumItalic.ttf',
  }
};

const C = {
  blue:'#1e3a5f', accent:'#2563eb', border:'#d1d5db',
  green:'#059669', grey:'#6b7280', light:'#f3f4f6', dark:'#111827'
};

function tick(on) {
  if (on) {
    return { image: 'data:image/png;base64,' + TICK_B64, width: 10, height: 10, margin: [0,1,0,0] };
  }
  return { canvas: [{ type:'rect', x:0, y:2, w:10, h:10, lineWidth:1.5, lineColor:C.grey, r:2 }], margin:[0,1,0,0] };
}

function row2(label, value) {
  return [
    { text: label, fontSize: 8, color: C.grey, margin:[0,2,4,2] },
    { text: value || '—', fontSize: 8, bold: true, color: C.dark, margin:[0,2,0,2] }
  ];
}

function sHead(title) {
  return {
    text: title, fontSize: 8, bold: true, color: C.blue,
    margin: [0,7,0,4], decoration: 'underline'
  };
}

async function generateAcknowledgementPDF({ contract, formData, customerSigPath, teamSigPath, exImgPaths, customerNameTyped, deliveredBy, outputPath }) {
  const d = JSON.parse(contract.data || '{}');
  const pr = d.product || {};
  const cu = d.customer || {};
  const de = d.details || {};
  const wcType = de.waterCareSystem?.type || '';

  // Parts list by water care system
  const PARTS = {
    'FWSS': [
      'Phosphate Remover','Phosphate Testing Strips','Bag of Salt',
      'Fresh Water Salt Cartridge (3 Nos.)','pH Up','pH Down','Fresh Water Salt Controller'
    ],
    'Ozone': [
      'Ozonator','pH Up','pH Down','Granulated Chlorine 2.5 Lbs',
      'MPS Oxidizer','5 Way Test Strips'
    ],
    'Frog System': [
      'Smart Chlor Mineral Cartridge (Blue)','Frog Test Strips',
      'Frog Jump Start','Smart Chlor (Grey)'
    ],
  };
  const hasFrogHeading = wcType === 'Frog System';

  // Parts checklist rows
  function partsRows() {
    if (!PARTS[wcType]) return [];
    const items = formData.partsChecklist || {};
    const list = PARTS[wcType];
    const rows = [];
    if (hasFrogHeading) {
      rows.push([{ text:'The Whole Kit', fontSize:8, bold:true, color:C.blue, colSpan:4, margin:[0,4,0,2] }, {}, {}, {}]);
    }
    for (let i = 0; i < list.length; i += 2) {
      const left = list[i], right = list[i+1];
      rows.push([
        tick(items[left] !== false), { text:left, fontSize:8, margin:[4,2,4,2] },
        right ? tick(items[right] !== false) : { text:'' },
        right ? { text:right, fontSize:8, margin:[4,2,4,2] } : { text:'' }
      ]);
    }
    return rows;
  }

  // Items delivered rows
  const ITEMS = [
    ['hotTub','Hot Tub'],['cover','Cover'],['steps','Steps'],['coverLifter','Cover Lifter'],
    ['freshWaterSalt','FreshWater Salt System'],['freshWaterIQ','FreshWater IQ Monitoring'],
    ['autoDosing','Auto Dosing'],['subpanel','Subpanel'],
    ['startupChemicals','Start-Up Chemicals'],['ownersManual',"Owner's Manual"],['other','Other'],
  ];
  const itemsDelivered = formData.itemsDelivered || {};

  // Load signature images as base64
  function imgB64(p) {
    if (!p || !fs.existsSync(p)) return null;
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  }
  const custSig = imgB64(customerSigPath);
  const teamSig = imgB64(teamSigPath);

  const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

  const docDef = {
    pageSize: 'LETTER', pageMargins: [36,40,36,40],
    defaultStyle: { font:'Roboto', fontSize:9, color:C.dark },
    images: { logo: 'data:image/png;base64,' + LOGO_B64 },
    content: [
      // Header
      {
        columns:[
          { image:'logo', width:90, margin:[0,0,0,0] },
          { text:'Delivery Acknowledgement', fontSize:12, bold:true, color:C.accent, alignment:'right', margin:[0,4,0,0] }
        ], margin:[0,0,0,4]
      },
      { canvas:[{type:'line',x1:0,y1:0,x2:523,y2:0,lineWidth:1.5,lineColor:C.blue}], margin:[0,0,0,10] },

      // Contract + Date info
      {
        columns:[
          { text:'Contract #: '+contract.contract_number, fontSize:8, bold:true },
          { text:'Date: '+today, fontSize:8, alignment:'right', color:C.grey }
        ], margin:[0,0,0,8]
      },

      // Customer + Hot Tub info side by side
      {
        columns:[
          {
            width:'50%',
            stack:[
              sHead('CUSTOMER'),
              { table:{ widths:['35%','65%'], body:[
                row2('Name', customerNameTyped || cu.name),
                row2('Address', (cu.address||'')+(cu.city?', '+cu.city:'')+(cu.zip?' '+cu.zip:'')),
                row2('Phone', cu.phone?.cell||cu.phone?.home||''),
                row2('Delivery Date', contract.delivery_date||today),
              ]}, layout:'noBorders' }
            ]
          },
          {
            width:'50%',
            stack:[
              sHead('HOT TUB'),
              { table:{ widths:['35%','65%'], body:[
                row2('Make / Model', (pr.make||'')+' '+(pr.model||'')),
                row2('Year', pr.year||''),
                row2('Serial #', contract.serial_number||pr.serialNumber||''),
                row2('Shell / Cabinet', (pr.shellColor||'')+(pr.cabinetColor?' / '+pr.cabinetColor:'')),
                row2('Cover', pr.coverColor||''),
              ]}, layout:'noBorders' }
            ]
          }
        ], margin:[0,0,0,8]
      },

      // Items Delivered
      sHead('ITEMS DELIVERED'),
      (function(){
        var im = ITEMS;
        function irow(a,b){return [tick(itemsDelivered[im[a][0]]),{text:im[a][1],fontSize:8,margin:[4,2,4,2]},tick(itemsDelivered[im[b][0]]),{text:im[b][1],fontSize:8,margin:[4,2,4,2]}];}
        return { table:{
          widths: [12,'38%',12,'*'],
          body: [irow(0,1),irow(2,3),irow(4,5),irow(6,7),irow(8,9),
            [tick(itemsDelivered[im[10][0]]),{text:im[10][1],fontSize:8,margin:[4,2,4,2]},{text:''},{text:''}]
          ],
          dontBreakRows: true
        }, layout:'noBorders', margin:[0,0,0,8] };
      })(),

      // Product Details
      sHead('PRODUCT DETAILS'),
      { table:{ widths:['33%','33%','34%'], body:[[
        { text:'Steps Model: '+(formData.stepsModel||'—'), fontSize:8 },
        { text:'Cover Lifter: '+(formData.coverLifter||'—'), fontSize:8 },
        { text:'Water Care Installed: '+(formData.waterCareInstalled||'—'), fontSize:8 },
      ]]}, layout:'noBorders', margin:[0,0,0,8] },

      // Water Care Parts (conditional)
      ...(PARTS[wcType] ? [
        sHead('WATER CARE PARTS' + (hasFrogHeading ? ' — FROG SYSTEM' : ' — '+ wcType.toUpperCase())),
        { table:{ widths:[12,'38%',12,'*'], body: partsRows(), dontBreakRows:true }, layout:'noBorders', margin:[0,0,0,8] }
      ] : []),

      // Acknowledgements
      sHead('ACKNOWLEDGEMENTS'),
      {
        stack: [
          { table:{ widths:[12,'*'], body:[
            [tick(formData.acks?.allReceived),{text:'All items listed above have been received',fontSize:8,margin:[4,3,0,3]}],
            [tick(formData.acks?.goodCondition),{text:'All items are in good condition',fontSize:8,margin:[4,3,0,3]}],
            [tick(formData.acks?.orientationCompleted),{text:'Product orientation / demo completed',fontSize:8,margin:[4,3,0,3]}],
          ]}, layout:'noBorders', margin:[0,2,0,8] },
        ], margin:[0,0,0,8]
      },

      // Exceptions
      ...(formData.exceptions ? [
        sHead('EXCEPTIONS / DAMAGE / MISSING'),
        { text: formData.exceptions, fontSize:8, margin:[0,0,0,8] }
      ] : []),

      // Signatures
      sHead('SIGNATURES'),
      {
        columns:[
          {
            width:'48%',
            stack:[
              custSig ? { image:custSig, width:200, height:60, margin:[0,0,0,4] }
                      : { canvas:[{type:'rect',x:0,y:0,w:200,h:60,lineWidth:0.5,lineColor:C.border}], margin:[0,0,0,4] },
              { canvas:[{type:'line',x1:0,y1:0,x2:220,y2:0,lineWidth:0.5,lineColor:C.border}] },
              { text: customerNameTyped || 'Customer', fontSize:8, color:C.grey, margin:[0,3,0,0] },
              { text:'Customer Signature', fontSize:7, color:C.grey }
            ]
          },
          { width:'4%', text:'' },
          {
            width:'48%',
            stack:[
              teamSig ? { image:teamSig, width:200, height:60, margin:[0,0,0,4] }
                      : { canvas:[{type:'rect',x:0,y:0,w:200,h:60,lineWidth:0.5,lineColor:C.border}], margin:[0,0,0,4] },
              { canvas:[{type:'line',x1:0,y1:0,x2:220,y2:0,lineWidth:0.5,lineColor:C.border}] },
              { text: deliveredBy || 'Delivery Team', fontSize:8, color:C.grey, margin:[0,3,0,0] },
              { text:'Delivered By', fontSize:7, color:C.grey }
            ]
          }
        ], margin:[0,0,0,12]
      },

      // Footer
      { canvas:[{type:'line',x1:0,y1:0,x2:523,y2:0,lineWidth:0.5,lineColor:C.border}] },
      { text:'Desert Hot Tubs — www.deserthottubs.com', fontSize:7, color:C.grey, alignment:'center', margin:[0,4,0,0] }
    ]
  };

  return new Promise((resolve, reject) => {
    try {
      const vfsFonts = require('pdfmake/build/vfs_fonts');
      const vfs = vfsFonts.pdfMake ? vfsFonts.pdfMake.vfs : vfsFonts;
      const printer = new PdfPrinter({ Roboto:{
        normal:     Buffer.from(vfs['Roboto-Regular.ttf'], 'base64'),
        bold:       Buffer.from(vfs['Roboto-Medium.ttf'],  'base64'),
        italics:    Buffer.from(vfs['Roboto-Italic.ttf'],  'base64'),
        bolditalics:Buffer.from(vfs['Roboto-MediumItalic.ttf'],'base64'),
      }});
      const doc = printer.createPdfKitDocument(docDef);
      const chunks = [];
      doc.on('data', d => chunks.push(d));
      doc.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(outputPath, buf);
        resolve(buf);
      });
      doc.on('error', reject);
      doc.end();
    } catch(e) { reject(e); }
  });
}

module.exports = { generateAcknowledgementPDF };
