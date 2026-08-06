'use strict';

const path = require('node:path');
const childProcess = require('node:child_process');
const http = require('node:http');
const vscode = require('vscode');
const baseEntry = require('./extension-entry-host.js');
const { resolveVscodeStateDirectory, setting } = require('./vscode-host/runtime-context.js');
const { SharedTunnelRuntime } = require('./vscode-host/shared-tunnel-runtime.js');

let runtime = null;
let output = null;
let activation = null;
let deactivation = null;

function tunnelSettings() {
  return {
    provider: setting(vscode, 'tunnelProvider', 'ngrok'),
    publicUrl: setting(vscode, 'publicUrl', ''),
    ngrokUrl: setting(vscode, 'ngrokUrl', ''),
    ngrokCommandPath: setting(vscode, 'ngrokCommandPath', ''),
    ngrokUseManagedAccount: setting(vscode, 'ngrokUseManagedAccount', true) !== false,
    ngrokPoolingEnabled: setting(vscode, 'ngrokPoolingEnabled', false) === true,
    ngrokTrafficPolicyFile: setting(vscode, 'ngrokTrafficPolicyFile', ''),
    cloudflareCommandPath: setting(vscode, 'cloudflareCommandPath', ''),
    deploymentMode: setting(vscode, 'deploymentMode', 'personal')
  };
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function activate(context) {
  if (activation) return activation;
  activation = (async () => {
    if (runtime) await deactivate();
    output = vscode.window.createOutputChannel('DevMate Shared Tunnel');
    context.subscriptions.push(output);
    await baseEntry.activate(context);
    try {
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
      try { await baseEntry.deactivate(); } catch {}
      runtime = null;
      output = null;
      throw error;
    }
  })();
  try {
    return await activation;
  } finally {
    activation = null;
  }
}

async function deactivate() {
  if (deactivation) return deactivation;
  deactivation = (async () => {
    const current = runtime;
    runtime = null;
    current?.suspendSpawn();
    try {
      await baseEntry.deactivate();
    } finally {
      try { await current?.dispose({ stopOwned: true }); }
      finally { output = null; }
    }
  })();
  try {
    return await deactivation;
  } finally {
    deactivation = null;
  }
}

module.exports = {
  activate,
  deactivate,
  tunnelSettings
};
