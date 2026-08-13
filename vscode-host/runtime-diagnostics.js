'use strict';

const fs = require('node:fs');
const { resolveNodeRuntime } = require('../host/runtime/node-runtime.js');
const { DiagnosticsStore, redactValue } = require('../host/runtime/diagnostics-store.js');
const { gatewayCandidates, runtimeConfigPath, workspaceFolders } = require('./runtime-context.js');

class VscodeRuntimeDiagnostics {
  constructor({ vscode, context, runtimeContext, output, resolveNodeRuntimeImpl = resolveNodeRuntime, runtimeSnapshot = () => null }) {
    this.vscode = vscode;
    this.context = context;
    this.runtimeContext = runtimeContext;
    this.output = output;
    this.resolveNodeRuntime = resolveNodeRuntimeImpl;
    this.runtimeSnapshot = typeof runtimeSnapshot === 'function' ? runtimeSnapshot : () => null;
    this.gatewayRuntime = null;
    this.gatewayRuntimeError = '';
    this.store = new DiagnosticsStore({ stateDirectory: runtimeContext.globalStorageUri.fsPath, fileName: 'vscode-host.log' });
  }

  append(message, level = 'info') {
    const text = String(message || '');
    this.store.append(text, level);
    this.output?.appendLine(`[${new Date().toLocaleTimeString()}] ${text}`);
  }

  recordFailure(error, context = {}) {
    const failure = this.store.recordFailure(error, context);
    this.output?.appendLine(`[${new Date().toLocaleTimeString()}] ERROR ${failure.message}`);
    return failure;
  }

  clearFailure() { this.store.clearFailure(); }

  selfCheck() {
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: String(detail || '') });
    const stateDirectory = this.runtimeContext.globalStorageUri.fsPath;
    const configFile = runtimeConfigPath(this.runtimeContext);
    const candidates = gatewayCandidates(this.runtimeContext);
    const gateway = candidates.find(value => fs.statSync(value, { throwIfNoEntry: false })?.isFile()) || '';
    add('extension-path', fs.statSync(this.context.extensionPath, { throwIfNoEntry: false })?.isDirectory(), this.context.extensionPath);
    add('state-directory', fs.statSync(stateDirectory, { throwIfNoEntry: false })?.isDirectory(), stateDirectory);
    add('gateway-bundle', !!gateway, gateway || candidates.join(' | '));
    add('gateway-bundle-size', !!gateway && fs.statSync(gateway).size > 100000, gateway ? `${fs.statSync(gateway).size} bytes` : 'missing');
    add('gateway-launch-mode', true, 'child_process');
    add('config-file', fs.statSync(configFile, { throwIfNoEntry: false })?.isFile(), configFile);
    add('workspace', workspaceFolders(this.vscode).length > 0, `${workspaceFolders(this.vscode).length} folder(s)`);
    try {
      const runtime = this.resolveNodeRuntime();
      this.gatewayRuntime = { source: runtime.source, executable: runtime.executable, nodeVersion: runtime.nodeVersion, electronVersion: runtime.electronVersion || null };
      this.gatewayRuntimeError = '';
      add('gateway-node-runtime', true, `Node ${runtime.nodeVersion} via ${runtime.source}: ${runtime.executable}`);
    } catch (error) {
      this.gatewayRuntime = null;
      this.gatewayRuntimeError = String(error.message || error);
      add('gateway-node-runtime', false, this.gatewayRuntimeError);
    }
    add('electron-runtime', !!process.versions.electron, process.versions.electron || 'not reported');
    const informational = new Set(['workspace', 'config-file', 'electron-runtime']);
    const ok = checks.every(check => check.ok || informational.has(check.id));
    this.append(`VS Code host self-check ${ok ? 'passed' : 'failed'}: ${checks.map(c => `${c.id}=${c.ok ? 'ok' : 'fail'}`).join(', ')}`, ok ? 'info' : 'error');
    return { ok, checks, gateway, gatewayRuntime: this.gatewayRuntime, stateDirectory, configFile, checkedAt: new Date().toISOString() };
  }

  snapshot({ autoStart = false, startupMode = '', enabled = true, lastSelfCheck = null } = {}) {
    let config = null;
    try { config = JSON.parse(fs.readFileSync(runtimeConfigPath(this.runtimeContext), 'utf8').replace(/^\uFEFF/, '')); } catch {}
    let runtime = null;
    try { runtime = this.runtimeSnapshot(); }
    catch (error) { runtime = { snapshotError: String(error.message || error) }; }
    return {
      generatedAt: new Date().toISOString(),
      host: {
        id: 'vscode', extensionVersion: this.context.extension?.packageJSON?.version || null,
        vscodeVersion: this.vscode.version || null, enabled: enabled !== false, autoStart: autoStart === true,
        startupMode: startupMode || (autoStart ? 'automatic' : 'manual'), launchMode: 'child_process'
      },
      environment: {
        platform: process.platform, arch: process.arch, node: process.versions.node || null,
        electron: process.versions.electron || null, chrome: process.versions.chrome || null,
        execPath: process.execPath, gatewayRuntime: this.gatewayRuntime, gatewayRuntimeError: this.gatewayRuntimeError || null
      },
      workspace: { folders: workspaceFolders(this.vscode), workspaceFile: this.vscode.workspace.workspaceFile?.fsPath || null },
      paths: {
        extensionPath: this.context.extensionPath, stateDirectory: this.runtimeContext.globalStorageUri.fsPath,
        configFile: runtimeConfigPath(this.runtimeContext), gatewayCandidates: gatewayCandidates(this.runtimeContext), logFile: this.store.logFile
      },
      lastSelfCheck: redactValue(lastSelfCheck), runtime: redactValue(runtime), lastFailure: this.store.lastFailure, config: redactValue(config)
    };
  }

  report(options = {}) { return ['DevMate VS Code host diagnostics', this.store.report(this.snapshot(options))].join('\n'); }
  async copy(options = {}) {
    const report = this.report(options);
    await this.vscode.env.clipboard.writeText(report);
    this.append(`Copied VS Code host diagnostics (${report.length} characters).`);
    return report;
  }
}

module.exports = { VscodeRuntimeDiagnostics };
