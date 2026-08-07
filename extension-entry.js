'use strict';

const childProcess = require('node:child_process');
const vscode = require('vscode');
const { normalizeNgrokUrl, validateAuthtoken } = require('./ngrok-support');

const SECRET_KEY = 'devMate.ngrokAuthtoken';
const NGROK_SETUP_URL = 'https://dashboard.ngrok.com/get-started/setup';

let baseExtension = null;
let managedAuthtoken = '';
let setupOutput = null;
let activationAttempted = false;
let activated = false;

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

function usesManagedAccount() {
  return preferenceValue('ngrokUseManagedAccount', true) !== false;
}

function configuredUrl() {
  return String(preferenceValue('ngrokUrl', '') || '').trim();
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

async function saveManagedAuthtoken(context, value) {
  const token = validateAuthtoken(value);
  await context.secrets.store(SECRET_KEY, token);
  managedAuthtoken = token;
  await updatePreference('ngrokUseManagedAccount', true);
  log('Saved a DevMate-managed ngrok Authtoken in VS Code Secret Storage.');
}

async function promptForAuthtoken(context, title = 'DevMate · ngrok Account') {
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Paste the ngrok account Authtoken. It is stored only in VS Code Secret Storage, never in the project or DevMate config.json.',
    password: true,
    ignoreFocusOut: true,
    validateInput: input => {
      try { validateAuthtoken(input); return null; } catch (error) { return error.message; }
    }
  });
  if (value === undefined) return false;
  await saveManagedAuthtoken(context, value);
  return true;
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

async function configureDomain({ includeKeep = true } = {}) {
  const current = configuredUrl();
  const items = [
    {
      label: '$(sparkle) Use account default development domain (recommended)',
      description: 'Lowest-friction setup and safest choice when changing accounts',
      value: 'default'
    },
    {
      label: '$(globe) Configure a stable URL',
      description: 'Developer option; the URL must belong to the selected ngrok account',
      value: 'custom'
    }
  ];
  if (includeKeep) {
    items.push({
      label: '$(debug-pause) Keep current setting',
      description: current || 'No stable URL is currently configured',
      value: 'keep'
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: 'DevMate · ngrok URL',
    placeHolder: 'Choose the public URL strategy for DevMate',
    ignoreFocusOut: true
  });
  if (!choice || choice.value === 'keep') return false;
  if (choice.value === 'default') {
    await updatePreference('ngrokUrl', '');
    log('Configured ngrok to use the account default development domain.');
    return true;
  }

  const value = await vscode.window.showInputBox({
    title: 'DevMate · Stable ngrok URL',
    prompt: 'Enter a URL or hostname owned by the selected account, such as your-name.ngrok-free.app. Do not append /mcp.',
    value: current,
    ignoreFocusOut: true,
    validateInput: input => {
      try { normalizeNgrokUrl(input); return null; } catch (error) { return error.message; }
    }
  });
  if (value === undefined) return false;
  const normalized = normalizeNgrokUrl(value);
  await updatePreference('ngrokUrl', normalized);
  log(`Configured ngrok URL: ${normalized}`);
  return true;
}

async function completeSetup(message) {
  await updatePreference('ngrokPoolingEnabled', false);
  await vscode.commands.executeCommand('devMate.stop');
  await offerStartAgain(message);
}

async function recommendedSetup(context) {
  const saved = await promptForAuthtoken(context, 'DevMate · Quick ngrok Setup');
  if (!saved) return;
  await updatePreference('ngrokUrl', '');
  await completeSetup('ngrok setup is complete. DevMate will use the new account and its default development domain.');
}

async function advancedSetup(context) {
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
  if (!accountChoice) return;

  if (accountChoice.value === 'managed') {
    const saved = await promptForAuthtoken(context);
    if (!saved) return;
  } else {
    await updatePreference('ngrokUseManagedAccount', false);
    log('Configured DevMate to use the global ngrok configuration.');
  }

  await configureDomain();
  await completeSetup('Advanced ngrok setup is complete.');
}

async function guidedSetup(context) {
  setupOutput.show(true);
  if (!await ensureNgrokInstalled()) return;

  const choice = await vscode.window.showQuickPick([
    {
      label: '$(rocket) Quick setup (recommended)',
      description: 'Paste one Authtoken; DevMate handles the account and default domain',
      value: 'recommended'
    },
    {
      label: '$(tools) Developer setup',
      description: 'Choose global ngrok.yml or a DevMate-managed account and optional stable URL',
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
  if (!choice) return;
  if (choice.value === 'recommended') await recommendedSetup(context);
  if (choice.value === 'advanced') await advancedSetup(context);
  if (choice.value === 'dashboard') await openExternal(NGROK_SETUP_URL);
}

async function switchAccount(context) {
  setupOutput.show(true);
  if (!await ensureNgrokInstalled()) return;
  const saved = await promptForAuthtoken(context, 'DevMate · Switch ngrok Account');
  if (!saved) return;

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
  if (domainChoice.value === 'default') await updatePreference('ngrokUrl', '');
  if (domainChoice.value === 'custom') await configureDomain({ includeKeep: false });

  await completeSetup('DevMate now uses the new ngrok account.');
}

async function clearManagedAccount(context) {
  const confirm = await vscode.window.showWarningMessage(
    'Delete the ngrok Authtoken stored by DevMate in VS Code Secret Storage? DevMate will then use the global ngrok configuration.',
    { modal: true },
    'Delete and Use Global Config'
  );
  if (confirm !== 'Delete and Use Global Config') return;
  await vscode.commands.executeCommand('devMate.stop');
  await context.secrets.delete(SECRET_KEY);
  managedAuthtoken = '';
  await updatePreference('ngrokUseManagedAccount', false);
  vscode.window.showInformationMessage('Deleted the DevMate-managed ngrok account.');
}

async function ngrokDoctor() {
  setupOutput.show(true);
  const installed = checkNgrokInstalled();
  const managed = usesManagedAccount();
  log('--- ngrok diagnostics ---');
  log(`Executable: ${ngrokCommand()}`);
  log(`Installed: ${installed.ok ? installed.version : `NO (${installed.message})`}`);
  log(`Account mode: ${managed ? 'DevMate-managed Secret Storage' : 'global ngrok config'}`);
  log(`Managed token present: ${managedAuthtoken ? 'yes' : 'no'}`);
  log(`Ready to launch: ${installed.ok && (!managed || !!managedAuthtoken) ? 'yes' : 'no'}`);
  log(`Configured URL: ${configuredUrl() || 'account default'}`);
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
  if (action === 'Use Global Config') await updatePreference('ngrokUseManagedAccount', false);
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

  register(context, 'devMate.ngrokSetup', () => guidedSetup(context));
  register(context, 'devMate.ngrokSwitchAccount', () => switchAccount(context));
  register(context, 'devMate.ngrokClearAccount', () => clearManagedAccount(context));
  register(context, 'devMate.ngrokDoctor', () => ngrokDoctor());
  register(context, 'devMate.openNgrokDashboard', () => openExternal(NGROK_SETUP_URL));

  try {
    baseExtension = loadBaseExtension();
    await baseExtension.activate(context);
    activated = true;
    log(`ngrok setup integration ready. Account mode: ${usesManagedAccount() ? 'managed' : 'global'}; managed token: ${managedAuthtoken ? 'configured' : 'not configured'}.`);
    void maybePromptForNgrokSetup(context);
  } catch (error) {
    try { if (baseExtension?.deactivate) await baseExtension.deactivate(); } catch {}
    activationAttempted = false;
    activated = false;
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
  }
}

module.exports = {
  activate,
  deactivate,
  loadBaseExtension
};
