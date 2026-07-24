'use strict';

const vscode = require('vscode');
const childProcess = require('child_process');
const {
  buildNgrokArgs,
  buildNgrokSpawnOptions,
  classifyNgrokError,
  isNgrokExecutable,
  isNgrokHttpArgs,
  normalizeNgrokUrl,
  validateAuthtoken
} = require('./ngrok-support');

const SECRET_KEY = 'devMate.ngrokAuthtoken';
const NGROK_SETUP_URL = 'https://dashboard.ngrok.com/get-started/setup';
const NGROK_DOMAINS_URL = 'https://dashboard.ngrok.com/domains';
const NGROK_AGENTS_URL = 'https://dashboard.ngrok.com/agents';
const NOTICE_DEBOUNCE_MS = 15000;

let baseExtension = null;
let managedAuthtoken = '';
let setupOutput = null;
let lastNoticeKey = '';
let lastNoticeAt = 0;

function config() {
  return vscode.workspace.getConfiguration('devMate');
}

function ngrokCommand() {
  return String(config().get('ngrokCommandPath') || 'ngrok').trim() || 'ngrok';
}

function usesManagedAccount() {
  return config().get('ngrokUseManagedAccount') !== false;
}

function configuredUrl() {
  return String(config().get('ngrokUrl') || '').trim();
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

function shouldShowNotice(key) {
  const now = Date.now();
  if (key === lastNoticeKey && now - lastNoticeAt < NOTICE_DEBOUNCE_MS) return false;
  lastNoticeKey = key;
  lastNoticeAt = now;
  return true;
}

async function offerStartAgain(message) {
  const choice = await vscode.window.showInformationMessage(message, 'Start Now', 'Open DevMate');
  if (choice === 'Start Now') await vscode.commands.executeCommand('devMate.start');
  if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
}

function showMissingManagedToken() {
  if (!shouldShowNotice('missing-managed-token')) return;
  vscode.window.showErrorMessage(
    'DevMate is configured to manage ngrok, but no Authtoken is stored. Setup is required before DevMate can start a public tunnel.',
    'Quick Setup',
    'Use Global Config'
  ).then(async choice => {
    if (choice === 'Quick Setup') await vscode.commands.executeCommand('devMate.ngrokSetup');
    if (choice === 'Use Global Config') {
      await config().update('ngrokUseManagedAccount', false, vscode.ConfigurationTarget.Global);
      await offerStartAgain('DevMate will now use the global ngrok.yml configuration.');
    }
  });
}

function showNgrokError(problem) {
  const key = `${problem.kind}:${problem.code || ''}`;
  if (!shouldShowNotice(key)) return;

  if (problem.kind === 'endpoint-conflict') {
    vscode.window.showErrorMessage(
      'The ngrok endpoint is already online on another agent. Pooling is unsafe for DevMate because requests could reach another computer or workspace.',
      'Switch ngrok Account',
      'Use Account Default Domain',
      'View Active Agents'
    ).then(async choice => {
      if (choice === 'Switch ngrok Account') await vscode.commands.executeCommand('devMate.ngrokSwitchAccount');
      if (choice === 'View Active Agents') await openExternal(NGROK_AGENTS_URL);
      if (choice === 'Use Account Default Domain') {
        await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
        await config().update('ngrokPoolingEnabled', false, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('devMate.stop');
        await offerStartAgain('The old custom URL was cleared. DevMate will use the selected account default domain.');
      }
    });
    return;
  }

  if (problem.kind === 'authentication') {
    vscode.window.showErrorMessage(
      'ngrok authentication failed. Save the current account Authtoken again; DevMate keeps it in VS Code Secret Storage.',
      'Switch ngrok Account',
      'Open ngrok Setup'
    ).then(async choice => {
      if (choice === 'Switch ngrok Account') await vscode.commands.executeCommand('devMate.ngrokSwitchAccount');
      if (choice === 'Open ngrok Setup') await openExternal(NGROK_SETUP_URL);
    });
    return;
  }

  if (problem.kind === 'domain') {
    vscode.window.showErrorMessage(
      'The selected ngrok account cannot use the configured URL. Use its default development domain or verify domain ownership.',
      'Use Account Default Domain',
      'Open Domains'
    ).then(async choice => {
      if (choice === 'Use Account Default Domain') {
        await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
        await config().update('ngrokPoolingEnabled', false, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('devMate.stop');
        await offerStartAgain('DevMate will now use the selected account default domain.');
      }
      if (choice === 'Open Domains') await openExternal(NGROK_DOMAINS_URL);
    });
  }
}

function attachNgrokDiagnostics(child) {
  let buffer = '';
  let handled = false;
  child.stderr?.on('data', chunk => {
    if (handled) return;
    buffer = `${buffer}${String(chunk)}`.slice(-12000);
    const problem = classifyNgrokError(buffer);
    if (!problem) return;
    handled = true;
    log(`Detected ngrok problem: ${problem.kind} ${problem.code || ''}`.trim());
    showNgrokError(problem);
  });
}

function createExtensionSpawn(originalSpawn) {
  return function devMateSpawn(command, args, options) {
    if (!isNgrokExecutable(command) || !isNgrokHttpArgs(args)) {
      return originalSpawn.call(childProcess, command, args, options);
    }

    const cfg = config();
    const managed = cfg.get('ngrokUseManagedAccount') !== false;
    if (managed && !managedAuthtoken) {
      showMissingManagedToken();
      throw new Error('DevMate-managed ngrok account is not configured. Run DevMate: Configure ngrok.');
    }

    const effectiveArgs = buildNgrokArgs(args, {
      url: cfg.get('ngrokUrl') || '',
      poolingEnabled: cfg.get('ngrokPoolingEnabled') === true
    });
    const effectiveOptions = buildNgrokSpawnOptions(options, {
      authtoken: managedAuthtoken,
      useManagedAccount: managed
    });
    const child = originalSpawn.call(childProcess, command, effectiveArgs, effectiveOptions);
    attachNgrokDiagnostics(child);
    log(`Starting ngrok with ${managed ? 'DevMate-managed account' : 'global ngrok config'}${cfg.get('ngrokUrl') ? ` at ${cfg.get('ngrokUrl')}` : ' using the account default domain'}.`);
    return child;
  };
}

function loadBaseExtensionWithNgrokWrapper() {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = createExtensionSpawn(originalSpawn);
  try {
    return require('./extension');
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

async function saveManagedAuthtoken(context, value) {
  const token = validateAuthtoken(value);
  await context.secrets.store(SECRET_KEY, token);
  managedAuthtoken = token;
  await config().update('ngrokUseManagedAccount', true, vscode.ConfigurationTarget.Global);
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
    await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
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
  await config().update('ngrokUrl', normalized, vscode.ConfigurationTarget.Global);
  log(`Configured ngrok URL: ${normalized}`);
  return true;
}

async function completeSetup(message) {
  await config().update('ngrokPoolingEnabled', false, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('devMate.stop');
  await offerStartAgain(message);
}

async function recommendedSetup(context) {
  const saved = await promptForAuthtoken(context, 'DevMate · Quick ngrok Setup');
  if (!saved) return;
  await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
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
    await config().update('ngrokUseManagedAccount', false, vscode.ConfigurationTarget.Global);
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
      description: 'Prevents the previous account domain from causing ERR_NGROK_334 or ownership errors',
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
  if (domainChoice.value === 'default') await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
  if (domainChoice.value === 'custom') await configureDomain({ includeKeep: false });

  await completeSetup('DevMate now uses the new ngrok account. The previous global ngrok.yml account does not affect managed mode.');
}

async function clearManagedAccount(context) {
  const confirm = await vscode.window.showWarningMessage(
    'Delete the ngrok Authtoken stored by DevMate in VS Code Secret Storage? DevMate will then use the global ngrok configuration.',
    { modal: true },
    'Delete and Use Global Config'
  );
  if (confirm !== 'Delete and Use Global Config') return;
  await context.secrets.delete(SECRET_KEY);
  managedAuthtoken = '';
  await config().update('ngrokUseManagedAccount', false, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('devMate.stop');
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
  log(`Pooling: ${config().get('ngrokPoolingEnabled') === true ? 'enabled (not recommended)' : 'disabled (recommended)'}`);

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
  if (action === 'Use Global Config') await config().update('ngrokUseManagedAccount', false, vscode.ConfigurationTarget.Global);
}

async function activate(context) {
  setupOutput = vscode.window.createOutputChannel('DevMate Setup');
  context.subscriptions.push(setupOutput);
  managedAuthtoken = await context.secrets.get(SECRET_KEY) || '';

  register(context, 'devMate.ngrokSetup', () => guidedSetup(context));
  register(context, 'devMate.ngrokSwitchAccount', () => switchAccount(context));
  register(context, 'devMate.ngrokClearAccount', () => clearManagedAccount(context));
  register(context, 'devMate.ngrokDoctor', () => ngrokDoctor());
  register(context, 'devMate.openNgrokDashboard', () => openExternal(NGROK_SETUP_URL));

  baseExtension = loadBaseExtensionWithNgrokWrapper();
  await baseExtension.activate(context);
  log(`ngrok integration ready. Account mode: ${usesManagedAccount() ? 'managed' : 'global'}; managed token: ${managedAuthtoken ? 'configured' : 'not configured'}.`);
  void maybePromptForNgrokSetup(context);
}

async function deactivate() {
  if (baseExtension?.deactivate) await baseExtension.deactivate();
}

module.exports = { activate, deactivate };
