'use strict';

const childProcess = require('node:child_process');
const vscode = require('vscode');
const path = require('path');
const { normalizeNgrokUrl } = require('./ngrok-support.js');
const { normalizePublicUrl } = require('./tunnel-provider');
const { allowedHosts, publicHost, stablePublicUrl } = require('./vscode-host/deployment-public-url.js');
const { settingsFromState } = require('./vscode-host/effective-tunnel-settings.js');
const {
  applyDeploymentPatch,
  readDeploymentConfig
} = require('./vscode-host/shared-deployment-config.js');
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
    log('Cloudflare managed credential is changing while the current tunnel is managed by another host; that process keeps its existing environment until its owner stops it.');
  }
  return stopState;
}

async function updateSetting(name, value) {
  await cfg().update(name, value, vscode.ConfigurationTarget.Global);
}

async function commitDeploymentSettings(context, localUpdates, sharedPatch) {
  const previous = new Map();
  const applied = [];
  try {
    for (const [name, value] of Object.entries(localUpdates)) {
      previous.set(name, setting(name, undefined));
      await updateSetting(name, value);
      applied.push(name);
    }
    applyDeploymentPatch(configPath(context), sharedPatch);
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

async function commitCloudflareDeployment(context, token, localUpdates, sharedPatch) {
  const previousToken = await context.secrets.get(CLOUDFLARE_TOKEN_SECRET) || '';
  try {
    await storeCloudflareToken(context, token);
    await commitDeploymentSettings(context, localUpdates, sharedPatch);
  } catch (error) {
    try {
      await restoreCloudflareToken(context, previousToken);
      log('Restored the previous Cloudflare Tunnel token after deployment configuration failed.');
    } catch (rollbackError) {
      error.secretRollbackError = rollbackError?.message || String(rollbackError);
      log(`Could not restore the previous Cloudflare Tunnel token: ${error.secretRollbackError}`);
    }
    throw error;
  }
}

async function prepareDeploymentMutation() {
  const stopResult = await stopTunnel();
  const state = assertTunnelSafeForCredentialChange(stopResult, 'deployment configuration change');
  if (state.remoteOwner) {
    log('The current public ingress is managed by another host. New shared deployment settings may be saved, but that owner must stop its stale generation before the replacement provider can start.');
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
    prompt: 'Production ngrok requires a stable account-owned URL. Enter the hostname or HTTPS origin without /mcp.',
    value: current,
    ignoreFocusOut: true,
    validateInput: input => {
      try {
        normalizeNgrokUrl(input);
        return null;
      } catch (error) {
        return error.message;
      }
    }
  });
  return value === undefined ? null : normalizeNgrokUrl(value);
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

function productionHostsForUrl(state, nextUrl) {
  const previousHost = publicHost(state?.deployment?.publicUrl || '');
  const retained = (state?.allowedHosts || []).filter(host => host !== previousHost);
  return allowedHosts(retained, nextUrl);
}

async function configureDeployment(context) {
  output.show(true);
  let state = readDeploymentConfig(configPath(context));
  if (!state) throw new Error('DevMate shared config is not initialized');

  const modeChoice = await vscode.window.showQuickPick([
    { label: '$(person) Personal', description: 'Single owner token and local-first defaults', value: 'personal' },
    { label: '$(organization) Team', description: 'Per-member tokens, roles, workspace scopes, and leases', value: 'team' },
    { label: '$(shield) Production', description: 'Stable endpoint, team RBAC, rate limits, host allowlist, and restart policy', value: 'production' }
  ], {
    title: 'DevMate · Deployment Mode',
    ignoreFocusOut: true
  });
  if (!modeChoice) return;

  const providerItems = [
    { label: '$(radio-tower) ngrok', description: 'Development or stable reserved endpoint; supports Traffic Policy', value: 'ngrok' },
    { label: '$(cloud) Cloudflare managed tunnel', description: 'Stable managed team/production ingress', value: 'cloudflare-managed' },
    { label: '$(link) External reverse proxy', description: 'Existing HTTPS ingress, load balancer, VPN, or tunnel', value: 'external' }
  ];
  if (modeChoice.value !== 'production') {
    providerItems.splice(1, 0, {
      label: '$(beaker) Cloudflare Quick Tunnel',
      description: 'Temporary TryCloudflare URL for testing only',
      value: 'cloudflare-quick'
    });
  }
  const providerChoice = await vscode.window.showQuickPick(providerItems, {
    title: 'DevMate · Tunnel Provider',
    ignoreFocusOut: true
  });
  if (!providerChoice) return;

  const localUpdates = {};
  let stableUrl = '';
  let cloudflareToken = null;

  if (providerChoice.value === 'ngrok') {
    const policyChoice = await vscode.window.showQuickPick([
      { label: 'Continue with current ngrok setup', value: 'keep' },
      { label: 'Open ngrok account setup', value: 'setup' },
      { label: 'Open Traffic Policy documentation', value: 'policy' }
    ], { title: 'DevMate · ngrok Deployment' });
    if (!policyChoice) return;
    if (policyChoice.value === 'setup') {
      if (typeof innerExtension?.setupForDeployment !== 'function') {
        throw new Error('Embedded ngrok deployment setup is unavailable');
      }
      const configured = await innerExtension.setupForDeployment(context);
      if (!configured) return;
      state = readDeploymentConfig(configPath(context));
      if (!state) throw new Error('DevMate shared config disappeared during ngrok setup');
    }
    if (policyChoice.value === 'policy') await openExternal(NGROK_POLICY_DOCS);
    if (modeChoice.value === 'production') {
      const current = state.deployment.tunnelProvider === 'ngrok'
        ? state.deployment.publicUrl
        : String(setting('ngrokUrl', '') || '');
      const url = await promptStableNgrokUrl(current);
      if (!url) return;
      stableUrl = url;
      localUpdates.ngrokUrl = url;
    } else {
      stableUrl = state.deployment.tunnelProvider === 'ngrok'
        ? state.deployment.publicUrl
        : stablePublicUrl({ provider: 'ngrok', ngrokUrl: setting('ngrokUrl', '') });
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
    const current = state.deployment.tunnelProvider === 'cloudflare-managed'
      ? state.deployment.publicUrl
      : String(setting('publicUrl', '') || '');
    const url = await promptPublicUrl(current);
    if (!url) return;
    cloudflareToken = await promptCloudflareTokenValue();
    if (!cloudflareToken) return;
    stableUrl = url;
    localUpdates.publicUrl = url;
  } else if (providerChoice.value === 'external') {
    const current = state.deployment.tunnelProvider === 'external'
      ? state.deployment.publicUrl
      : String(setting('publicUrl', '') || '');
    const url = await promptPublicUrl(current);
    if (!url) return;
    stableUrl = url;
    localUpdates.publicUrl = url;
  }

  const sharedPatch = {
    mode: modeChoice.value,
    tunnelProvider: providerChoice.value,
    publicUrl: stableUrl,
    requireWorkspaceLeaseForWrites: modeChoice.value === 'personal'
      ? state.leaseRequired
      : true
  };
  if (modeChoice.value === 'production') {
    sharedPatch.allowedHosts = productionHostsForUrl(state, stableUrl);
  }

  const stopState = await prepareDeploymentMutation();
  if (cloudflareToken) await commitCloudflareDeployment(context, cloudflareToken, localUpdates, sharedPatch);
  else await commitDeploymentSettings(context, localUpdates, sharedPatch);

  if (stopState.remoteOwner) {
    const choice = await vscode.window.showWarningMessage(
      'DevMate deployment settings were saved, but the previous public ingress is owned by another host. Wait for that host to stop its stale generation before starting the replacement provider.',
      'Open DevMate'
    );
    if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
    return;
  }

  const start = await vscode.window.showInformationMessage(
    'DevMate deployment settings saved.',
    'Start Now',
    'Open DevMate'
  );
  if (start === 'Start Now') await vscode.commands.executeCommand('devMate.start');
  if (start === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
}

async function tunnelDoctor(context) {
  output.show(true);
  const settings = tunnelSettings(context);
  log('--- deployment/tunnel diagnostics ---');
  log(`Deployment mode: ${settings.deploymentMode}`);
  log(`Tunnel provider: ${settings.provider}`);
  log(`Stable public URL: ${settings.provider === 'ngrok' ? settings.ngrokUrl : settings.publicUrl || 'not configured'}`);
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
    log('External provider: DevMate verifies the shared configured URL and does not manage an ingress process.');
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
  vscode.window.showInformationMessage('Deployment diagnostics finished. See DevMate Deployment output.');
}

function register(context, id, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

async function activate(context) {
  output = vscode.window.createOutputChannel('DevMate Deployment');
  context.subscriptions.push(output);
  cloudflareTunnelToken = await context.secrets.get(CLOUDFLARE_TOKEN_SECRET) || '';

  register(context, 'devMate.deploymentSetup', () => configureDeployment(context));
  register(context, 'devMate.tunnelSetup', () => configureDeployment(context));
  register(context, 'devMate.tunnelDoctor', () => tunnelDoctor(context));
  register(context, 'devMate.cloudflareSetToken', async () => {
    const token = await promptCloudflareTokenValue();
    if (!token) return;
    const stopState = await prepareCloudflareCredentialMutation(context, 'Cloudflare Tunnel token change');
    await storeCloudflareToken(context, token);
    if (stopState.remoteOwner) {
      vscode.window.showInformationMessage('Cloudflare Tunnel token saved locally. The tunnel managed by another host keeps its existing process token until its owner stops it.');
    } else if (stopState.reason === 'stopped') {
      const choice = await vscode.window.showInformationMessage('Cloudflare Tunnel token saved and the previous managed tunnel was stopped.', 'Start Now');
      if (choice === 'Start Now') await vscode.commands.executeCommand('devMate.start');
    } else {
      vscode.window.showInformationMessage('Cloudflare Tunnel token saved in VS Code Secret Storage.');
    }
  });
  register(context, 'devMate.cloudflareClearToken', async () => {
    const stopState = await prepareCloudflareCredentialMutation(context, 'Cloudflare Tunnel token removal');
    await context.secrets.delete(CLOUDFLARE_TOKEN_SECRET);
    cloudflareTunnelToken = '';
    vscode.window.showInformationMessage(stopState.remoteOwner
      ? 'Cloudflare Tunnel token removed locally. The tunnel managed by another host keeps its existing process token until that owner stops it.'
      : stopState.reason === 'stopped'
        ? 'Cloudflare Tunnel token removed and the managed tunnel was stopped.'
        : 'Cloudflare Tunnel token removed from VS Code Secret Storage.');
  });
  register(context, 'devMate.openTunnelDocs', async () => {
    const provider = tunnelSettings(context).provider;
    await openExternal(provider.startsWith('cloudflare') ? CLOUDFLARE_DOCS : NGROK_POLICY_DOCS);
  });

  innerExtension = require('./extension-entry');
  await innerExtension.activate(context);
  const settings = tunnelSettings(context);
  log(`Deployment integration ready: mode=${settings.deploymentMode} provider=${settings.provider}.`);
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
  commitCloudflareDeployment,
  configureDeployment,
  deactivate,
  localTunnelSettings,
  prepareCloudflareCredentialMutation,
  prepareDeploymentMutation,
  tunnelSettings
};
