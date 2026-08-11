'use strict';

const fs = require('node:fs');
const {
  readJson,
  updateConfig
} = require('../host/runtime-controller.js');
const { currentWorkspaceRoot, runtimeConfigPath } = require('./runtime-context.js');

function contextSignature(value) {
  if (!value || typeof value !== 'object') return '';
  return JSON.stringify({
    workspaceRoot: value.workspaceRoot || '',
    activeEditor: value.activeEditor || null,
    visibleEditors: Array.isArray(value.visibleEditors) ? value.visibleEditors : [],
    diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : []
  });
}

class VscodeContextMirror {
  constructor({ vscode, context, diagnostics, intervalMs = 750 }) {
    this.vscode = vscode;
    this.context = context;
    this.diagnostics = diagnostics;
    this.intervalMs = Math.max(250, Number(intervalMs) || 750);
    this.file = runtimeConfigPath(context);
    this.active = false;
    this.running = false;
    this.pending = false;
    this.listener = () => this.schedule();
  }

  mirrorOnce() {
    const current = readJson(this.file, null);
    const vscodeContext = current?.vscodeContext;
    if (!vscodeContext || typeof vscodeContext !== 'object') return false;
    const capturedAt = vscodeContext.capturedAt || null;
    if (contextSignature(current.hostContexts?.vscode) === contextSignature(vscodeContext)) return false;
    updateConfig(this.file, value => {
      value.hostContexts ||= {};
      value.hostContexts.vscode = {
        ...vscodeContext,
        hostId: 'vscode',
        kind: 'editor',
        capturedAt,
        updatedAt: capturedAt || new Date().toISOString(),
        workspaceRoot: vscodeContext.workspaceRoot || currentWorkspaceRoot(this.vscode)
      };
      value.activeHostId = 'vscode';
      return value;
    });
    return true;
  }

  schedule() {
    if (!this.active) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      this.mirrorOnce();
    } catch (error) {
      this.diagnostics?.recordFailure(error, { phase: 'context-mirror', configFile: this.file });
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        queueMicrotask(() => this.schedule());
      }
    }
  }

  start() {
    if (this.active) return this;
    this.active = true;
    this.schedule();
    fs.watchFile(this.file, { interval: this.intervalMs, persistent: false }, this.listener);
    return this;
  }

  dispose() {
    if (!this.active) return;
    this.active = false;
    fs.unwatchFile(this.file, this.listener);
    this.pending = false;
  }
}

module.exports = {
  VscodeContextMirror,
  contextSignature
};
