'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');
const { normalizeNgrokUrl, validateAuthtoken } = require('./ngrok-support');
const {
  activeNgrokConnection,
  configuredNgrokUrl,
  writeActiveNgrokUrl
} = require('./vscode-host/ngrok-connection-state.js');
const { stopTunnel, tunnelStatus } = require('./vscode-host/tunnel-runtime.js');
const {
  assertTunnelSafeForCredentialChange,
  credentialProviderInUse
} = require('./vscode-host/tunnel-stop-policy.js');

const SECRET_KEY = 'devMate.ngrokAuthtoken';
const NGROK_SETUP_URL = 'https://dashboard.ngrok.com/get-started/setup';

let baseExtension = null;
let managedAuthtoken = '';
let setupOutput = null;
let activationAttempted = false;
let activated = false;
let sharedConfigFile = '';

function config() {
  return vscode.workspace.getConfiguration('devMate');
}

function preferenceValue(name, fallback) {
  const value = config().get(name);
  return value === undefined ? fallback : value;
}

async function updatePreference(name, value) {
  await config().update(name, value, vscode.ConfigurationTarget.Global);
}

function ngrokCommand() {
  return String(preferenceValue('ngrokCommandPath', '') || 'ngrok').trim() || 'ngrok';
}

function usesManagedAccount() { return preferenceValue('ngrokUseManagedAccount', false) === true; }

function machineConfiguredUrl() {
  return String(preferenceValue('ngrokUrl', '') || '').trim();
}

function configuredUrl() {
  return configuredNgrokUrl(sharedConfigFile, machineConfiguredUrl());
}

function poolingEnabled() {
  return preferenceValue('ngrokPoolingEnabled', false) === true;
}

function log(message) {
  setupOutput?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function openExternal(url) {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function register(context, id, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

async function offerStartAgain(message) {
  const choice = await vscode.window.showInformationMessage(message, 'Start Now', 'Open DevMate');
  if (choice === 'Start Now') await vscode.commands.executeCommand('devMate.start');
  if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
}

function loadBaseExtension() {
  return require('./extension');
}

function currentTunnelRuntime() {
  try { return tunnelStatus(); }
  catch { return { running: false, provider: '', record: null }; }
}

function ngrokCredentialInUse() {
  const connection = activeNgrokConnection(sharedConfigFile);
  const runtime = currentTunnelRuntime();
  return credentialProviderInUse('ngrok', {
    configuredProvider: connection?.provider || '',
    runtimeProvider: runtime?.provider || '',
    runtimeRunning: runtime?.running === true
  });
}

async function prepareNgrokCredentialMutation(operation) {
  if (!ngrokCredentialInUse()) {
    return { safe: true, remoteOwner: false, reason: 'credential-dormant', tunnel: null };
  }
  const stopState = assertTunnelSafeForCredentialChange(await stopTunnel(), operation);
  if (stopState.remoteOwner) {
    log('ngrok credential changed while the currently shared ngrok connection is active in another desktop process.');
  }
  return stopState;
}

async function promptAuthtokenValue(title = 'DevMate · ngrok Account') {
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Paste the ngrok account Authtoken. It is stored only in VS Code Secret Storage, never in the project or DevMate config.json.',
    password: true,
    ignoreFocusOut: true,
    validateInput: input => {
      try { validateAuthtoken(input); return null; } catch (error) { return error.message; }
    }
  });
  return value === undefined ? null : validateAuthtoken(value);
}

async function promptStableUrlValue(current = configuredUrl()) {
  const value = await vscode.window.showInputBox({
    title: 'DevMate · Stable ngrok URL',
    prompt: 'Optional URL or hostname owned by the selected account. Do not append /mcp.',
    value: current,
    ignoreFocusOut: true,
    validateInput: input => {
      if (!String(input || '').trim()) return null;
      try { normalizeNgrokUrl(input); return null; } catch (error) { return error.message; }
    }
  });
  if (value === undefined) return null;
  return String(value || '').trim() ? normalizeNgrokUrl(value) : '';
}

async function chooseDomain({ includeKeep = true, current = configuredUrl() } = {}) {
  const items = [
    {
      label: '$(sparkle) Use account default development domain (recommended)',
      description: 'Lowest-friction setup and safest choice when changing accounts',
      value: 'default'
    },
    {
      label: '$(globe) Configure a stable URL',
      description: 'Optional developer/deployment choice; the URL must belong to the selected ngrok account',
      value: 'custom'
    }
  ];
  if (includeKeep && current) {
    items.push({
      label: '$(debug-pause) Keep current stable URL',
      description: `${current} — only keep it if the selected account owns it`,
      value: 'keep'
    });
  } else if (includeKeep) {
    items.push({
      label: '$(debug-pause) Keep current setting',
      description: 'No stable URL is currently configured',
      value: 'keep'
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: 'DevMate · ngrok URL',
    placeHolder: 'Choose the public URL strategy for DevMate',
    ignoreFocusOut: true
  });
  if (!choice) return { cancelled: true, changed: false, url: current };
  if (choice.value === 'keep') return { cancelled: false, changed: false, url: current };
  if (choice.value === 'default') return { cancelled: false, changed: true, url: '' };
  const url = await promptStableUrlValue(current);
  if (url === null) return { cancelled: true, changed: false, url: current };
  return { cancelled: false, changed: true, url };
}

async function persistConfiguredUrl(value) {
  const normalized = value ? normalizeNgrokUrl(value) : '';
  writeActiveNgrokUrl(sharedConfigFile, normalized);
  await updatePreference('ngrokUrl', normalized);
  return normalized;
}

async function restoreSecret(context, previousToken) {
  if (previousToken) await context.secrets.store(SECRET_KEY, previousToken);
  else await context.secrets.delete(SECRET_KEY);
  managedAuthtoken = previousToken || '';
}

async function commitNgrokConfiguration(context, {
  token,
  useManagedAccount,
  domain,
  pooling = false
} = {}) {
  const previous = {
    token: managedAuthtoken,
    useManagedAccount: usesManagedAccount(),
    machineUrl: machineConfiguredUrl(),
    pooling: poolingEnabled(),
    activeConnection: activeNgrokConnection(sharedConfigFile)
  };

  await prepareNgrokCredentialMutation('ngrok configuration change');
  try {
    if (token !== undefined) {
      await context.secrets.store(SECRET_KEY, validateAuthtoken(token));
      managedAuthtoken = validateAuthtoken(token);
    }
    if (useManagedAccount !== undefined) await updatePreference('ngrokUseManagedAccount', !!useManagedAccount);
    if (domain?.changed) await persistConfiguredUrl(domain.url);
    if (pooling !== undefined) await updatePreference('ngrokPoolingEnabled', !!pooling);
  } catch (error) {
    try { await restoreSecret(context, previous.token); } catch {}
    try { await updatePreference('ngrokUseManagedAccount', previous.useManagedAccount); } catch {}
    try {
      if (previous.activeConnection) writeActiveNgrokUrl(sharedConfigFile, previous.activeConnection.publicUrl);
    } catch {}
    try { await updatePreference('ngrokUrl', previous.machineUrl); } catch {}
    try { await updatePreference('ngrokPoolingEnabled', previous.pooling); } catch {}
    throw error;
  }
}

function checkNgrokInstalled() {
  const result = childProcess.spawnSync(ngrokCommand(), ['version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  if (result.error || result.status !== 0) {
    return { ok: false, message: String(result.stderr || result.stdout || result.error?.message || 'ngrok not found').trim() };
  }
  return { ok: true, version: String(result.stdout || '').trim().split(/\r?\n/)[0] };
}

async function ensureNgrokInstalled() {
  const installed = checkNgrokInstalled();
  log(installed.ok ? `ngrok detected: ${installed.version}` : `ngrok check failed: ${installed.message}`);
  if (installed.ok) return true;
  const action = await vscode.window.showErrorMessage(
    'ngrok was not detected. Install ngrok, then run DevMate setup again.',
    'Open Install Page'
  );
  if (action === 'Open Install Page') await openExternal(NGROK_SETUP_URL);
  return false;
}

async function recommendedSetup(context, { offerStart = true } = {}) {
  const token = await promptAuthtokenValue('DevMate · Quick ngrok Setup');
  if (!token) return false;
  await commitNgrokConfiguration(context, {
    token,
    useManagedAccount: true,
    domain: { cancelled: false, changed: true, url: '' },
    pooling: false
  });
  log('Completed recommended ngrok setup.');
  if (offerStart) await offerStartAgain('ngrok setup is complete.');
  return true;
}

async function advancedSetup(context, { offerStart = true } = {}) {
  const accountChoice = await vscode.window.showQuickPick([
    {
      label: '$(key) Let DevMate manage the ngrok account',
      description: 'Stores the Authtoken in VS Code Secret Storage and supports one-step account switching',
      value: 'managed'
    },
    {
      label: '$(settings-gear) Use the global ngrok configuration',
      description: 'Uses ngrok.yml; intended for developers who already manage multiple agents',
      value: 'global'
    }
  ], {
    title: 'DevMate · Developer ngrok Setup',
    placeHolder: 'Choose how DevMate should manage the ngrok account',
    ignoreFocusOut: true
  });
  if (!accountChoice) return false;

  let token;
  if (accountChoice.value === 'managed') {
    token = await promptAuthtokenValue();
    if (!token) return false;
  }
  const domain = await chooseDomain();
  if (domain.cancelled) return false;

  await commitNgrokConfiguration(context, {
    ...(token ? { token } : {}),
    useManagedAccount: accountChoice.value === 'managed',
    domain,
    pooling: false
  });
  log(`Configured DevMate to use ${accountChoice.value === 'managed' ? 'a managed ngrok account' : 'the global ngrok configuration'}.`);
  if (offerStart) await offerStartAgain('Advanced ngrok setup is complete.');
  return true;
}

async function guidedSetup(context, { offerStart = true } = {}) {
  setupOutput.show(true);
  if (!await ensureNgrokInstalled()) return false;

  const choice = await vscode.window.showQuickPick([
    {
      label: '$(rocket) Quick setup (recommended)',
      description: 'Paste one Authtoken; DevMate uses the account default development domain',
      value: 'recommended'
    },
    {
      label: '$(tools) Developer setup',
      description: 'Choose global ngrok.yml or a DevMate-managed account and URL strategy',
      value: 'advanced'
    },
    {
      label: '$(link-external) Open ngrok dashboard',
      description: 'Get an Authtoken, inspect domains, or manage active agents',
      value: 'dashboard'
    }
  ], {
    title: 'DevMate · ngrok Setup',
    placeHolder: 'Choose a setup path',
    ignoreFocusOut: true
  });
  if (!choice) return false;
  if (choice.value === 'recommended') return recommendedSetup(context, { offerStart });
  if (choice.value === 'advanced') return advancedSetup(context, { offerStart });
  if (choice.value === 'dashboard') await openExternal(NGROK_SETUP_URL);
  return false;
}

async function setupForConnection(context) {
  return guidedSetup(context, { offerStart: false });
}

async function switchAccount(context) {
  setupOutput.show(true);
  if (!await ensureNgrokInstalled()) return;
  const token = await promptAuthtokenValue('DevMate · Switch ngrok Account');
  if (!token) return;

  const current = configuredUrl();
  const choices = [
    {
      label: '$(sparkle) Use the new account default domain (recommended)',
      description: 'Prevents the previous account domain from causing ownership errors',
      value: 'default'
    }
  ];
  if (current) {
    choices.push({
      label: '$(pin) Keep the current stable URL',
      description: `${current} — only choose this if the new account owns it`,
      value: 'keep'
    });
  }
  choices.push({
    label: '$(globe) Choose another stable URL',
    description: 'Configure a URL owned by the new account',
    value: 'custom'
  });

  const domainChoice = await vscode.window.showQuickPick(choices, {
    title: 'DevMate · Domain after account switch',
    placeHolder: 'The default domain is safest after switching accounts',
    ignoreFocusOut: true
  });
  if (!domainChoice) return;

  let domain;
  if (domainChoice.value === 'default') domain = { changed: true, url: '' };
  else if (domainChoice.value === 'keep') domain = { changed: false, url: current };
  else {
    const url = await promptStableUrlValue(current);
    if (url === null) return;
    domain = { changed: true, url };
  }

  await commitNgrokConfiguration(context, {
    token,
    useManagedAccount: true,
    domain,
    pooling: false
  });
  log('Switched the DevMate-managed ngrok account with a complete domain decision.');
  await offerStartAgain('DevMate now uses the new ngrok account.');
}

async function clearManagedAccount(context) {
  const confirm = await vscode.window.showWarningMessage(
    'Delete the ngrok Authtoken stored by DevMate in VS Code Secret Storage? DevMate will then use the global ngrok configuration.',
    { modal: true },
    'Delete and Use Global Config'
  );
  if (confirm !== 'Delete and Use Global Config') return;
  const stopState = await prepareNgrokCredentialMutation('ngrok managed-account removal');
  await context.secrets.delete(SECRET_KEY);
  managedAuthtoken = '';
  await updatePreference('ngrokUseManagedAccount', false);
  vscode.window.showInformationMessage(stopState.reason === 'stopped'
    ? 'Deleted the DevMate-managed ngrok credential and stopped the active managed connection.'
    : 'Deleted the DevMate-managed ngrok credential.');
}

async function ngrokDoctor() {
  setupOutput.show(true);
  const installed = checkNgrokInstalled();
  const managed = usesManagedAccount();
  const connection = activeNgrokConnection(sharedConfigFile);
  log('--- ngrok diagnostics ---');
  log(`Executable: ${ngrokCommand()}`);
  log(`Installed: ${installed.ok ? installed.version : `NO (${installed.message})`}`);
  log(`Account source: ${managed ? 'DevMate-managed Secret Storage' : 'machine ngrok config/environment'}`);
  log(`Managed token present: ${managedAuthtoken ? 'yes' : 'no'}`);
  log(`Machine NGROK_AUTHTOKEN present: ${process.env.NGROK_AUTHTOKEN ? 'yes' : 'no'}`);
  log(`Ready to launch: ${installed.ok && (!managed || !!managedAuthtoken) ? 'yes' : 'no'}`);
  log(`Connection: ${connection ? 'ngrok is the active shared provider' : 'ngrok is not the active shared provider'}`);
  log(`Effective configured URL: ${configuredUrl() || 'account default / dynamic'}`);
  log(`Pooling: ${poolingEnabled() ? 'enabled (not recommended)' : 'disabled (recommended)'}`);

  const configCheck = childProcess.spawnSync(ngrokCommand(), ['config', 'check'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env: managed && managedAuthtoken ? { ...process.env, NGROK_AUTHTOKEN: managedAuthtoken } : process.env
  });
  log(`Configuration check: ${String(configCheck.stdout || configCheck.stderr || configCheck.error?.message || 'no output').trim()}`);
  vscode.window.showInformationMessage('ngrok diagnostics finished. See DevMate Setup output.');
}

async function maybePromptForNgrokSetup(context) {
  if (managedAuthtoken || !usesManagedAccount()) return;
  if (context.globalState.get('devMate.ngrokSetupPrompted')) return;
  await context.globalState.update('devMate.ngrokSetupPrompted', true);
  const action = await vscode.window.showInformationMessage(
    'Set up ngrok once so DevMate can start securely and switch accounts without editing ngrok.yml.',
    'Quick Setup',
    'Use Global Config'
  );
  if (action === 'Quick Setup') await vscode.commands.executeCommand('devMate.ngrokSetup');
  if (action === 'Use Global Config') {
    await prepareNgrokCredentialMutation('ngrok account source change');
    await updatePreference('ngrokUseManagedAccount', false);
  }
}

async function activate(context) {
  if (activationAttempted || activated) {
    const error = new Error('DevMate ngrok setup integration is already active');
    error.code = 'DEVMATE_NGROK_SETUP_ALREADY_ACTIVE';
    throw error;
  }
  activationAttempted = true;
  setupOutput = vscode.window.createOutputChannel('DevMate Setup');
  context.subscriptions.push(setupOutput);
  managedAuthtoken = await context.secrets.get(SECRET_KEY) || '';
  sharedConfigFile = path.join(context.globalStorageUri.fsPath, 'config.json');

  register(context, 'devMate.ngrokSetup', () => guidedSetup(context));
  register(context, 'devMate.ngrokSwitchAccount', () => switchAccount(context));
  register(context, 'devMate.ngrokClearAccount', () => clearManagedAccount(context));
  register(context, 'devMate.ngrokDoctor', () => ngrokDoctor());
  register(context, 'devMate.openNgrokDashboard', () => openExternal(NGROK_SETUP_URL));

  try {
    baseExtension = loadBaseExtension();
    await baseExtension.activate(context);
    activated = true;
    log(`ngrok setup integration ready. Account source: ${usesManagedAccount() ? 'managed' : 'machine'}; managed token: ${managedAuthtoken ? 'configured' : 'not configured'}.`);
    void maybePromptForNgrokSetup(context);
  } catch (error) {
    try { if (baseExtension?.deactivate) await baseExtension.deactivate(); } catch {}
    activationAttempted = false;
    activated = false;
    sharedConfigFile = '';
    throw error;
  }
}

async function deactivate() {
  if (!activationAttempted && !activated) return;
  try {
    if (activationAttempted && baseExtension?.deactivate) await baseExtension.deactivate();
  } finally {
    activationAttempted = false;
    activated = false;
    baseExtension = null;
    setupOutput = null;
    sharedConfigFile = '';
  }
}

function runtimeDiagnostics() {
  try { return baseExtension?.runtimeDiagnostics?.() || null; }
  catch (error) { return { error: String(error.message || error) }; }
}

module.exports = {
  activate,
  deactivate,
  runtimeDiagnostics,
  loadBaseExtension,
  prepareNgrokCredentialMutation,
  setupForConnection
};