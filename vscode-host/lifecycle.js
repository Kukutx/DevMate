'use strict';

const fs = require('node:fs');
const { ensureInstanceConfig, readJson, updateConfig } = require('../shared/config-store.cjs');
const { ensureDesktopAuthenticationPolicy, setDesktopAuthenticationMode } = require('../shared/desktop-auth-policy.cjs');
const { ensureDesktopPermissionPolicy, setDesktopPermissionPolicy } = require('../shared/desktop-permission-policy.cjs');
const { version: APP_VERSION } = require('../package.json');
const { healthAt, healthMatches } = require('../host/runtime/network.js');
const { connectionErrorSummary } = require('../host/public-mcp.js');
const { VscodeRuntimeDiagnostics } = require('./runtime-diagnostics.js');
const {
  createRuntimeContext,
  currentWorkspaceRoot,
  runtimeConfigPath,
  setting
} = require('./runtime-context.js');

const RELOAD_SETTINGS = ['devMate.sharedStateDirectory'];
const AUTHENTICATION_SETTING = 'devMate.authenticationMode';
const AUTO_START_ACTIVATION_SETTING = 'devMate.activateWorkspaceOnAutoStart';
const EMBEDDED_RUNNER_SETTING = 'devMate.embeddedRunnerEnabled';
const PERMISSION_SETTINGS = Object.freeze([
  'devMate.permissionProfile',
  'devMate.blockDangerousOperations',
  'devMate.confirmBeforePush',
  'devMate.allowDirectoryMutations'
]);

function localPermissionPolicy(vscode) {
  const requested = String(setting(vscode, 'permissionProfile', 'fullAccess') || 'fullAccess');
  const profile = ['readOnly', 'balanced', 'fullAccess'].includes(requested) ? requested : 'fullAccess';
  return {
    profile,
    readOnly: profile === 'readOnly',
    blockDangerousOperations: setting(vscode, 'blockDangerousOperations', true) !== false,
    confirmBeforePush: setting(vscode, 'confirmBeforePush', false) === true,
    allowDirectoryMutations: setting(vscode, 'allowDirectoryMutations', false) === true
  };
}

async function alignLocalPermissionSettings(vscode, permissions) {
  if (!permissions) return;
  const configuration = vscode.workspace.getConfiguration('devMate');
  const target = vscode.ConfigurationTarget?.Global ?? true;
  const expected = { permissionProfile: permissions.profile };
  // fullAccess has canonical unrestricted semantics. Keep the subordinate guard
  // settings dormant so a user's balanced-mode preferences survive round trips.
  if (permissions.profile !== 'fullAccess') {
    expected.blockDangerousOperations = permissions.blockDangerousOperations;
    expected.confirmBeforePush = permissions.confirmBeforePush;
    expected.allowDirectoryMutations = permissions.allowDirectoryMutations;
  }
  for (const [name, value] of Object.entries(expected)) {
    if (setting(vscode, name, undefined) === value) continue;
    try { await configuration.update(name, value, target); } catch {}
  }
}

async function alignLocalEmbeddedRunnerSetting(vscode, enabled) {
  const expected = enabled === true;
  if (setting(vscode, 'embeddedRunnerEnabled', false) === expected) return;
  try {
    await vscode.workspace.getConfiguration('devMate').update(
      'embeddedRunnerEnabled',
      expected,
      vscode.ConfigurationTarget?.Global ?? true
    );
  } catch {}
}

function setEmbeddedRunnerPreference(configFile, enabled) {
  return updateConfig(configFile, config => {
    config.jobs ||= {};
    config.jobs.embeddedRunnerEnabled = enabled === true;
    return config;
  });
}

class VscodeHostLifecycle {
  constructor({ vscode, platformExtension = null, runtimeSnapshot = null }) {
    this.vscode = vscode;
    this.platformExtension = platformExtension || require('../extension-entry-platform.js');
    this.runtimeSnapshot = typeof runtimeSnapshot === 'function' ? runtimeSnapshot : null;
    this.context = null;
    this.runtimeContext = null;
    this.output = null;
    this.diagnostics = null;
    this.startupTimer = null;
    this.startupPromise = null;
    this.active = false;
    this.lifecycleGeneration = 0;
    this.activating = null;
    this.deactivating = null;
    this.platformActivationAttempted = false;
    this.platformActivated = false;
    this.workspaceRootAtActivation = '';
    this.lastSelfCheck = null;
  }

  autoStart() {
    return setting(this.vscode, 'autoStart', true) !== false;
  }

  activateWorkspaceOnAutoStart() {
    return setting(this.vscode, 'activateWorkspaceOnAutoStart', false) === true;
  }

  startupPending() {
    return !!this.startupTimer || !!this.startupPromise;
  }

  async activate(context) {
    if (this.activating) return this.activating;
    this.activating = this.activateInternal(context);
    try {
      return await this.activating;
    } catch (error) {
      try { await this.deactivate({ preserveSession: false }); } catch {}
      throw error;
    } finally {
      this.activating = null;
    }
  }

  async activateInternal(context) {
    this.context = context;
    this.runtimeContext = createRuntimeContext(this.vscode, context);
    this.workspaceRootAtActivation = currentWorkspaceRoot(this.vscode);
    if (this.workspaceRootAtActivation) {
      const configFile = runtimeConfigPath(this.runtimeContext);
      const fresh = !fs.existsSync(configFile);
      ensureInstanceConfig({
        configFile,
        workspaceRoot: this.workspaceRootAtActivation,
        preferredPort: Number(setting(this.vscode, 'port', 8787)),
        appVersion: context.extension?.packageJSON?.version || APP_VERSION,
        defaultConnectionProvider: 'ngrok'
      });
      const policy = ensureDesktopAuthenticationPolicy(configFile, { fresh });
      const localMode = setting(this.vscode, 'authenticationMode', 'none') === 'oauth' ? 'oauth' : 'none';
      if (localMode !== policy.mode) {
        try {
          await this.vscode.workspace.getConfiguration('devMate').update(
            'authenticationMode',
            policy.mode,
            this.vscode.ConfigurationTarget?.Global ?? true
          );
        } catch {}
      }
      const permissionPolicy = ensureDesktopPermissionPolicy(configFile, {
        fresh,
        defaults: localPermissionPolicy(this.vscode)
      });
      await alignLocalPermissionSettings(this.vscode, permissionPolicy.permissions);
      const sharedConfig = readJson(configFile, null);
      await alignLocalEmbeddedRunnerSetting(this.vscode, sharedConfig?.jobs?.embeddedRunnerEnabled === true);
    }

    this.output = this.vscode.window.createOutputChannel('DevMate Host');
    context.subscriptions.push(this.output);
    this.diagnostics = new VscodeRuntimeDiagnostics({
      vscode: this.vscode,
      context,
      runtimeContext: this.runtimeContext,
      output: this.output,
      runtimeSnapshot: () => ({
        platform: typeof this.platformExtension?.runtimeDiagnostics === 'function' ? this.platformExtension.runtimeDiagnostics() : null,
        shared: this.runtimeSnapshot ? this.runtimeSnapshot() : null
      })
    });
    this.diagnostics.append(`Activating DevMate VS Code host ${context.extension?.packageJSON?.version || APP_VERSION}.`);

    context.subscriptions.push(this.vscode.commands.registerCommand('devMate.copyHostDiagnostics', () => this.copyDiagnostics()));
    context.subscriptions.push(this.vscode.commands.registerCommand('devMate.hostSelfCheck', () => this.runSelfCheck(true)));
    this.registerHostListeners(context);
    this.active = true;
    this.lifecycleGeneration += 1;

    if (!this.workspaceRootAtActivation && !fs.existsSync(runtimeConfigPath(this.runtimeContext))) {
      this.diagnostics.append('No VS Code workspace or shared desktop config is available; DevMate is idle and will not initialize a project runtime.');
      return { idle: true, reason: 'no-workspace' };
    }

    try {
      this.platformActivationAttempted = true;
      await this.platformExtension.activate(this.runtimeContext);
      this.platformActivated = true;
      const check = this.runSelfCheck(false);
      if (!check.ok) this.diagnostics.append('Host activated with self-check failures; automatic Start is suppressed.', 'error');
      else this.scheduleAutomaticStart();
    } catch (error) {
      this.diagnostics.recordFailure(error, { phase: 'host-activation' });
      throw error;
    }
  }

  registerHostListeners(context) {
    context.subscriptions.push(this.vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(AUTHENTICATION_SETTING) && this.runtimeContext) {
        try {
          const requested = setting(this.vscode, 'authenticationMode', 'none') === 'oauth' ? 'oauth' : 'none';
          const policy = setDesktopAuthenticationMode(runtimeConfigPath(this.runtimeContext), requested);
          this.diagnostics?.append(`Shared MCP authentication changed explicitly to ${policy.mode}.`);
          if (this.platformActivated) {
            this.vscode.commands.executeCommand('devMate.start', { quiet: true, activateWorkspace: false }).then(
              () => {},
              error => this.diagnostics?.recordFailure(error, { phase: 'authentication-change' })
            );
          }
        } catch (error) {
          this.diagnostics?.recordFailure(error, { phase: 'authentication-change' });
        }
      }

      if (PERMISSION_SETTINGS.some(name => event.affectsConfiguration(name)) && this.runtimeContext) {
        try {
          const policy = setDesktopPermissionPolicy(
            runtimeConfigPath(this.runtimeContext),
            localPermissionPolicy(this.vscode)
          );
          this.diagnostics?.append(`Shared DevMate permission policy changed explicitly to ${policy.permissions.profile}.`);
        } catch (error) {
          this.diagnostics?.recordFailure(error, { phase: 'permission-change' });
        }
      }

      if (event.affectsConfiguration(EMBEDDED_RUNNER_SETTING) && this.runtimeContext) {
        try {
          const enabled = setting(this.vscode, 'embeddedRunnerEnabled', false) === true;
          setEmbeddedRunnerPreference(runtimeConfigPath(this.runtimeContext), enabled);
          this.diagnostics?.append(`Shared embedded Runner preference changed explicitly to ${enabled ? 'enabled' : 'disabled'}; it applies on the next Shared Runtime start.`);
        } catch (error) {
          this.diagnostics?.recordFailure(error, { phase: 'embedded-runner-change' });
        }
      }

      if (!RELOAD_SETTINGS.some(name => event.affectsConfiguration(name))) return;
      this.diagnostics?.append('A host-level setting changed and requires a VS Code window reload.');
      this.vscode.window.showInformationMessage(
        'DevMate host settings changed. Reload VS Code to apply the shared runtime safely.',
        'Reload Window'
      ).then(choice => {
        if (choice === 'Reload Window') this.vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }));

    context.subscriptions.push(this.vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const current = currentWorkspaceRoot(this.vscode);
      if (current === this.workspaceRootAtActivation) return;
      this.diagnostics?.append(`Primary workspace changed from ${this.workspaceRootAtActivation || '(none)'} to ${current || '(none)'}.`, 'error');
      this.vscode.window.showWarningMessage(
        'The primary workspace changed. Reload VS Code so DevMate can select the correct shared runtime safely.',
        'Reload Window'
      ).then(choice => {
        if (choice === 'Reload Window') this.vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }));
  }

  runSelfCheck(showMessage = false) {
    if (!this.diagnostics) return { ok: false, checks: [] };
    const result = this.diagnostics.selfCheck();
    this.lastSelfCheck = result;
    if (showMessage) {
      const failed = result.checks.filter(check => !check.ok).map(check => check.id);
      const message = result.ok
        ? 'DevMate VS Code host self-check passed.'
        : `DevMate host self-check failed: ${failed.join(', ')}`;
      const method = result.ok ? 'showInformationMessage' : 'showWarningMessage';
      this.vscode.window[method](message, 'Open Host Log').then(choice => {
        if (choice === 'Open Host Log') this.openHostLog();
      });
    }
    return result;
  }

  scheduleAutomaticStart() {
    if (!this.autoStart() || !currentWorkspaceRoot(this.vscode)) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    const generation = this.lifecycleGeneration;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (!this.active || generation !== this.lifecycleGeneration) return;
      let startup;
      startup = this.startAutomatically(generation)
        .catch(error => this.handleStartupFailure(error, generation))
        .finally(() => {
          if (this.startupPromise === startup) this.startupPromise = null;
        });
      this.startupPromise = startup;
    }, 0);
  }

  async verifyGatewayReady(timeoutMs = 20000) {
    if (!this.runtimeContext) throw new Error('VS Code runtime context is unavailable');
    const configFile = runtimeConfigPath(this.runtimeContext);
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20000);
    let lastHealth = null;
    while (Date.now() <= deadline) {
      const config = readJson(configFile, null);
      const port = Number(config?.server?.port || 0);
      if (port > 0) {
        lastHealth = await healthAt(port, 1000);
        if (healthMatches(lastHealth, config)) return { config, health: lastHealth.json, port };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const error = new Error(`DevMate Gateway did not pass the post-start health check${lastHealth?.error ? `: ${lastHealth.error}` : ''}`);
    error.code = 'DEVMATE_VSCODE_POST_START_HEALTH_FAILED';
    error.health = lastHealth;
    throw error;
  }

  async startAutomatically(generation = this.lifecycleGeneration) {
    if (!this.active || generation !== this.lifecycleGeneration) {
      return { cancelled: true, reason: 'host-deactivating' };
    }
    const check = this.lastSelfCheck || this.runSelfCheck(false);
    if (!check.ok) throw Object.assign(new Error('VS Code host self-check failed before DevMate Start'), {
      code: 'DEVMATE_VSCODE_SELF_CHECK_FAILED'
    });
    const activateWorkspace = this.activateWorkspaceOnAutoStart();
    this.diagnostics?.append(activateWorkspace
      ? 'Starting DevMate automatically and activating this workspace as the machine Current Project.'
      : 'Starting or attaching DevMate automatically without changing the machine Current Project.');
    const commandResult = await this.vscode.commands.executeCommand('devMate.start', { quiet: true, activateWorkspace });
    if (!this.active || generation !== this.lifecycleGeneration) {
      return { cancelled: true, reason: 'host-deactivating' };
    }
    if (commandResult?.ok === false) {
      if (commandResult.recovering) {
        this.diagnostics?.append('The public endpoint is still becoming reachable; background verification will continue without replacing the URL.');
        return commandResult;
      }
      const error = new Error(commandResult.summary || connectionErrorSummary(commandResult.error) || 'DevMate start command reported failure');
      error.code = commandResult.code || 'DEVMATE_VSCODE_START_COMMAND_FAILED';
      error.detail = commandResult.error || '';
      throw error;
    }
    if (!commandResult?.mcpUrl || !Number.isInteger(Number(commandResult?.toolCount)) || Number(commandResult.toolCount) <= 0) {
      const error = new Error('DevMate Start returned before the public MCP endpoint reached verified Ready state');
      error.code = 'DEVMATE_VSCODE_START_NOT_READY';
      throw error;
    }
    const ready = await this.verifyGatewayReady();
    if (!this.active || generation !== this.lifecycleGeneration) {
      return { cancelled: true, reason: 'host-deactivating' };
    }
    this.diagnostics?.clearFailure();
    this.diagnostics?.append(`Automatic DevMate Start verified on port ${ready.port}; tools=${commandResult.toolCount}; activateWorkspace=${activateWorkspace}.`);
    return { ...ready, mcpUrl: commandResult.mcpUrl, toolCount: commandResult.toolCount };
  }

  async handleStartupFailure(error, generation = this.lifecycleGeneration) {
    if (!this.active || generation !== this.lifecycleGeneration || this.deactivating) return;
    this.diagnostics?.recordFailure(error, { phase: 'automatic-start' });
    const detail = connectionErrorSummary(error);
    const choice = await this.vscode.window.showErrorMessage(
      `DevMate could not reach Ready state: ${detail}`,
      'Copy diagnostics',
      'Open Host Log'
    );
    if (choice === 'Copy diagnostics') await this.copyDiagnostics();
    if (choice === 'Open Host Log') await this.openHostLog();
  }

  markRecoveredStart({ toolCount = 0 } = {}) {
    this.diagnostics?.clearFailure();
    const count = Number(toolCount) || 0;
    this.diagnostics?.append(count > 0
      ? `Shared session recovery reached verified Ready state; tools=${count}.`
      : 'Shared session recovery reached verified Ready state.');
  }

  async copyDiagnostics() {
    if (!this.diagnostics) return '';
    const autoStart = this.autoStart();
    const report = await this.diagnostics.copy({
      autoStart,
      startupMode: autoStart ? 'automatic' : 'manual',
      enabled: this.active,
      lastSelfCheck: this.lastSelfCheck
    });
    this.vscode.window.showInformationMessage('DevMate VS Code host diagnostics copied.');
    return report;
  }

  async openHostLog() {
    const file = this.diagnostics?.store.logFile;
    if (file && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      const document = await this.vscode.workspace.openTextDocument(file);
      await this.vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    this.output?.show(true);
  }

  async deactivate({ preserveSession = true } = {}) {
    if (this.deactivating) return this.deactivating;
    this.deactivating = (async () => {
      this.active = false;
      this.lifecycleGeneration += 1;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      let platformResult = null;
      try {
        if (this.platformActivationAttempted) platformResult = await this.platformExtension.deactivate({ preserveSession });
      } finally {
        this.platformActivationAttempted = false;
        this.platformActivated = false;
        this.diagnostics?.append('DevMate VS Code host deactivated.');
        this.runtimeContext = null;
        this.context = null;
        this.output = null;
        this.diagnostics = null;
      }
      return platformResult;
    })();
    try { return await this.deactivating; }
    finally { this.deactivating = null; }
  }
}

module.exports = {
  AUTHENTICATION_SETTING,
  AUTO_START_ACTIVATION_SETTING,
  EMBEDDED_RUNNER_SETTING,
  PERMISSION_SETTINGS,
  RELOAD_SETTINGS,
  VscodeHostLifecycle,
  alignLocalEmbeddedRunnerSetting,
  alignLocalPermissionSettings,
  localPermissionPolicy,
  setEmbeddedRunnerPreference
};
