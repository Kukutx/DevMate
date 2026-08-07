'use strict';

const vscode = require('vscode');
const path = require('path');
const runtimeIo = require('./vscode-host/runtime-io.js');
const {
  TunnelCompatibilityManager,
  normalizePublicUrl
} = require('./tunnel-provider');
const {
  deploymentMode: validateDeploymentMode,
  strictInteger,
  tunnelMaxRestarts,
  tunnelProvider: validateTunnelProvider
} = require('./vscode-host/tunnel-settings.js');
const { readExtensionConfig, writeExtensionConfig } = require('./vscode-host/config-sync.js');

const CLOUDFLARE_TOKEN_SECRET = 'devMate.cloudflareTunnelToken';
const CLOUDFLARE_DOCS = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/';
const NGROK_POLICY_DOCS = 'https://ngrok.com/docs/traffic-policy/';

let innerExtension = null;
let output = null;
let cloudflareTunnelToken = '';
let originalSpawn = null;
let originalSpawnSync = null;
let originalHttpRequest = null;
let manager = null;

function cfg() {
  return vscode.workspace.getConfiguration('devMate');
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function configPath(context) {
  return path.join(context.globalStorageUri.fsPath, 'config.json');
}

function readJson(file) { return readExtensionConfig(file); }

function writeJson(file, value) {
  writeExtensionConfig(file, value);
}

function setting(name, fallback) {
  const value = cfg().get(name);
  return value === undefined ? fallback : value;
}

function strictBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function tunnelSettings() {
  const provider = validateTunnelProvider(String(setting('tunnelProvider', 'ngrok')).trim().toLowerCase());
  return {
    provider,
    publicUrl: String(setting('publicUrl', '') || '').trim(),
    cloudflareCommandPath: String(setting('cloudflareCommandPath', '') || '').trim(),
    ngrokTrafficPolicyFile: String(setting('ngrokTrafficPolicyFile', '') || '').trim(),
    autoRestart: strictBoolean(setting('tunnelAutoRestart', true), 'tunnelAutoRestart'),
    maxRestarts: tunnelMaxRestarts(setting('tunnelMaxRestarts', 10))
  };
}

function secretState() {
  return { cloudflareTunnelToken };
}

async function updateSetting(name, value) {
  await cfg().update(name, value, vscode.ConfigurationTarget.Global);
}

async function openExternal(url) {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function deploymentMode() {
  return validateDeploymentMode(String(setting('deploymentMode', 'personal')).trim().toLowerCase());
}

function hostFromPublicUrl(value) {
  try {
    return new URL(normalizePublicUrl(value)).host.toLowerCase();
  } catch {
    return '';
  }
}

function syncDeploymentConfig(context) {
  const file = configPath(context);
  const data = readJson(file);
  if (!data) return false;
  const mode = deploymentMode();
  const settings = tunnelSettings();
  data.deployment ||= {};
  data.deployment.mode = mode;
  data.deployment.tunnelProvider = settings.provider;
  data.deployment.publicUrl = settings.publicUrl ? normalizePublicUrl(settings.publicUrl) : '';
  data.team ||= {};
  data.team.enabled = mode !== 'personal';
  data.team.requireWorkspaceLeaseForWrites = strictBoolean(
    setting('teamRequireWorkspaceLeaseForWrites', mode !== 'personal'),
    'teamRequireWorkspaceLeaseForWrites'
  );
  data.production ||= {};
  data.production.maxRequestBytes = strictInteger(
    setting('productionMaxRequestBytes', 2097152), 2097152, 64 * 1024, 32 * 1024 * 1024, 'productionMaxRequestBytes'
  );
  data.production.requestsPerMinute = strictInteger(
    setting('productionRequestsPerMinute', mode === 'production' ? 120 : 600),
    mode === 'production' ? 120 : 600,
    10,
    10000,
    'productionRequestsPerMinute'
  );
  data.production.maxConcurrentRequests = strictInteger(
    setting('productionMaxConcurrentRequests', mode === 'production' ? 24 : 64),
    mode === 'production' ? 24 : 64,
    1,
    256,
    'productionMaxConcurrentRequests'
  );
  data.production.maxConcurrentPerPrincipal = strictInteger(
    setting('productionMaxConcurrentPerPrincipal', mode === 'production' ? 4 : 16),
    mode === 'production' ? 4 : 16,
    1,
    64,
    'productionMaxConcurrentPerPrincipal'
  );
  data.production.requestTimeoutMs = strictInteger(
    setting('productionRequestTimeoutMs', 900000), 900000, 1000, 60 * 60 * 1000, 'productionRequestTimeoutMs'
  );
  const configuredHosts = setting('allowedPublicHosts', []);
  if (!Array.isArray(configuredHosts)) throw new Error('allowedPublicHosts must be an array');
  const publicHost = hostFromPublicUrl(settings.publicUrl);
  data.production.allowedHosts = [...new Set(
    [...configuredHosts, publicHost]
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  writeJson(file, data);
  return true;
}

function checkCommand(command, args = ['--version']) {
  const result = originalSpawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  return {
    ok: !result.error && result.status === 0,
    output: String(result.stdout || result.stderr || result.error?.message || '').trim()
  };
}

async function promptCloudflareToken(context, title = 'DevMate · Cloudflare Tunnel Token') {
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Paste the remotely managed Cloudflare Tunnel token. It is stored only in VS Code Secret Storage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: input => String(input || '').trim().length < 30
      ? 'Tunnel token looks incomplete.'
      : null
  });
  if (value === undefined) return false;
  cloudflareTunnelToken = String(value).trim();
  await context.secrets.store(CLOUDFLARE_TOKEN_SECRET, cloudflareTunnelToken);
  log('Saved Cloudflare Tunnel token in VS Code Secret Storage.');
  return true;
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

async function configureDeployment(context) {
  output.show(true);
  const modeChoice = await vscode.window.showQuickPick([
    {
      label: '$(person) Personal',
      description: 'Single owner token and local-first defaults',
      value: 'personal'
    },
    {
      label: '$(organization) Team',
      description: 'Per-member tokens, roles, workspace scopes, and leases',
      value: 'team'
    },
    {
      label: '$(shield) Production',
      description: 'Stable endpoint, team RBAC, rate limits, host allowlist, and restart policy',
      value: 'production'
    }
  ], {
    title: 'DevMate · Deployment Mode',
    ignoreFocusOut: true
  });
  if (!modeChoice) return;

  const providerItems = [
    {
      label: '$(radio-tower) ngrok',
      description: 'Development or stable reserved endpoint; supports Traffic Policy',
      value: 'ngrok'
    },
    {
      label: '$(cloud) Cloudflare managed tunnel',
      description: 'Recommended Cloudflare option for stable team/production deployments',
      value: 'cloudflare-managed'
    },
    {
      label: '$(link) External reverse proxy',
      description: 'Use an existing HTTPS ingress, load balancer, VPN, or tunnel',
      value: 'external'
    }
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

  await updateSetting('deploymentMode', modeChoice.value);
  await updateSetting('tunnelProvider', providerChoice.value);

  if (providerChoice.value !== 'ngrok') await updateSetting('ngrokUseManagedAccount', false);
  if (providerChoice.value === 'ngrok') {
    const policyChoice = await vscode.window.showQuickPick([
      { label: 'Continue with current ngrok setup', value: 'keep' },
      { label: 'Open ngrok account setup', value: 'setup' },
      { label: 'Open Traffic Policy documentation', value: 'policy' }
    ], { title: 'DevMate · ngrok Deployment' });
    if (policyChoice?.value === 'setup') await vscode.commands.executeCommand('devMate.ngrokSetup');
    if (policyChoice?.value === 'policy') await openExternal(NGROK_POLICY_DOCS);
  }
  if (providerChoice.value === 'cloudflare-quick') {
    const command = String(setting('cloudflareCommandPath', '') || 'cloudflared');
    const check = checkCommand(command);
    if (!check.ok) {
      vscode.window.showWarningMessage(
        `cloudflared was not detected: ${check.output || 'unknown error'}`,
        'Open Cloudflare Docs'
      ).then(choice => choice && openExternal(CLOUDFLARE_DOCS));
    }
  }
  if (providerChoice.value === 'cloudflare-managed') {
    if (!await promptCloudflareToken(context)) return;
    const url = await promptPublicUrl(String(setting('publicUrl', '') || ''));
    if (!url) return;
    await updateSetting('publicUrl', url);
  }
  if (providerChoice.value === 'external') {
    const url = await promptPublicUrl(String(setting('publicUrl', '') || ''));
    if (!url) return;
    await updateSetting('publicUrl', url);
  }

  if (modeChoice.value !== 'personal') await updateSetting('teamRequireWorkspaceLeaseForWrites', true);
  syncDeploymentConfig(context);
  await vscode.commands.executeCommand('devMate.stop');
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
  syncDeploymentConfig(context);
  const settings = tunnelSettings();
  log('--- deployment/tunnel diagnostics ---');
  log(`Deployment mode: ${deploymentMode()}`);
  log(`Tunnel provider: ${settings.provider}`);
  log(`Public URL: ${settings.publicUrl || 'not configured'}`);
  log(`Auto restart: ${settings.autoRestart ? 'enabled' : 'disabled'}; max restarts=${settings.maxRestarts}`);
  if (settings.provider === 'ngrok') {
    log(`ngrok Traffic Policy: ${settings.ngrokTrafficPolicyFile || 'not configured'}`);
    await vscode.commands.executeCommand('devMate.ngrokDoctor');
  } else if (settings.provider.startsWith('cloudflare')) {
    const command = settings.cloudflareCommandPath || 'cloudflared';
    const check = checkCommand(command);
    log(`cloudflared: ${check.ok ? check.output : `MISSING (${check.output})`}`);
    log(`Managed tunnel token: ${cloudflareTunnelToken ? 'configured' : 'not configured'}`);
  } else {
    log('External provider: DevMate will verify the configured URL but will not manage its process.');
  }
  log(`Runtime: ${JSON.stringify(manager.diagnostics())}`);
  vscode.window.showInformationMessage('Deployment diagnostics finished. See DevMate Deployment output.');
}

function register(context, id, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

function installProcessWrappers() {
  originalSpawn = runtimeIo.spawn;
  originalSpawnSync = runtimeIo.spawnSync;
  originalHttpRequest = runtimeIo.httpRequest;
  manager = new TunnelCompatibilityManager({
    settings: tunnelSettings,
    secrets: secretState,
    log
  });
  runtimeIo.spawn = manager.wrapSpawn(originalSpawn);
  runtimeIo.spawnSync = manager.wrapSpawnSync(originalSpawnSync);
  runtimeIo.httpRequest = manager.wrapHttpRequest(originalHttpRequest);
}

function restoreProcessWrappers() {
  if (originalSpawn) runtimeIo.spawn = originalSpawn;
  if (originalSpawnSync) runtimeIo.spawnSync = originalSpawnSync;
  if (originalHttpRequest) runtimeIo.httpRequest = originalHttpRequest;
  originalSpawn = null;
  originalSpawnSync = null;
  originalHttpRequest = null;
}

async function activate(context) {
  output = vscode.window.createOutputChannel('DevMate Deployment');
  context.subscriptions.push(output);
  cloudflareTunnelToken = await context.secrets.get(CLOUDFLARE_TOKEN_SECRET) || '';
  installProcessWrappers();

  register(context, 'devMate.deploymentSetup', () => configureDeployment(context));
  register(context, 'devMate.tunnelSetup', () => configureDeployment(context));
  register(context, 'devMate.tunnelDoctor', () => tunnelDoctor(context));
  register(context, 'devMate.cloudflareSetToken', () => promptCloudflareToken(context));
  register(context, 'devMate.cloudflareClearToken', async () => {
    await context.secrets.delete(CLOUDFLARE_TOKEN_SECRET);
    cloudflareTunnelToken = '';
    manager.stop();
    vscode.window.showInformationMessage('Cloudflare Tunnel token removed from VS Code Secret Storage.');
  });
  register(context, 'devMate.openTunnelDocs', async () => {
    const provider = tunnelSettings().provider;
    await openExternal(provider.startsWith('cloudflare') ? CLOUDFLARE_DOCS : NGROK_POLICY_DOCS);
  });

  if (tunnelSettings().provider !== 'ngrok' && setting('ngrokUseManagedAccount', true) !== false) {
    await updateSetting('ngrokUseManagedAccount', false);
  }

  const entry = './extension-entry';
  innerExtension = require(entry);
  await innerExtension.activate(context);
  syncDeploymentConfig(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('devMate')) return;
    try {
      syncDeploymentConfig(context);
    } catch (error) {
      log(`Could not synchronize deployment config: ${error.message || error}`);
    }
  }));
  log(`Deployment integration ready: mode=${deploymentMode()} provider=${tunnelSettings().provider}.`);
}

async function deactivate() {
  try {
    if (innerExtension?.deactivate) await innerExtension.deactivate();
  } finally {
    manager?.stop();
    restoreProcessWrappers();
    innerExtension = null;
    manager = null;
  }
}

module.exports = { activate, deactivate };
