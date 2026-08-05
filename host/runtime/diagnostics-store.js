'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_MAX_MEMORY_LINES = 240;
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|credential|private[_-]?key/i;

function redactText(value) {
  return String(value ?? '')
    .replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(\bBearer\s+)\S+/gi, '$1[redacted]')
    .replace(/(\b(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*)[^\s&"'`]+/gi, '$1[redacted]')
    .replace(/\b(?:dmt|dmr)_[a-z0-9_-]{1,120}_[A-Za-z0-9_-]{20,}\b/gi, '[devmate-token-redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[api-key-redacted]');
}

function redactValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(String(key || ''))) return '[redacted]';
  if (depth > 12) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return redactText(String(value));
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item, index) => redactValue(item, String(index), depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 500)
      .map(([childKey, child]) => [childKey, redactValue(child, childKey, depth + 1, seen)])
  );
}

function normalizeMessage(message) {
  const text = redactText(message).replace(/\r\n/g, '\n').trimEnd();
  return text || '(empty message)';
}

class DiagnosticsStore {
  constructor({
    stateDirectory,
    fileName = 'host-runtime.log',
    maxBytes = DEFAULT_MAX_LOG_BYTES,
    maxMemoryLines = DEFAULT_MAX_MEMORY_LINES
  }) {
    this.stateDirectory = path.resolve(stateDirectory);
    this.fileName = String(fileName || 'host-runtime.log');
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_MAX_LOG_BYTES);
    this.maxMemoryLines = Math.max(20, Number(maxMemoryLines) || DEFAULT_MAX_MEMORY_LINES);
    this.lines = [];
    this.lastFailure = null;
  }

  get logDirectory() {
    return path.join(this.stateDirectory, 'logs');
  }

  get logFile() {
    return path.join(this.logDirectory, this.fileName);
  }

  setStateDirectory(value) {
    this.stateDirectory = path.resolve(value);
  }

  rotateIfNeeded(incomingBytes) {
    fs.mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(this.logFile, { throwIfNoEntry: false });
    if (!stat || stat.size + incomingBytes <= this.maxBytes) return;
    const previous = `${this.logFile}.previous`;
    try { fs.rmSync(previous, { force: true }); } catch {}
    try { fs.renameSync(this.logFile, previous); }
    catch { try { fs.writeFileSync(this.logFile, '', 'utf8'); } catch {} }
  }

  append(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const normalized = normalizeMessage(message);
    const entries = normalized.split('\n').map((line, index) =>
      `${timestamp} ${String(level || 'info').toUpperCase()} ${index ? '  ' : ''}${line}`
    );
    this.lines.push(...entries);
    if (this.lines.length > this.maxMemoryLines) {
      this.lines.splice(0, this.lines.length - this.maxMemoryLines);
    }
    const payload = `${entries.join('\n')}\n`;
    try {
      this.rotateIfNeeded(Buffer.byteLength(payload));
      fs.appendFileSync(this.logFile, payload, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.logFile, 0o600); } catch {}
    } catch {}
  }

  recordFailure(error, context = {}) {
    this.lastFailure = {
      at: new Date().toISOString(),
      code: error?.code || null,
      message: redactText(error?.message || String(error)),
      context: redactValue(context)
    };
    this.append(`Failure: ${this.lastFailure.message}`, 'error');
    return this.lastFailure;
  }

  clearFailure() {
    this.lastFailure = null;
  }

  tail(limit = 100) {
    const count = Math.max(1, Math.min(this.maxMemoryLines, Number(limit) || 100));
    const memory = this.lines.slice(-count);
    if (memory.length) return memory.join('\n');
    try {
      return fs.readFileSync(this.logFile, 'utf8')
        .split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
    } catch {
      return '(no host log yet)';
    }
  }

  report(payload = {}) {
    return redactText([
      JSON.stringify(redactValue(payload), null, 2),
      '',
      'Recent host log',
      this.tail()
    ].join('\n'));
  }
}

module.exports = {
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_MEMORY_LINES,
  DiagnosticsStore,
  normalizeMessage,
  redactText,
  redactValue
};
