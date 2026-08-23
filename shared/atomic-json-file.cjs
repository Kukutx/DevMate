'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function atomicWriteJsonFile(file, value, { maxBytes = Number.MAX_SAFE_INTEGER, mode = 0o600 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Atomic JSON write requires a JSON object');
  }
  const target = path.resolve(file);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}

  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  if (bytes > maxBytes) {
    const error = new Error(`Atomic JSON payload exceeds ${maxBytes} bytes (${bytes} bytes)`);
    error.code = 'atomic_json_too_large';
    error.bytes = bytes;
    error.maxBytes = maxBytes;
    throw error;
  }

  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;

    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${target}.replace-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      let movedPrevious = false;
      try {
        if (fs.existsSync(target)) {
          fs.renameSync(target, previous);
          movedPrevious = true;
        }
        fs.renameSync(temporary, target);
        if (movedPrevious) fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(target) && movedPrevious && fs.existsSync(previous)) {
          try { fs.renameSync(previous, target); } catch {}
        }
        throw replacementError;
      }
    }

    try { fs.chmodSync(target, mode); } catch {}
    fsyncDirectory(directory);
    return { file: target, bytes };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

module.exports = {
  atomicWriteJsonFile,
  fsyncDirectory
};
