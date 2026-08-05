'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 512 * 1024;
const MAX_MEMORY_LINES = 200;
const REPORT_LOG_LINES = 80;

function redactSecrets(value) {
  return String(value || '')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}

function normalizeLogMessage(message) {
  const text = redactSecrets(message).replace(/\r\n/g, '\n').trimEnd();
  return text || '(empty message)';
}

class RuntimeDiagnostics {
  constructor({ stateDirectory, pluginVersion = 'unknown', vaultRoot = '' }) {
    this.stateDirectory = path.resolve(stateDirectory);
    this.pluginVersion = String(pluginVersion || 'unknown');
    this.vaultRoot = path.resolve(vaultRoot || '.');
    this.lines = [];
    this.lastFailure = null;
  }

  get logDirectory() {
    return path.join(this.stateDirectory, 'logs');
  }

  get logFile() {
    return path.join(this.logDirectory, 'obsidian-runtime.log');
  }

  setStateDirectory(stateDirectory) {
    this.stateDirectory = path.resolve(stateDirectory);
  }

  rotateIfNeeded(incomingBytes) {
    fs.mkdirSync(this.logDirectory, { recursive: true });
    const stat = fs.statSync(this.logFile, { throwIfNoEntry: false });
    if (!stat || stat.size + incomingBytes <= MAX_LOG_BYTES) return;
    const previous = `${this.logFile}.previous`;
    try { fs.rmSync(previous, { force: true }); } catch {}
    try { fs.renameSync(this.logFile, previous); } catch {
      try { fs.writeFileSync(this.logFile, '', 'utf8'); } catch {}
    }
  }

  append(message) {
    const timestamp = new Date().toISOString();
    const normalized = normalizeLogMessage(message);
    const entries = normalized.split('\n').map((line, index) => `${timestamp} ${index ? '  ' : ''}${line}`);
    this.lines.push(...entries);
    if (this.lines.length > MAX_MEMORY_LINES) this.lines.splice(0, this.lines.length - MAX_MEMORY_LINES);
    const payload = `${entries.join('\n')}\n`;
    try {
      this.rotateIfNeeded(Buffer.byteLength(payload));
      fs.appendFileSync(this.logFile, payload, { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }

  recordFailure(error) {
    this.lastFailure = {
      at: new Date().toISOString(),
      code: error?.code || null,
      message: redactSecrets(error?.message || String(error))
    };
    this.append(`Startup failure: ${this.lastFailure.message}`);
    return this.lastFailure;
  }

  clearFailure() {
    this.lastFailure = null;
  }

  tail(limit = REPORT_LOG_LINES) {
    const memory = this.lines.slice(-Math.max(1, Number(limit) || REPORT_LOG_LINES));
    if (memory.length) return memory.join('\n');
    try {
      const text = fs.readFileSync(this.logFile, 'utf8');
      return text.split(/\r?\n/).filter(Boolean).slice(-limit).join('\n');
    } catch {
      return '(no runtime log yet)';
    }
  }

  report({ plugin, controller, status }) {
    const snapshot = controller?.diagnosticSnapshot?.() || null;
    const report = {
      generatedAt: new Date().toISOString(),
      plugin: {
        id: plugin?.manifest?.id || 'devmate',
        version: plugin?.manifest?.version || this.pluginVersion,
        obsidianVersion: plugin?.app?.version || null,
        startupMode: plugin?.settings?.startupMode || null
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node || null,
        electron: process.versions.electron || null,
        chrome: process.versions.chrome || null
      },
      workspace: {
        vaultRoot: this.vaultRoot,
        stateDirectory: this.stateDirectory
      },
      status: status || null,
      lastFailure: this.lastFailure,
      runtime: snapshot,
      logFile: this.logFile
    };
    return redactSecrets([
      'DevMate Obsidian diagnostics',
      JSON.stringify(report, null, 2),
      '',
      'Recent runtime log',
      this.tail()
    ].join('\n'));
  }
}

module.exports = {
  MAX_LOG_BYTES,
  RuntimeDiagnostics,
  normalizeLogMessage,
  redactSecrets
};
