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
    const { execSync } = require('child_process');
    const gsCmd = resolveGsCommand();
    if (!gsCmd) {
      console.warn('[Ghostscript not available — skipping PDF compression]');
      return filePath;
    }
    try {
      const tmpPath = filePath + '.compressed.pdf';
      execSync(
        '"' + gsCmd + '" -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 ' +
        '-dPDFSETTINGS=/screen -sOutputFile="' + tmpPath + '" "' + filePath + '"',
        { stdio:'ignore' }
      );
      // Windows can transiently EPERM a rename onto a just-written file (real-time
      // antivirus/indexer briefly holding it) even though execSync has already
      // returned — retry a few times before giving up, rather than silently
      // leaving the file uncompressed.
      await renameWithRetry(tmpPath, filePath);
    } catch(e) {
      console.warn('[Ghostscript compression failed — skipping]', e.message);
    }
  }
  return filePath;
}

// Resolves the right Ghostscript executable for this platform. On Windows
// the binary is named gswin64c(.exe) and the official installer doesn't add
// it to PATH by default, so we also check the standard install location
// (C:\Program Files\gs\gs<version>\bin) if a plain PATH lookup fails.
// Cached after the first successful resolution — Ghostscript's location
// doesn't change during the life of the process.
let _cachedGsCmd; // undefined = not yet resolved, null = confirmed unavailable
function resolveGsCommand() {
  if (_cachedGsCmd !== undefined) return _cachedGsCmd;
  const { execSync } = require('child_process');
  const candidates = process.platform === 'win32' ? ['gswin64c', 'gswin32c'] : ['gs'];

  for (const cmd of candidates) {
    try { execSync('"' + cmd + '" --version', { stdio:'ignore' }); return (_cachedGsCmd = cmd); }
    catch(e) { /* not on PATH — keep looking */ }
  }

  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\gs', 'C:\\Program Files (x86)\\gs']) {
      try {
        const versions = fs.readdirSync(base).filter(d => d.startsWith('gs')).sort().reverse();
        for (const v of versions) {
          for (const exe of ['gswin64c.exe', 'gswin32c.exe']) {
            const full = path.join(base, v, 'bin', exe);
            if (fs.existsSync(full)) return (_cachedGsCmd = full);
          }
        }
      } catch(e) { /* base dir doesn't exist — keep looking */ }
    }
  }

  return (_cachedGsCmd = null);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function renameWithRetry(src, dest, attempts = 5, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dest); return; }
    catch(e) {
      if (i === attempts - 1) throw e;
      await sleep(delayMs);
    }
  }
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
