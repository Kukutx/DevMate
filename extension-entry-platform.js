'use strict';

const childProcess = require('node:child_process');
const vscode = require('vscode');
const path = require('path');
const { normalizeNgrokUrl } = require('./ngrok-support.js');
const { normalizePublicUrl } = require('./tunnel-provider');
const { settingsFromState } = require('./vscode-host/effective-tunnel-settings.js');
const {
  applyInstancePatch,
  readInstanceConfig
} = require('./vscode-host/shared-instance-config.js');
const { stopTunnel, tunnelStatus } = require('./vscode-host/tunnel-runtime.js');
const {
  assertTunnelSafeForCredentialChange,
  credentialProviderInUse
} = require('./vscode-host/tunnel-stop-policy.js');
const { tunnelMaxRestarts } = require('./vscode-host/tunnel-settings.js');

const CLOUDFLARE_TOKEN_SECRET = 'devMate.cloudflareTunnelToken';
const CLOUDFLARE_DOCS = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/';
const NGROK_POLICY_DOCS = 'https://ngrok.com/docs/traffic-policy/';

let innerExtension = null;
let output = null;
let cloudflareTunnelToken = '';

function cfg() {
  return vscode.workspace.getConfiguration('devMate');
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function configPath(context) {
  return path.join(context.globalStorageUri.fsPath, 'config.json');
}

function setting(name, fallback) {
  const value = cfg().get(name);
  return value === undefined ? fallback : value;
}

function strictBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function localTunnelSettings() {
  return {
    publicUrl: String(setting('publicUrl', '') || '').trim(),
    ngrokUrl: String(setting('ngrokUrl', '') || '').trim(),
    ngrokCommandPath: String(setting('ngrokCommandPath', '') || '').trim(),
    ngrokUseManagedAccount: strictBoolean(setting('ngrokUseManagedAccount', true), 'ngrokUseManagedAccount'),
    ngrokPoolingEnabled: strictBoolean(setting('ngrokPoolingEnabled', false), 'ngrokPoolingEnabled'),
    ngrokTrafficPolicyFile: String(setting('ngrokTrafficPolicyFile', '') || '').trim(),
    cloudflareCommandPath: String(setting('cloudflareCommandPath', '') || '').trim(),
    autoRestart: strictBoolean(setting('tunnelAutoRestart', true), 'tunnelAutoRestart'),
    maxRestarts: tunnelMaxRestarts(setting('tunnelMaxRestarts', 10))
  };
}

function tunnelSettings(context) {
  return settingsFromState({
    stateDirectory: context.globalStorageUri.fsPath,
    localSettings: localTunnelSettings()
  });
}

function currentTunnelRuntime() {
  try { return tunnelStatus(); }
  catch { return { running: false, provider: '', record: null }; }
}

function cloudflareCredentialInUse(context) {
  const configured = tunnelSettings(context);
  const runtime = currentTunnelRuntime();
  return credentialProviderInUse('cloudflare-managed', {
    configuredProvider: configured.provider,
    runtimeProvider: runtime?.provider || '',
    runtimeRunning: runtime?.running === true
  });
}

async function prepareCloudflareCredentialMutation(context, operation) {
  if (!cloudflareCredentialInUse(context)) {
    return { safe: true, remoteOwner: false, reason: 'credential-dormant', tunnel: null };
  }
  const stopState = assertTunnelSafeForCredentialChange(await stopTunnel(), operation);
  if (stopState.remoteOwner) {
    log('Cloudflare managed credential changed while the currently shared connection is still active in another desktop process.');
  }
  return stopState;
}

async function updateSetting(name, value) {
  await cfg().update(name, value, vscode.ConfigurationTarget.Global);
}

async function commitConnectionSettings(context, localUpdates, sharedPatch) {
  const previous = new Map();
  const applied = [];
  try {
    for (const [name, value] of Object.entries(localUpdates)) {
      previous.set(name, setting(name, undefined));
      await updateSetting(name, value);
      applied.push(name);
    }
    applyInstancePatch(configPath(context), sharedPatch);
  } catch (error) {
    for (const name of applied.reverse()) {
      try { await updateSetting(name, previous.get(name)); } catch {}
    }
    throw error;
  }
}

async function restoreCloudflareToken(context, previousToken) {
  if (previousToken) await context.secrets.store(CLOUDFLARE_TOKEN_SECRET, previousToken);
  else await context.secrets.delete(CLOUDFLARE_TOKEN_SECRET);
  cloudflareTunnelToken = previousToken || '';
}

async function commitCloudflareConnection(context, token, localUpdates, sharedPatch) {
  const previousToken = await context.secrets.get(CLOUDFLARE_TOKEN_SECRET) || '';
  try {
    await storeCloudflareToken(context, token);
    await commitConnectionSettings(context, localUpdates, sharedPatch);
  } catch (error) {
    try {
      await restoreCloudflareToken(context, previousToken);
      log('Restored the previous Cloudflare Tunnel token after connection configuration failed.');
    } catch (rollbackError) {
      error.secretRollbackError = rollbackError?.message || String(rollbackError);
      log(`Could not restore the previous Cloudflare Tunnel token: ${error.secretRollbackError}`);
    }
    throw error;
  }
}

async function prepareConnectionMutation() {
  const stopResult = await stopTunnel();
  const state = assertTunnelSafeForCredentialChange(stopResult, 'connection configuration change');
  if (state.remoteOwner) {
    log('The current shared public connection is still active in another desktop process; the new configuration is saved and will be used by the next connection generation.');
  }
  return state;
}

async function openExternal(url) {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function checkCommand(command, args = ['--version']) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  return {
    ok: !result.error && result.status === 0,
    output: String(result.stdout || result.stderr || result.error?.message || '').trim()
  };
}

async function promptPublicUrl(current = '') {
  const value = await vscode.window.showInputBox({
    title: 'DevMate · Public HTTPS URL',
    prompt: 'Enter the stable public origin, without /mcp, query parameters, or credentials.',
    value: current,
    ignoreFocusOut: true,
    validateInput: input => {
      try {
        normalizePublicUrl(input);
        return null;
      } catch (error) {
        return error.message;
      }
    }
  });
  return value === undefined ? null : normalizePublicUrl(value);
}

async function promptStableNgrokUrl(current = '') {
  const value = await vscode.window.showInputBox({
    title: 'DevMate · Stable ngrok URL',
    prompt: 'Optional account-owned stable ngrok hostname or HTTPS origin, without /mcp.',
    value: current,
    ignoreFocusOut: true,
    validateInput: input => {
      if (!String(input || '').trim()) return null;
      try {
        normalizeNgrokUrl(input);
        return null;
      } catch (error) {
        return error.message;
      }
    }
  });
  if (value === undefined) return null;
  return String(value || '').trim() ? normalizeNgrokUrl(value) : '';
}

async function promptCloudflareTokenValue(title = 'DevMate · Cloudflare Tunnel Token') {
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Paste the remotely managed Cloudflare Tunnel token. It is stored only in VS Code Secret Storage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: input => String(input || '').trim().length < 30
      ? 'Tunnel token looks incomplete.'
      : null
  });
  return value === undefined ? null : String(value).trim();
}

async function storeCloudflareToken(context, value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('Cloudflare Tunnel token is required');
  await context.secrets.store(CLOUDFLARE_TOKEN_SECRET, token);
  cloudflareTunnelToken = token;
  log('Saved Cloudflare Tunnel token in VS Code Secret Storage.');
}

async function configureConnection(context) {
  output.show(true);
  let state = readInstanceConfig(configPath(context));
  if (!state) throw new Error('DevMate shared config is not initialized');

  const providerChoice = await vscode.window.showQuickPick([
    { label: '$(radio-tower) ngrok', description: 'Default local-first HTTPS connection; optional stable endpoint', value: 'ngrok' },
    { label: '$(beaker) Cloudflare Quick Tunnel', description: 'Temporary TryCloudflare HTTPS endpoint', value: 'cloudflare-quick' },
    { label: '$(cloud) Cloudflare managed tunnel', description: 'Stable managed HTTPS connection', value: 'cloudflare-managed' },
    { label: '$(link) External reverse proxy', description: 'Existing HTTPS ingress, load balancer, VPN, or tunnel', value: 'external' }
  ], {
    title: 'DevMate · Connection Provider',
    ignoreFocusOut: true
  });
  if (!providerChoice) return;

  const localUpdates = {};
  let publicUrl = '';
  let cloudflareToken = null;

  if (providerChoice.value === 'ngrok') {
    const action = await vscode.window.showQuickPick([
      { label: '$(check) Use current ngrok setup', description: 'Use the current account and remembered stable URL when available', value: 'keep' },
      { label: '$(key) Configure ngrok account', description: 'Securely configure or switch the DevMate-managed ngrok account', value: 'setup' },
      { label: '$(link) Set or clear stable ngrok URL', description: 'Optional account-owned stable endpoint', value: 'url' },
      { label: '$(book) Open Traffic Policy documentation', value: 'policy' }
    ], { title: 'DevMate · ngrok Connection' });
    if (!action) return;
    if (action.value === 'setup') {
      if (typeof innerExtension?.setupForConnection !== 'function') {
        throw new Error('Embedded ngrok account setup is unavailable');
      }
      const configured = await innerExtension.setupForConnection(context);
      if (!configured) return;
      state = readInstanceConfig(configPath(context));
      if (!state) throw new Error('DevMate shared config disappeared during ngrok setup');
    }
    if (action.value === 'policy') await openExternal(NGROK_POLICY_DOCS);
    const current = state.connection.provider === 'ngrok'
      ? state.connection.publicUrl
      : String(setting('ngrokUrl', '') || '');
    if (action.value === 'url') {
      const url = await promptStableNgrokUrl(current);
      if (url === null) return;
      publicUrl = url;
      localUpdates.ngrokUrl = url;
    } else {
      publicUrl = current;
    }
  } else if (providerChoice.value === 'cloudflare-quick') {
    const command = String(setting('cloudflareCommandPath', '') || 'cloudflared');
    const check = checkCommand(command);
    if (!check.ok) {
      vscode.window.showWarningMessage(
        `cloudflared was not detected: ${check.output || 'unknown error'}`,
        'Open Cloudflare Docs'
      ).then(choice => choice && openExternal(CLOUDFLARE_DOCS));
    }
  } else if (providerChoice.value === 'cloudflare-managed') {
    const current = state.connection.provider === 'cloudflare-managed'
      ? state.connection.publicUrl
      : String(setting('publicUrl', '') || '');
    const url = await promptPublicUrl(current);
    if (!url) return;
    cloudflareToken = await promptCloudflareTokenValue();
    if (!cloudflareToken) return;
    publicUrl = url;
    localUpdates.publicUrl = url;
  } else if (providerChoice.value === 'external') {
    const current = state.connection.provider === 'external'
      ? state.connection.publicUrl
      : String(setting('publicUrl', '') || '');
    const url = await promptPublicUrl(current);
    if (!url) return;
    publicUrl = url;
    localUpdates.publicUrl = url;
  }

  const sharedPatch = {
    provider: providerChoice.value,
    publicUrl
  };

  const stopState = await prepareConnectionMutation();
  if (cloudflareToken) await commitCloudflareConnection(context, cloudflareToken, localUpdates, sharedPatch);
  else await commitConnectionSettings(context, localUpdates, sharedPatch);

  if (stopState.remoteOwner) {
    vscode.window.showInformationMessage('DevMate connection settings saved. The active shared connection will converge to the new configuration automatically when its current generation ends.');
    return;
  }

  const start = await vscode.window.showInformationMessage(
    'DevMate connection settings saved.',
    'Start Now',
    'Open DevMate'
  );
  if (start === 'Start Now') await vscode.commands.executeCommand('devMate.start');
  if (start === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
}

async function connectionDoctor(context) {
  output.show(true);
  const settings = tunnelSettings(context);
  log('--- connection diagnostics ---');
  log(`Connection provider: ${settings.provider}`);
  log(`Stable public URL: ${settings.provider === 'ngrok' ? settings.ngrokUrl || 'not configured' : settings.publicUrl || 'not configured'}`);
  log(`Auto restart: ${settings.autoRestart ? 'enabled' : 'disabled'}; max restarts=${settings.maxRestarts}`);
  if (settings.provider === 'ngrok') {
    log(`ngrok Traffic Policy: ${settings.ngrokTrafficPolicyFile || 'not configured'}`);
    await vscode.commands.executeCommand('devMate.ngrokDoctor');
  } else if (settings.provider.startsWith('cloudflare')) {
    const command = settings.cloudflareCommandPath || 'cloudflared';
    const check = checkCommand(command);
    log(`cloudflared: ${check.ok ? check.output : `MISSING (${check.output})`}`);
    if (settings.provider === 'cloudflare-managed') {
      log(`Managed tunnel token: ${cloudflareTunnelToken ? 'configured' : 'not configured'}`);
    }
  } else {
    log('External provider: DevMate verifies the configured HTTPS URL and does not manage an ingress process.');
  }
  try {
    const runtime = tunnelStatus();
    log(`Runtime: ${JSON.stringify({
      running: runtime.running,
      owned: runtime.owned,
      attached: runtime.attached,
      provider: runtime.provider,
      publicUrl: runtime.publicUrl || null,
      port: runtime.port || null
    })}`);
  } catch (error) {
    log(`Runtime unavailable: ${error.message || error}`);
  }
  vscode.window.showInformationMessage('Connection diagnostics finished. See DevMate Connection output.');
}

function register(context, id, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

async function activate(context) {
  output = vscode.window.createOutputChannel('DevMate Connection');
  context.subscriptions.push(output);
  cloudflareTunnelToken = await context.secrets.get(CLOUDFLARE_TOKEN_SECRET) || '';

  register(context, 'devMate.connectionSetup', () => configureConnection(context));
  register(context, 'devMate.connectionDoctor', () => connectionDoctor(context));
  register(context, 'devMate.cloudflareSetToken', async () => {
    const token = await promptCloudflareTokenValue();
    if (!token) return;
    const stopState = await prepareCloudflareCredentialMutation(context, 'Cloudflare Tunnel token change');
    await storeCloudflareToken(context, token);
    if (stopState.remoteOwner) {
      vscode.window.showInformationMessage('Cloudflare Tunnel token saved securely. The next managed connection generation will use it.');
    } else if (stopState.reason === 'stopped') {
      const choice = await vscode.window.showInformationMessage('Cloudflare Tunnel token saved and the previous managed connection was stopped.', 'Start Now');
      if (choice === 'Start Now') await vscode.commands.executeCommand('devMate.start');
    } else {
      vscode.window.showInformationMessage('Cloudflare Tunnel token saved in VS Code Secret Storage.');
    }
  });
  register(context, 'devMate.cloudflareClearToken', async () => {
    const stopState = await prepareCloudflareCredentialMutation(context, 'Cloudflare Tunnel token removal');
    await context.secrets.delete(CLOUDFLARE_TOKEN_SECRET);
    cloudflareTunnelToken = '';
    vscode.window.showInformationMessage(stopState.reason === 'stopped'
      ? 'Cloudflare Tunnel token removed and the managed connection was stopped.'
      : 'Cloudflare Tunnel token removed from VS Code Secret Storage.');
  });
  register(context, 'devMate.openConnectionDocs', async () => {
    const provider = tunnelSettings(context).provider;
    await openExternal(provider.startsWith('cloudflare') ? CLOUDFLARE_DOCS : NGROK_POLICY_DOCS);
  });

  innerExtension = require('./extension-entry');
  await innerExtension.activate(context);
  const settings = tunnelSettings(context);
  log(`Connection integration ready: provider=${settings.provider}.`);
}

async function deactivate() {
  try {
    if (innerExtension?.deactivate) await innerExtension.deactivate();
  } finally {
    innerExtension = null;
  }
}

module.exports = {
  activate,
  cloudflareCredentialInUse,
  commitCloudflareConnection,
  configureConnection,
  connectionDoctor,
  deactivate,
  localTunnelSettings,
  prepareCloudflareCredentialMutation,
  prepareConnectionMutation,
  tunnelSettings
};