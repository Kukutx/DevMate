'use strict';

const path = require('node:path');
const childProcess = require('node:child_process');
const http = require('node:http');
const vscode = require('vscode');
const { VscodeHostLifecycle } = require('./vscode-host/lifecycle.js');
const { resolveVscodeStateDirectory, setting } = require('./vscode-host/runtime-context.js');
const { SharedTunnelRuntime } = require('./vscode-host/shared-tunnel-runtime.js');
const {
  deploymentMode: validateDeploymentMode,
  tunnelProvider: validateTunnelProvider
} = require('./vscode-host/tunnel-settings.js');

let lifecycle = null;
let runtime = null;
let output = null;
let activation = null;
let deactivation = null;

function tunnelSettings() {
  const provider = String(setting(vscode, 'tunnelProvider', 'ngrok')).trim().toLowerCase();
  const deploymentMode = String(setting(vscode, 'deploymentMode', 'personal')).trim().toLowerCase();
  return {
    provider: validateTunnelProvider(provider),
    publicUrl: setting(vscode, 'publicUrl', ''),
    ngrokUrl: setting(vscode, 'ngrokUrl', ''),
    ngrokCommandPath: setting(vscode, 'ngrokCommandPath', ''),
    ngrokUseManagedAccount: setting(vscode, 'ngrokUseManagedAccount', true) !== false,
    ngrokPoolingEnabled: setting(vscode, 'ngrokPoolingEnabled', false) === true,
    ngrokTrafficPolicyFile: setting(vscode, 'ngrokTrafficPolicyFile', ''),
    cloudflareCommandPath: setting(vscode, 'cloudflareCommandPath', ''),
    deploymentMode: validateDeploymentMode(deploymentMode)
  };
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function activate(context) {
  if (activation) return activation;
  activation = (async () => {
    if (runtime || lifecycle) await deactivate();
    output = vscode.window.createOutputChannel('DevMate Shared Tunnel');
    context.subscriptions.push(output);
    lifecycle = new VscodeHostLifecycle({ vscode });
    try {
      tunnelSettings();
      await lifecycle.activate(context);
      const stateDirectory = resolveVscodeStateDirectory(vscode, context);
      runtime = new SharedTunnelRuntime({
        stateDirectory,
        configFile: path.join(stateDirectory, 'config.json'),
        childProcess,
        http,
        settings: tunnelSettings,
        hostId: `vscode-${process.pid}`,
        logger: log
      }).install();
      log(`Shared tunnel coordination ready in ${stateDirectory}.`);
    } catch (error) {
      const currentLifecycle = lifecycle;
      lifecycle = null;
      try { await currentLifecycle?.deactivate(); } catch {}
      runtime = null;
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
    currentRuntime?.suspendSpawn();
    try {
      await currentLifecycle?.deactivate();
    } finally {
      try { await currentRuntime?.dispose({ stopOwned: true }); }
      finally { output = null; }
    }
  })();
  try { return await deactivation; }
  finally { deactivation = null; }
}

module.exports = { activate, deactivate, tunnelSettings };
