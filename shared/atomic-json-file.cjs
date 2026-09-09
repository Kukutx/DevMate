'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const renameSleeper = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRIES = 3;
const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function replaceFile(temporary, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      if (process.platform !== 'win32' ||
          !WINDOWS_RENAME_RETRY_CODES.has(error?.code) ||
          attempt >= WINDOWS_RENAME_RETRIES) throw error;
      // Keep the committed file visible while a Windows reader or scanner
      // temporarily prevents replacement. Never move it out of the way.
      Atomics.wait(renameSleeper, 0, 0, 10 * (attempt + 1));
    }
  }
}

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
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    replaceFile(temporary, target);

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
