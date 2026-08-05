#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function replaceOnce(relativePath, from, to, label) {
  const file = path.join(root, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Could not locate ${label} in ${relativePath}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`Found multiple ${label} matches in ${relativePath}`);
  fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
}

replaceOnce(
  'extension.js',
`const { spawn, spawnSync } = require('child_process');
const { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');
const { RuntimeController } = require('./host/runtime-controller.js');
`,
`const childProcess = require('child_process');
const { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');
const { RuntimeController, SUPPORTED_CONFIG_VERSION } = require('./host/runtime-controller.js');

function spawn(...args){ return childProcess.spawn(...args); }
function spawnSync(...args){ return childProcess.spawnSync(...args); }
`,
  'dynamic child process access'
);

replaceOnce(
  'extension.js',
`    version: 9,
`,
`    version: SUPPORTED_CONFIG_VERSION,
`,
  'default config schema version'
);

replaceOnce(
  'extension.js',
`  data.version = 9;
`,
`  data.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(data.version) || 0);
`,
  'monotonic config schema version'
);

replaceOnce(
  'extension-entry.js',
`const childProcess = require('child_process');
const {
`,
`const childProcess = require('child_process');
const { SpawnLayer } = require('./vscode-host/spawn-layer.js');
const {
`,
  'managed spawn layer import'
);

replaceOnce(
  'extension-entry.js',
`let globalContext = null;
`,
`let globalContext = null;
let managedSpawnLayer = null;
let activationAttempted = false;
let activated = false;
`,
  'managed spawn lifecycle state'
);

replaceOnce(
  'extension-entry.js',
`function loadBaseExtensionWithNgrokWrapper() {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = createExtensionSpawn(originalSpawn);
  try {
    return require('./extension');
  } finally {
    childProcess.spawn = originalSpawn;
  }
}
`,
`function installManagedSpawnLayer() {
  if (managedSpawnLayer?.active) return managedSpawnLayer;
  managedSpawnLayer = new SpawnLayer({
    childProcess,
    name: 'devmate-managed-ngrok',
    wrap: previousSpawn => createExtensionSpawn(previousSpawn)
  });
  return managedSpawnLayer.install();
}

function restoreManagedSpawnLayer() {
  const layer = managedSpawnLayer;
  managedSpawnLayer = null;
  if (!layer) return { disposed: true, alreadyDisposed: true };
  return layer.dispose();
}

function loadBaseExtension() {
  return require('./extension');
}
`,
  'managed spawn lifetime helpers'
);

replaceOnce(
  'extension-entry.js',
`async function activate(context) {
  globalContext = context;
  setupOutput = vscode.window.createOutputChannel('DevMate Setup');
  context.subscriptions.push(setupOutput);
  managedAuthtoken = await context.secrets.get(SECRET_KEY) || '';

  register(context, 'devMate.ngrokSetup', () => guidedSetup(context));
  register(context, 'devMate.ngrokSwitchAccount', () => switchAccount(context));
  register(context, 'devMate.ngrokClearAccount', () => clearManagedAccount(context));
  register(context, 'devMate.ngrokDoctor', () => ngrokDoctor());
  register(context, 'devMate.openNgrokDashboard', () => openExternal(NGROK_SETUP_URL));

  baseExtension = loadBaseExtensionWithNgrokWrapper();
  await baseExtension.activate(context);
  log(`ngrok integration ready. Account mode: ${usesManagedAccount() ? 'managed' : 'global'}; managed token: ${managedAuthtoken ? 'configured' : 'not configured'}.`);
  void maybePromptForNgrokSetup(context);
}

async function deactivate() {
  if (baseExtension?.deactivate) await baseExtension.deactivate();
}

module.exports = { activate, deactivate };
`,
`async function activate(context) {
  if (activationAttempted || activated) {
    const error = new Error('DevMate ngrok integration is already active');
    error.code = 'DEVMATE_NGROK_LAYER_ALREADY_ACTIVE';
    throw error;
  }
  activationAttempted = true;
  globalContext = context;
  setupOutput = vscode.window.createOutputChannel('DevMate Setup');
  context.subscriptions.push(setupOutput);
  managedAuthtoken = await context.secrets.get(SECRET_KEY) || '';

  register(context, 'devMate.ngrokSetup', () => guidedSetup(context));
  register(context, 'devMate.ngrokSwitchAccount', () => switchAccount(context));
  register(context, 'devMate.ngrokClearAccount', () => clearManagedAccount(context));
  register(context, 'devMate.ngrokDoctor', () => ngrokDoctor());
  register(context, 'devMate.openNgrokDashboard', () => openExternal(NGROK_SETUP_URL));

  installManagedSpawnLayer();
  try {
    baseExtension = loadBaseExtension();
    await baseExtension.activate(context);
    activated = true;
    log(`ngrok integration ready. Account mode: ${usesManagedAccount() ? 'managed' : 'global'}; managed token: ${managedAuthtoken ? 'configured' : 'not configured'}.`);
    void maybePromptForNgrokSetup(context);
  } catch (error) {
    try { if (baseExtension?.deactivate) await baseExtension.deactivate(); } catch {}
    activationAttempted = false;
    activated = false;
    restoreManagedSpawnLayer();
    globalContext = null;
    throw error;
  }
}

async function deactivate() {
  if (!activationAttempted && !activated && !managedSpawnLayer) return;
  try {
    if (activationAttempted && baseExtension?.deactivate) await baseExtension.deactivate();
  } finally {
    activationAttempted = false;
    activated = false;
    restoreManagedSpawnLayer();
    globalContext = null;
    setupOutput = null;
  }
}

module.exports = {
  activate,
  deactivate,
  createExtensionSpawn,
  installManagedSpawnLayer,
  loadBaseExtension,
  restoreManagedSpawnLayer
};
`,
  'managed ngrok activation lifecycle'
);

replaceOnce(
  'extension-entry-win32.js',
`const childProcess = require('child_process');
const legacyEntry = require('./extension-entry');
const { createNgrokCredentialCompatSpawn } = require('./ngrok-launch-compat');

async function activate(context) {
  const previousSpawn = childProcess.spawn;
  childProcess.spawn = createNgrokCredentialCompatSpawn(previousSpawn);
  try {
    await legacyEntry.activate(context);
  } finally {
    childProcess.spawn = previousSpawn;
  }
}

async function deactivate() {
  if (legacyEntry?.deactivate) await legacyEntry.deactivate();
}

module.exports = { activate, deactivate };
`,
`const childProcess = require('child_process');
const legacyEntry = require('./extension-entry');
const { createNgrokCredentialCompatSpawn } = require('./ngrok-launch-compat');
const { SpawnLayer } = require('./vscode-host/spawn-layer.js');

let credentialCompatLayer = null;
let activationAttempted = false;
let activated = false;

function installCredentialCompatLayer() {
  if (credentialCompatLayer?.active) return credentialCompatLayer;
  credentialCompatLayer = new SpawnLayer({
    childProcess,
    name: 'devmate-windows-ngrok-credential-compat',
    wrap: previousSpawn => createNgrokCredentialCompatSpawn(previousSpawn)
  });
  return credentialCompatLayer.install();
}

function restoreCredentialCompatLayer() {
  const layer = credentialCompatLayer;
  credentialCompatLayer = null;
  if (!layer) return { disposed: true, alreadyDisposed: true };
  return layer.dispose();
}

async function activate(context) {
  if (activationAttempted || activated) {
    const error = new Error('DevMate Windows compatibility integration is already active');
    error.code = 'DEVMATE_WINDOWS_LAYER_ALREADY_ACTIVE';
    throw error;
  }
  activationAttempted = true;
  installCredentialCompatLayer();
  try {
    await legacyEntry.activate(context);
    activated = true;
  } catch (error) {
    try { await legacyEntry.deactivate(); } catch {}
    activationAttempted = false;
    activated = false;
    restoreCredentialCompatLayer();
    throw error;
  }
}

async function deactivate() {
  if (!activationAttempted && !activated && !credentialCompatLayer) return;
  try {
    if (activationAttempted) await legacyEntry.deactivate();
  } finally {
    activationAttempted = false;
    activated = false;
    restoreCredentialCompatLayer();
  }
}

module.exports = {
  activate,
  deactivate,
  installCredentialCompatLayer,
  restoreCredentialCompatLayer
};
`,
  'Windows compatibility layer lifecycle'
);

console.log('Applied asserted VS Code spawn-layer lifecycle migration.');
