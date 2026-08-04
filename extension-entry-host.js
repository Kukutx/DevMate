'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const platformExtension = require('./extension-entry-platform');
const {
  migrateLegacyState,
  readJson,
  resolveStateDirectory,
  updateConfig
} = require('./host/runtime-controller');

let runtimeContext = null;
let watchedConfig = '';
let startupTimer = null;

function config() {
  return vscode.workspace.getConfiguration('devMate');
}

function setting(name, fallback) {
  const value = config().get(name);
  return value === undefined ? fallback : value;
}

function currentWorkspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function createRuntimeContext(context) {
  const workspaceRoot = currentWorkspaceRoot();
  const shared = setting('sharedRuntimeEnabled', true) !== false;
  if (!workspaceRoot || !shared) return context;

  const legacyDirectory = context.globalStorageUri.fsPath;
  const stateDirectory = resolveStateDirectory({
    workspaceRoot,
    overrideDirectory: String(setting('sharedStateDirectory', '') || '').trim(),
    legacyDirectory,
    shared: true
  });
  migrateLegacyState({ legacyDirectory, stateDirectory });
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const storageUri = vscode.Uri.file(stateDirectory);

  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'globalStorageUri') return storageUri;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function runtimeConfigPath(context) {
  return path.join(context.globalStorageUri.fsPath, 'config.json');
}

function mirrorVscodeContext(file) {
  const current = readJson(file, null);
  const vscodeContext = current?.vscodeContext;
  if (!vscodeContext || typeof vscodeContext !== 'object') return;
  const capturedAt = vscodeContext.capturedAt || null;
  if (current.hostContexts?.vscode?.capturedAt === capturedAt) return;
  updateConfig(file, value => {
    value.hostContexts ||= {};
    value.hostContexts.vscode = {
      ...vscodeContext,
      hostId: 'vscode',
      kind: 'editor',
      capturedAt,
      updatedAt: capturedAt,
      workspaceRoot: vscodeContext.workspaceRoot || currentWorkspaceRoot()
    };
    value.activeHostId = 'vscode';
    return value;
  });
}

function startContextMirror(context) {
  const file = runtimeConfigPath(context);
  watchedConfig = file;
  mirrorVscodeContext(file);
  fs.watchFile(file, { interval: 750 }, () => {
    try { mirrorVscodeContext(file); }
    catch (error) { console.warn(`[DevMate] Could not mirror VS Code context: ${error.message || error}`); }
  });
  context.subscriptions.push({
    dispose() {
      fs.unwatchFile(file);
      if (watchedConfig === file) watchedConfig = '';
    }
  });
}

async function activate(context) {
  if (setting('vscodeHostEnabled', true) === false || setting('vscodeStartupMode', 'auto') === 'disabled') {
    return;
  }

  runtimeContext = createRuntimeContext(context);
  await platformExtension.activate(runtimeContext);
  startContextMirror(runtimeContext);

  if (setting('vscodeStartupMode', 'auto') === 'auto' && currentWorkspaceRoot()) {
    startupTimer = setTimeout(async () => {
      startupTimer = null;
      try { await vscode.commands.executeCommand('devMate.start'); }
      catch (error) { console.warn(`[DevMate] Automatic start failed: ${error.message || error}`); }
    }, 0);
  }
}

async function deactivate() {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = null;
  if (watchedConfig) fs.unwatchFile(watchedConfig);
  watchedConfig = '';
  try {
    if (runtimeContext) await platformExtension.deactivate();
  } finally {
    runtimeContext = null;
  }
}

module.exports = { activate, deactivate };
