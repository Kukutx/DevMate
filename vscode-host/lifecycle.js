'use strict';

const fs = require('node:fs');
const { ensureInstanceConfig, readJson } = require('../shared/config-store.cjs');
const { ensureDesktopAuthenticationPolicy, setDesktopAuthenticationMode } = require('../shared/desktop-auth-policy.cjs');
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
      const localMode = setting(this.vscode, 'authenticationMode', 'oauth') === 'none' ? 'none' : 'oauth';
      if (localMode !== policy.mode) {
        try {
          await this.vscode.workspace.getConfiguration('devMate').update(
            'authenticationMode',
            policy.mode,
            this.vscode.ConfigurationTarget?.Global ?? true
          );
        } catch {}
      }
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

    if (!this.workspaceRootAtActivation) {
      this.diagnostics.append('No VS Code workspace is open; DevMate is idle and will not initialize or start a project runtime.');
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
          const requested = setting(this.vscode, 'authenticationMode', 'oauth') === 'none' ? 'none' : 'oauth';
          const policy = setDesktopAuthenticationMode(runtimeConfigPath(this.runtimeContext), requested);
          this.diagnostics?.append(`Shared MCP authentication changed explicitly to ${policy.mode}.`);
          if (this.platformActivated) {
            this.vscode.commands.executeCommand('devMate.start', { quiet: true }).then(
              () => {},
              error => this.diagnostics?.recordFailure(error, { phase: 'authentication-change' })
            );
          }
        } catch (error) {
          this.diagnostics?.recordFailure(error, { phase: 'authentication-change' });
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
      this.startAutomatically(generation).catch(error => this.handleStartupFailure(error, generation));
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
    this.diagnostics?.append('Starting DevMate automatically and waiting for verified public MCP Ready state.');
    const commandResult = await this.vscode.commands.executeCommand('devMate.start', { quiet: true });
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
    this.diagnostics?.append(`Automatic DevMate Start verified on port ${ready.port}; tools=${commandResult.toolCount}.`);
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

module.exports = { AUTHENTICATION_SETTING, RELOAD_SETTINGS, VscodeHostLifecycle };
