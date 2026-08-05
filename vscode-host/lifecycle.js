'use strict';

const fs = require('node:fs');
const defaultChildProcess = require('node:child_process');
const { VscodeContextMirror } = require('./context-mirror.js');
const { installGatewayWorkerRouter } = require('./gateway-spawn-router.js');
const { VscodeRuntimeDiagnostics } = require('./runtime-diagnostics.js');
const {
  createRuntimeContext,
  currentWorkspaceRoot,
  setting
} = require('./runtime-context.js');

const RELOAD_SETTINGS = [
  'devMate.vscodeHostEnabled',
  'devMate.sharedRuntimeEnabled',
  'devMate.sharedStateDirectory'
];

class VscodeHostLifecycle {
  constructor({ vscode, platformExtension = null, childProcessModule = defaultChildProcess }) {
    this.vscode = vscode;
    this.platformExtension = platformExtension || require('../extension-entry-platform.js');
    this.childProcessModule = childProcessModule;
    this.context = null;
    this.runtimeContext = null;
    this.output = null;
    this.diagnostics = null;
    this.router = null;
    this.mirror = null;
    this.startupTimer = null;
    this.active = false;
    this.activating = null;
    this.platformActivationAttempted = false;
    this.platformActivated = false;
    this.workspaceRootAtActivation = '';
  }

  enabled() {
    return setting(this.vscode, 'vscodeHostEnabled', true) !== false && this.startupMode() !== 'disabled';
  }

  startupMode() {
    const value = String(setting(this.vscode, 'vscodeStartupMode', 'auto') || 'auto');
    return ['auto', 'manual', 'disabled'].includes(value) ? value : 'auto';
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
    if (!this.enabled()) return;

    this.runtimeContext = createRuntimeContext(this.vscode, context);
    this.workspaceRootAtActivation = currentWorkspaceRoot(this.vscode);
    this.output = this.vscode.window.createOutputChannel('DevMate Host');
    context.subscriptions.push(this.output);
    this.diagnostics = new VscodeRuntimeDiagnostics({
      vscode: this.vscode,
      context,
      runtimeContext: this.runtimeContext,
      output: this.output
    });
    this.diagnostics.append(`Activating DevMate VS Code host ${context.extension?.packageJSON?.version || ''}.`);

    this.router = installGatewayWorkerRouter({
      childProcess: this.childProcessModule,
      extensionPath: context.extensionPath,
      diagnostics: this.diagnostics
    });

    context.subscriptions.push(this.vscode.commands.registerCommand('devMate.copyHostDiagnostics', () =>
      this.copyDiagnostics()
    ));
    context.subscriptions.push(this.vscode.commands.registerCommand('devMate.hostSelfCheck', () =>
      this.runSelfCheck(true)
    ));

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
      if (!check.ok) this.diagnostics.append('Host activated with self-check failures; automatic start is suppressed.', 'error');
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
        'DevMate host settings changed. Reload VS Code to apply the new runtime state safely.',
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
    const result = this.diagnostics.selfCheck({ router: this.router });
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
    if (this.startupMode() !== 'auto' || !currentWorkspaceRoot(this.vscode)) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.startAutomatically().catch(error => this.handleStartupFailure(error));
    }, 0);
  }

  async startAutomatically() {
    const check = this.runSelfCheck(false);
    if (!check.ok) throw Object.assign(new Error('VS Code host self-check failed before Gateway start'), {
      code: 'DEVMATE_VSCODE_SELF_CHECK_FAILED'
    });
    this.diagnostics?.append('Starting DevMate Gateway automatically through the embedded Worker router.');
    await this.vscode.commands.executeCommand('devMate.start');
    this.diagnostics?.clearFailure();
    this.diagnostics?.append('Automatic Gateway start completed.');
  }

  async handleStartupFailure(error) {
    this.diagnostics?.recordFailure(error, { phase: 'automatic-start' });
    const detail = error?.message || String(error);
    const choice = await this.vscode.window.showErrorMessage(
      `DevMate could not start: ${detail}`,
      'Copy diagnostics',
      'Open Host Log'
    );
    if (choice === 'Copy diagnostics') await this.copyDiagnostics();
    if (choice === 'Open Host Log') await this.openHostLog();
  }

  async copyDiagnostics() {
    if (!this.diagnostics) return '';
    const report = await this.diagnostics.copy({
      router: this.router,
      startupMode: this.startupMode(),
      enabled: this.enabled()
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

  async deactivate() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.mirror?.dispose();
    this.mirror = null;
    try {
      if (this.platformActivationAttempted) await this.platformExtension.deactivate();
    } finally {
      this.platformActivationAttempted = false;
      this.platformActivated = false;
      this.router?.dispose({ forceRestore: true });
      this.router = null;
      this.diagnostics?.append('DevMate VS Code host deactivated.');
      this.active = false;
      this.runtimeContext = null;
      this.context = null;
      this.output = null;
      this.diagnostics = null;
    }
  }
}

module.exports = {
  RELOAD_SETTINGS,
  VscodeHostLifecycle
};
