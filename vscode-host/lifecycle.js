'use strict';

const fs = require('node:fs');
const { ensureInstanceConfig, readJson } = require('../shared/config-store.cjs');
const { version: APP_VERSION } = require('../package.json');
const { healthAt, healthMatches } = require('../host/runtime/network.js');
const { VscodeContextMirror } = require('./context-mirror.js');
const { VscodeRuntimeDiagnostics } = require('./runtime-diagnostics.js');
const {
  createRuntimeContext,
  currentWorkspaceRoot,
  runtimeConfigPath,
  setting
} = require('./runtime-context.js');

const RELOAD_SETTINGS = ['devMate.sharedStateDirectory'];

class VscodeHostLifecycle {
  constructor({ vscode, platformExtension = null }) {
    this.vscode = vscode;
    this.platformExtension = platformExtension || require('../extension-entry-platform.js');
    this.context = null;
    this.runtimeContext = null;
    this.output = null;
    this.diagnostics = null;
    this.mirror = null;
    this.startupTimer = null;
    this.active = false;
    this.activating = null;
    this.deactivating = null;
    this.platformActivationAttempted = false;
    this.platformActivated = false;
    this.workspaceRootAtActivation = '';
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
      try { await this.deactivate(); } catch {}
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
      ensureInstanceConfig({
        configFile: runtimeConfigPath(this.runtimeContext),
        workspaceRoot: this.workspaceRootAtActivation,
        preferredPort: Number(setting(this.vscode, 'port', 8787)),
        appVersion: context.extension?.packageJSON?.version || APP_VERSION
      });
    }

    this.output = this.vscode.window.createOutputChannel('DevMate Host');
    context.subscriptions.push(this.output);
    this.diagnostics = new VscodeRuntimeDiagnostics({
      vscode: this.vscode,
      context,
      runtimeContext: this.runtimeContext,
      output: this.output
    });
    this.diagnostics.append(`Activating DevMate VS Code host ${context.extension?.packageJSON?.version || APP_VERSION}.`);

    context.subscriptions.push(this.vscode.commands.registerCommand('devMate.copyHostDiagnostics', () => this.copyDiagnostics()));
    context.subscriptions.push(this.vscode.commands.registerCommand('devMate.hostSelfCheck', () => this.runSelfCheck(true)));

    try {
      this.platformActivationAttempted = true;
      await this.platformExtension.activate(this.runtimeContext);
      this.platformActivated = true;
      this.mirror = new VscodeContextMirror({
        vscode: this.vscode,
        context: this.runtimeContext,
        diagnostics: this.diagnostics
      }).start();
      context.subscriptions.push({ dispose: () => this.mirror?.dispose() });
      this.registerHostListeners(context);
      this.active = true;
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
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.startAutomatically().catch(error => this.handleStartupFailure(error));
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

  async startAutomatically() {
    const check = this.runSelfCheck(false);
    if (!check.ok) throw Object.assign(new Error('VS Code host self-check failed before DevMate Start'), {
      code: 'DEVMATE_VSCODE_SELF_CHECK_FAILED'
    });
    this.diagnostics?.append('Starting DevMate automatically and waiting for verified public MCP Ready state.');
    const commandResult = await this.vscode.commands.executeCommand('devMate.start', { quiet: true });
    if (commandResult?.ok === false) {
      const error = new Error(commandResult.error || 'DevMate start command reported failure');
      error.code = commandResult.code || 'DEVMATE_VSCODE_START_COMMAND_FAILED';
      throw error;
    }
    if (!commandResult?.mcpUrl || !Number.isInteger(Number(commandResult?.toolCount)) || Number(commandResult.toolCount) <= 0) {
      const error = new Error('DevMate Start returned before the public MCP endpoint reached verified Ready state');
      error.code = 'DEVMATE_VSCODE_START_NOT_READY';
      throw error;
    }
    const ready = await this.verifyGatewayReady();
    this.diagnostics?.clearFailure();
    this.diagnostics?.append(`Automatic DevMate Start verified on port ${ready.port}; tools=${commandResult.toolCount}.`);
    return { ...ready, mcpUrl: commandResult.mcpUrl, toolCount: commandResult.toolCount };
  }

  async handleStartupFailure(error) {
    this.diagnostics?.recordFailure(error, { phase: 'automatic-start' });
    const detail = error?.message || String(error);
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
    const report = await this.diagnostics.copy({ autoStart: this.autoStart() });
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

  async deactivate() {
    if (this.deactivating) return this.deactivating;
    this.deactivating = (async () => {
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.mirror?.dispose();
      this.mirror = null;
      try {
        if (this.platformActivationAttempted) await this.platformExtension.deactivate();
      } finally {
        this.platformActivationAttempted = false;
        this.platformActivated = false;
        this.diagnostics?.append('DevMate VS Code host deactivated.');
        this.active = false;
        this.runtimeContext = null;
        this.context = null;
        this.output = null;
        this.diagnostics = null;
      }
    })();
    try { return await this.deactivating; }
    finally { this.deactivating = null; }
  }
}

module.exports = { RELOAD_SETTINGS, VscodeHostLifecycle };
