// utils/imageUtils.js — shared image compression utility
'use strict';
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

async function compressImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.jpg','.jpeg','.png','.webp','.heic'].includes(ext)) {
    try {
      const tmpPath = filePath + '.tmp';
      await sharp(filePath)
        .rotate()                          // auto-rotate from EXIF
        .resize(2000, 2000, { fit:'inside', withoutEnlargement:true })
        .jpeg({ quality:80 })
        .toFile(tmpPath);
      fs.renameSync(tmpPath, filePath.replace(/\.[^.]+$/, '.jpg'));
      if (!filePath.endsWith('.jpg')) fs.unlinkSync(filePath);
      return filePath.replace(/\.[^.]+$/, '.jpg');
    } catch(e) { console.error('[sharp compress error]', e.message); return filePath; }
  }
  if (ext === '.pdf') {
    // Ghostscript compression (requires gs to be installed)
    const { execSync } = require('child_process');
    try {
      execSync('gs --version', { stdio:'ignore' });
      const tmpPath = filePath + '.compressed.pdf';
      execSync(
        'gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 ' +
        '-dPDFSETTINGS=/screen -sOutputFile="' + tmpPath + '" "' + filePath + '"',
        { stdio:'ignore' }
      );
      fs.renameSync(tmpPath, filePath);
    } catch(e) {
      console.warn('[Ghostscript not available — skipping PDF compression]');
    }
  }
  return filePath;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB gate

async function compressAndGate(srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) return { path: srcPath, error: null };
  const finalPath = await compressImage(srcPath);
  const stat = fs.statSync(finalPath);
  if (stat.size > MAX_FILE_BYTES) {
    fs.unlinkSync(finalPath);
    return { path: null, error: 'File exceeds 2MB after compression. Re-scan in black & white and try again.' };
  }
  return { path: finalPath, error: null };
}

module.exports = { compressImage, compressAndGate };
