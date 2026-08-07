'use strict';

const vscode = require('vscode');
const { VscodeHostLifecycle } = require('./vscode-host/lifecycle.js');
const { resolveVscodeStateDirectory, setting } = require('./vscode-host/runtime-context.js');
const { TunnelController } = require('./vscode-host/tunnel-controller.js');
const {
  clearTunnelController,
  setTunnelController
} = require('./vscode-host/tunnel-runtime.js');
const {
  deploymentMode: validateDeploymentMode,
  tunnelMaxRestarts,
  tunnelProvider: validateTunnelProvider
} = require('./vscode-host/tunnel-settings.js');

const NGROK_TOKEN_SECRET = 'devMate.ngrokAuthtoken';
const CLOUDFLARE_TOKEN_SECRET = 'devMate.cloudflareTunnelToken';

let lifecycle = null;
let runtime = null;
let output = null;
let activation = null;
let deactivation = null;

function strictBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function tunnelSettings() {
  const provider = String(setting(vscode, 'tunnelProvider', 'ngrok')).trim().toLowerCase();
  const deploymentMode = String(setting(vscode, 'deploymentMode', 'personal')).trim().toLowerCase();
  return {
    provider: validateTunnelProvider(provider),
    publicUrl: setting(vscode, 'publicUrl', ''),
    ngrokUrl: setting(vscode, 'ngrokUrl', ''),
    ngrokCommandPath: setting(vscode, 'ngrokCommandPath', ''),
    ngrokUseManagedAccount: strictBoolean(setting(vscode, 'ngrokUseManagedAccount', true), 'ngrokUseManagedAccount'),
    ngrokPoolingEnabled: strictBoolean(setting(vscode, 'ngrokPoolingEnabled', false), 'ngrokPoolingEnabled'),
    ngrokTrafficPolicyFile: setting(vscode, 'ngrokTrafficPolicyFile', ''),
    cloudflareCommandPath: setting(vscode, 'cloudflareCommandPath', ''),
    autoRestart: strictBoolean(setting(vscode, 'tunnelAutoRestart', true), 'tunnelAutoRestart'),
    maxRestarts: tunnelMaxRestarts(setting(vscode, 'tunnelMaxRestarts', 10)),
    deploymentMode: validateDeploymentMode(deploymentMode)
  };
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function secrets(context) {
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
      tunnelSettings();
      const stateDirectory = resolveVscodeStateDirectory(vscode, context);
      runtime = new TunnelController({
        stateDirectory,
        settings: tunnelSettings,
        getSecrets: () => secrets(context),
        hostId: `vscode-${process.pid}`,
        logger: log
      });
      setTunnelController(runtime);
      await lifecycle.activate(context);
      log(`Provider-native shared tunnel runtime ready in ${stateDirectory}.`);
    } catch (error) {
      const currentRuntime = runtime;
      const currentLifecycle = lifecycle;
      runtime = null;
      lifecycle = null;
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

module.exports = { activate, deactivate, secrets, tunnelSettings };
