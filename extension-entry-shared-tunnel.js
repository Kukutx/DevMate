'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { version: VERSION } = require('./package.json');
const { ensurePersonalConfig } = require('./shared/config-store.cjs');
const { strictPort } = require('./shared/port.cjs');
const { VscodeHostLifecycle } = require('./vscode-host/lifecycle.js');
const { settingsFromState } = require('./vscode-host/effective-tunnel-settings.js');
const { PublicTunnelVerifier } = require('./vscode-host/public-tunnel-verifier.js');
const { currentWorkspaceRoot, resolveVscodeStateDirectory, setting } = require('./vscode-host/runtime-context.js');
const { TunnelController } = require('./vscode-host/tunnel-controller.js');
const { clearTunnelController, setTunnelController } = require('./vscode-host/tunnel-runtime.js');
const { tunnelMaxRestarts } = require('./vscode-host/tunnel-settings.js');

const NGROK_TOKEN_SECRET = 'devMate.ngrokAuthtoken';
const CLOUDFLARE_TOKEN_SECRET = 'devMate.cloudflareTunnelToken';

let lifecycle = null;
let runtime = null;
let publicVerifier = null;
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
  ensurePersonalConfig({
    configFile,
    workspaceRoot,
    preferredPort: strictPort(setting(vscode, 'port', 8787), { label: 'devMate.port' }),
    appVersion: VERSION
  });
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

async function syncBasePublicState() {
  try {
    return await vscode.commands.executeCommand('devMate.syncPublicState');
  } catch (error) {
    log(`Could not synchronize base VS Code public state: ${error.message || error}`);
    return null;
  }
}

async function stopConfigurationConflict() {
  if (!runtime) return { stopped: false, reason: 'runtime-unavailable' };
  const result = await runtime.stop();
  await syncBasePublicState();
  if (result.stopped) {
    const choice = await vscode.window.showWarningMessage(
      'DevMate stopped the previous public ingress because the shared deployment configuration changed. Start DevMate to launch the newly configured provider.',
      'Start Now',
      'Open DevMate'
    );
    if (choice === 'Start Now') await vscode.commands.executeCommand('devMate.start');
    if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
  } else if (result.reason === 'managed-by-another-host') {
    log('The mismatched public ingress is owned by another host; its owner must reconcile the shared configuration.');
  } else if (result.reason && result.reason !== 'not-running') {
    vscode.window.showWarningMessage(`DevMate could not stop the stale public ingress cleanly: ${result.reason}`);
  }
  return result;
}

function createPublicVerifier() {
  return new PublicTunnelVerifier({
    stateDirectory: runtimeStateDirectory,
    tunnelStatus: port => runtime?.status(port),
    appVersion: VERSION,
    logger: log,
    onStateChange: async () => {
      await syncBasePublicState();
    },
    onConfigurationConflict: async () => stopConfigurationConflict(),
    onVerified: async result => {
      if (!result.changedHost) return;
      const choice = await vscode.window.showWarningMessage(
        `DevMate recovered a new verified public endpoint (${result.publicHost}). Update the ChatGPT MCP connection to the new URL.`,
        'Copy MCP URL',
        'Open DevMate'
      );
      if (choice === 'Copy MCP URL') await vscode.commands.executeCommand('devMate.copyUrl');
      if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
    },
    onError: async ({ error }) => {
      const choice = await vscode.window.showWarningMessage(
        `DevMate tunnel recovered, but public MCP verification failed: ${error.message || error}`,
        'Open DevMate',
        'Copy diagnostics'
      );
      if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
      if (choice === 'Copy diagnostics') await vscode.commands.executeCommand('devMate.copyHostDiagnostics');
    }
  });
}

async function activate(context) {
  if (activation) return activation;
  activation = (async () => {
    if (runtime || lifecycle || publicVerifier) await deactivate();
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
      publicVerifier = createPublicVerifier().start();
      log(`Provider-native shared tunnel runtime ready in ${runtimeStateDirectory}.`);
    } catch (error) {
      const currentVerifier = publicVerifier;
      const currentRuntime = runtime;
      const currentLifecycle = lifecycle;
      publicVerifier = null;
      runtime = null;
      lifecycle = null;
      runtimeStateDirectory = '';
      currentVerifier?.dispose();
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
    const currentVerifier = publicVerifier;
    const currentRuntime = runtime;
    const currentLifecycle = lifecycle;
    publicVerifier = null;
    runtime = null;
    lifecycle = null;
    runtimeStateDirectory = '';
    currentVerifier?.dispose();
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
  createPublicVerifier,
  deactivate,
  ensureSharedDesktopConfig,
  localTunnelSettings,
  stopConfigurationConflict,
  syncBasePublicState,
  tunnelSecrets,
  tunnelSettings
};