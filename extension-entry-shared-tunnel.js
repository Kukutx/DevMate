'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { version: VERSION } = require('./package.json');
const { ensurePersonalConfig } = require('./shared/config-store.cjs');
const { VscodeHostLifecycle } = require('./vscode-host/lifecycle.js');
const { settingsFromState } = require('./vscode-host/effective-tunnel-settings.js');
const { currentWorkspaceRoot, resolveVscodeStateDirectory, setting } = require('./vscode-host/runtime-context.js');
const { normalizeBootstrapDeployment } = require('./vscode-host/shared-deployment-config.js');
const { TunnelController } = require('./vscode-host/tunnel-controller.js');
const { clearTunnelController, setTunnelController } = require('./vscode-host/tunnel-runtime.js');
const { tunnelMaxRestarts } = require('./vscode-host/tunnel-settings.js');

const NGROK_TOKEN_SECRET = 'devMate.ngrokAuthtoken';
const CLOUDFLARE_TOKEN_SECRET = 'devMate.cloudflareTunnelToken';

let lifecycle = null;
let runtime = null;
let output = null;
let activation = null;
let deactivation = null;
let runtimeStateDirectory = '';

function strictBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function localTunnelSettings() {
  return {
    provider: String(setting(vscode, 'tunnelProvider', 'ngrok')).trim().toLowerCase(),
    publicUrl: setting(vscode, 'publicUrl', ''),
    ngrokUrl: setting(vscode, 'ngrokUrl', ''),
    ngrokCommandPath: setting(vscode, 'ngrokCommandPath', ''),
    ngrokUseManagedAccount: strictBoolean(setting(vscode, 'ngrokUseManagedAccount', true), 'ngrokUseManagedAccount'),
    ngrokPoolingEnabled: strictBoolean(setting(vscode, 'ngrokPoolingEnabled', false), 'ngrokPoolingEnabled'),
    ngrokTrafficPolicyFile: setting(vscode, 'ngrokTrafficPolicyFile', ''),
    cloudflareCommandPath: setting(vscode, 'cloudflareCommandPath', ''),
    autoRestart: strictBoolean(setting(vscode, 'tunnelAutoRestart', true), 'tunnelAutoRestart'),
    maxRestarts: tunnelMaxRestarts(setting(vscode, 'tunnelMaxRestarts', 10)),
    deploymentMode: String(setting(vscode, 'deploymentMode', 'personal')).trim().toLowerCase()
  };
}

function tunnelSettings(stateDirectory = runtimeStateDirectory) {
  return settingsFromState({ stateDirectory, localSettings: localTunnelSettings() });
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function ensureSharedDesktopConfig(stateDirectory) {
  const workspaceRoot = currentWorkspaceRoot(vscode);
  if (!workspaceRoot) return null;
  const configFile = path.join(stateDirectory, 'config.json');
  const existed = fs.statSync(configFile, { throwIfNoEntry: false })?.isFile() === true;
  ensurePersonalConfig({
    configFile,
    workspaceRoot,
    preferredPort: Number(setting(vscode, 'port', 8787)) || 8787,
    appVersion: VERSION
  });
  if (!existed) normalizeBootstrapDeployment(configFile);
  return configFile;
}

async function tunnelSecrets(context) {
  const [ngrokAuthtoken, cloudflareTunnelToken] = await Promise.all([
    context.secrets.get(NGROK_TOKEN_SECRET),
    context.secrets.get(CLOUDFLARE_TOKEN_SECRET)
  ]);
  return {
    ngrokAuthtoken: ngrokAuthtoken || '',
    cloudflareTunnelToken: cloudflareTunnelToken || ''
  };
}

async function activate(context) {
  if (activation) return activation;
  activation = (async () => {
    if (runtime || lifecycle) await deactivate();
    output = vscode.window.createOutputChannel('DevMate Tunnel');
    context.subscriptions.push(output);
    lifecycle = new VscodeHostLifecycle({ vscode });
    try {
      runtimeStateDirectory = resolveVscodeStateDirectory(vscode, context);
      localTunnelSettings();
      ensureSharedDesktopConfig(runtimeStateDirectory);
      runtime = new TunnelController({
        stateDirectory: runtimeStateDirectory,
        settings: () => tunnelSettings(runtimeStateDirectory),
        getSecrets: () => tunnelSecrets(context),
        hostId: `vscode-${process.pid}`,
        logger: log
      });
      setTunnelController(runtime);
      await lifecycle.activate(context);
      log(`Provider-native shared tunnel runtime ready in ${runtimeStateDirectory}.`);
    } catch (error) {
      const currentRuntime = runtime;
      const currentLifecycle = lifecycle;
      runtime = null;
      lifecycle = null;
      runtimeStateDirectory = '';
      clearTunnelController(currentRuntime);
      try { await currentLifecycle?.deactivate(); } catch {}
      try { await currentRuntime?.dispose({ stopOwned: true }); } catch {}
      output = null;
      throw error;
    }
  })();
  try { return await activation; }
  finally { activation = null; }
}

async function deactivate() {
  if (deactivation) return deactivation;
  deactivation = (async () => {
    const currentRuntime = runtime;
    const currentLifecycle = lifecycle;
    runtime = null;
    lifecycle = null;
    runtimeStateDirectory = '';
    try {
      await currentLifecycle?.deactivate();
    } finally {
      clearTunnelController(currentRuntime);
      try { await currentRuntime?.dispose({ stopOwned: true }); }
      finally { output = null; }
    }
  })();
  try { return await deactivation; }
  finally { deactivation = null; }
}

module.exports = {
  activate,
  deactivate,
  ensureSharedDesktopConfig,
  localTunnelSettings,
  tunnelSecrets,
  tunnelSettings
};
