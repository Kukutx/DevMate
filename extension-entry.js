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

function log(message) {
  setupOutput?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function openExternal(url) {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function register(context, id, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

function showNgrokError(problem) {
  const now = Date.now();
  const key = `${problem.kind}:${problem.code || ''}`;
  if (key === lastNoticeKey && now - lastNoticeAt < 15000) return;
  lastNoticeKey = key;
  lastNoticeAt = now;

  if (problem.kind === 'endpoint-conflict') {
    vscode.window.showErrorMessage(
      'The ngrok endpoint is already online on another agent. Do not enable pooling for DevMate because requests could reach the other machine. Switch accounts or stop the old agent in the ngrok dashboard.',
      'Switch ngrok Account',
      'View Active Agents',
      'Use Account Default Domain'
    ).then(async choice => {
      if (choice === 'Switch ngrok Account') await vscode.commands.executeCommand('devMate.ngrokSwitchAccount');
      if (choice === 'View Active Agents') await openExternal(NGROK_AGENTS_URL);
      if (choice === 'Use Account Default Domain') {
        await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Cleared the custom ngrok URL. Run DevMate: Start again.');
      }
    });
    return;
  }

  if (problem.kind === 'authentication') {
    vscode.window.showErrorMessage(
      'ngrok authentication failed. Save the new account Authtoken again. DevMate stores it in VS Code Secret Storage without changing the global ngrok configuration.',
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
      'The selected ngrok account cannot use the configured URL. Use the account default development domain or verify ownership in ngrok Domains.',
      'Use Account Default Domain',
      'Open Domains'
    ).then(async choice => {
      if (choice === 'Use Account Default Domain') {
        await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Cleared the custom ngrok URL. Run DevMate: Start again.');
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
    const effectiveArgs = buildNgrokArgs(args, {
      url: cfg.get('ngrokUrl') || '',
      poolingEnabled: cfg.get('ngrokPoolingEnabled') === true
    });
    const effectiveOptions = buildNgrokSpawnOptions(options, {
      authtoken: managedAuthtoken,
      useManagedAccount: cfg.get('ngrokUseManagedAccount') !== false
    });
    const child = originalSpawn.call(childProcess, command, effectiveArgs, effectiveOptions);
    attachNgrokDiagnostics(child);
    log(`Starting ngrok with ${cfg.get('ngrokUseManagedAccount') !== false && managedAuthtoken ? 'DevMate-managed account' : 'global ngrok config'}${cfg.get('ngrokUrl') ? ` at ${cfg.get('ngrokUrl')}` : ''}.`);
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
  log('Saved a DevMate-managed ngrok authtoken in VS Code Secret Storage.');
}

async function promptForAuthtoken(context) {
  const value = await vscode.window.showInputBox({
    title: 'DevMate · ngrok Account',
    prompt: 'Paste the new ngrok account Authtoken. It is stored only in VS Code Secret Storage, never in the project or DevMate config.json.',
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

async function configureDomain() {
  const current = String(config().get('ngrokUrl') || '').trim();
  const choice = await vscode.window.showQuickPick([
    {
      label: '$(sparkle) Use account default development domain (recommended)',
      description: 'Lowest-friction free-plan setup; the new account uses its own ngrok-free domain',
      value: 'default'
    },
    {
      label: '$(globe) Configure a stable URL',
      description: 'Developer option; the URL must belong to the selected ngrok account',
      value: 'custom'
    },
    {
      label: '$(debug-pause) Keep current setting',
      description: current || 'No URL is currently configured',
      value: 'keep'
    }
  ], {
    title: 'DevMate · ngrok URL',
    placeHolder: 'Choose the public URL strategy for DevMate',
    ignoreFocusOut: true
  });
  if (!choice || choice.value === 'keep') return;
  if (choice.value === 'default') {
    await config().update('ngrokUrl', '', vscode.ConfigurationTarget.Global);
    log('Configured ngrok to use the account default development domain.');
    return;
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
  if (value === undefined) return;
  const normalized = normalizeNgrokUrl(value);
  await config().update('ngrokUrl', normalized, vscode.ConfigurationTarget.Global);
  log(`Configured ngrok URL: ${normalized}`);
}

async function guidedSetup(context) {
  setupOutput.show(true);
  const installed = checkNgrokInstalled();
  log(installed.ok ? `ngrok detected: ${installed.version}` : `ngrok check failed: ${installed.message}`);
  if (!installed.ok) {
    const action = await vscode.window.showErrorMessage('ngrok was not detected. Install ngrok, then run DevMate: Configure ngrok again.', 'Open Install Page');
    if (action === 'Open Install Page') await openExternal(NGROK_SETUP_URL);
    return;
  }

  const accountChoice = await vscode.window.showQuickPick([
    {
      label: '$(key) Let DevMate manage the ngrok account (recommended)',
      description: 'Stores the Authtoken in VS Code Secret Storage and supports one-step account switching',
      value: 'managed'
    },
    {
      label: '$(settings-gear) Use the global ngrok configuration',
      description: 'Uses ngrok.yml; intended for developers who already manage multiple agents',
      value: 'global'
    }
  ], {
    title: 'DevMate · ngrok Setup',
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
  await vscode.commands.executeCommand('devMate.stop');
  const action = await vscode.window.showInformationMessage(
    'ngrok setup is complete. From now on, open a project and run DevMate: Start.',
    'Start Now',
    'Open DevMate'
  );
  if (action === 'Start Now') await vscode.commands.executeCommand('devMate.start');
  if (action === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
}

async function switchAccount(context) {
  const saved = await promptForAuthtoken(context);
  if (!saved) return;
  await configureDomain();
  await vscode.commands.executeCommand('devMate.stop');
  const action = await vscode.window.showInformationMessage('DevMate now uses the new ngrok account. The old global ngrok.yml will not affect DevMate.', 'Start Now');
  if (action === 'Start Now') await vscode.commands.executeCommand('devMate.start');
}

async function clearManagedAccount(context) {
  const confirm = await vscode.window.showWarningMessage(
    'Delete the ngrok Authtoken stored by DevMate in VS Code Secret Storage? DevMate will then fall back to the global ngrok configuration.',
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
  const cfg = config();
  const managed = cfg.get('ngrokUseManagedAccount') !== false;
  log('--- ngrok diagnostics ---');
  log(`Executable: ${ngrokCommand()}`);
  log(`Installed: ${installed.ok ? installed.version : `NO (${installed.message})`}`);
  log(`Account mode: ${managed ? 'DevMate-managed Secret Storage' : 'global ngrok config'}`);
  log(`Managed token present: ${managedAuthtoken ? 'yes' : 'no'}`);
  log(`Configured URL: ${cfg.get('ngrokUrl') || 'account default'}`);
  log(`Pooling: ${cfg.get('ngrokPoolingEnabled') === true ? 'enabled (advanced)' : 'disabled (recommended)'}`);

  const configCheck = childProcess.spawnSync(ngrokCommand(), ['config', 'check'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  log(`Global config check: ${String(configCheck.stdout || configCheck.stderr || configCheck.error?.message || 'no output').trim()}`);
  vscode.window.showInformationMessage('ngrok diagnostics finished. See DevMate Setup output.');
}

async function maybePromptForNgrokSetup(context) {
  if (managedAuthtoken || config().get('ngrokUseManagedAccount') === false) return;
  if (context.globalState.get('devMate.ngrokSetupPrompted')) return;
  await context.globalState.update('devMate.ngrokSetupPrompted', true);
  const action = await vscode.window.showInformationMessage(
    'Configure ngrok once so DevMate can switch accounts without editing the global ngrok.yml.',
    'Configure ngrok',
    'Use Global Config'
  );
  if (action === 'Configure ngrok') await vscode.commands.executeCommand('devMate.ngrokSetup');
  if (action === 'Use Global Config') await config().update('ngrokUseManagedAccount', false, vscode.ConfigurationTarget.Global);
}

async function activate(context) {
  setupOutput = vscode.window.createOutputChannel('DevMate Setup');
  context.subscriptions.push(setupOutput);
  managedAuthtoken = await context.secrets.get(SECRET_KEY) || '';
  baseExtension = loadBaseExtensionWithNgrokWrapper();
  await baseExtension.activate(context);

  register(context, 'devMate.ngrokSetup', () => guidedSetup(context));
  register(context, 'devMate.ngrokSwitchAccount', () => switchAccount(context));
  register(context, 'devMate.ngrokClearAccount', () => clearManagedAccount(context));
  register(context, 'devMate.ngrokDoctor', () => ngrokDoctor());
  register(context, 'devMate.openNgrokDashboard', () => openExternal(NGROK_SETUP_URL));
  log(`ngrok integration ready. Managed account: ${managedAuthtoken ? 'configured' : 'not configured'}.`);
  void maybePromptForNgrokSetup(context);
}

async function deactivate() {
  if (baseExtension?.deactivate) await baseExtension.deactivate();
}

module.exports = { activate, deactivate };
