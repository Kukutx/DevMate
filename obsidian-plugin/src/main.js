'use strict';

const path = require('node:path');
const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
const { preflightPublicMcp, redactUrl } = require('../../host/public-mcp.js');
const { resolveNodeRuntime } = require('../../host/runtime/node-runtime.js');
const { OperationCoordinator } = require('../../host/runtime/operation-coordinator.js');
const { RuntimeController, resolveStateDirectory } = require('../../host/runtime-controller.js');
const { updateConfig } = require('../../shared/config-store.cjs');
const { ObsidianHostBridge } = require('./host-bridge.js');
const { ObsidianContextProvider } = require('./context-provider.js');
const { resolvePublicConnection } = require('./public-connection.js');
const { RuntimeDiagnostics } = require('./runtime-diagnostics.js');
const { DevMateSettingTab, normalizeSettings } = require('./settings.js');
const { DevMateView, VIEW_TYPE } = require('./view.js');

const HOST_ID = 'obsidian';
const CONTEXT_CAPTURE_DEBOUNCE_MS = 750;
const STATUS_REFRESH_MS = 5000;
const PUBLIC_REVERIFY_BACKOFF_MS = 30000;

module.exports = class DevMateObsidianPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText('DevMate: loading');
    this.contextTimer = null;
    this.reconfigureTimer = null;
    this.controller = null;
    this.bridge = null;
    this.contextProvider = null;
    this.runtimeDiagnostics = null;
    this.nodeRuntime = null;
    this.nodeRuntimeKey = '';
    this.lastStatusText = '';
    this.lastVerifiedPublicUrl = '';
    this.lastVerifiedAt = '';
    this.lastVerifiedToolCount = 0;
    this.lastPublicVerificationAttemptAt = 0;
    this.publicVerificationPromise = null;
    this.vaultRoot = '';
    this.layoutReady = false;
    this.unloading = false;
    this.hostOperations = new OperationCoordinator({ name: 'obsidian-host' });

    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      this.statusBar.setText('DevMate: desktop only');
      new Notice('DevMate requires the Obsidian desktop app and a filesystem-backed vault.');
      return;
    }

    this.vaultRoot = this.app.vault.adapter.getBasePath();
    this.contextProvider = new ObsidianContextProvider(this);

    this.registerView(VIEW_TYPE, leaf => new DevMateView(leaf, this));
    this.addRibbonIcon('bot', 'Open DevMate', () => this.openView());
    this.addSettingTab(new DevMateSettingTab(this.app, this));

    this.addCommand({ id: 'start', name: 'Start', callback: () => this.startRuntime() });
    this.addCommand({ id: 'stop', name: 'Stop', callback: () => this.stopRuntime() });
    this.addCommand({ id: 'restart', name: 'Restart', callback: () => this.restartRuntime() });
    this.addCommand({ id: 'open', name: 'Open panel', callback: () => this.openView() });
    this.addCommand({ id: 'copy-url', name: 'Copy MCP URL', callback: () => this.copyConnectionUrl() });
    this.addCommand({ id: 'copy-token', name: 'Copy MCP bearer token', callback: () => this.copyConnectionToken() });
    this.addCommand({ id: 'copy-context', name: 'Copy active vault context', callback: () => this.copyContextBundle() });
    this.addCommand({ id: 'copy-diagnostics', name: 'Copy diagnostics', callback: () => this.copyDiagnostics() });

    await this.reconfigureRuntime({ startBridge: false, capture: false });
    this.app.workspace.onLayoutReady(() => this.initializeLayoutReady());
  }

  async initializeLayoutReady() {
    if (this.layoutReady) return;
    this.layoutReady = true;
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.vault.on('create', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.metadataCache.on('changed', file => {
      if (file.path === this.app.workspace.getActiveFile()?.path) this.scheduleContextCapture();
    }));
    this.registerInterval(window.setInterval(() => {
      this.refreshStatus().catch(error => this.logRuntime(`Status refresh failed: ${error.message || error}`));
    }, STATUS_REFRESH_MS));

    await this.reconfigureRuntime({ startBridge: true, capture: true });
    if (this.settings.enabled && this.settings.startupMode === 'auto') await this.startRuntime({ quiet: true });
    else await this.refreshStatus();
  }

  async onunload() {
    this.unloading = true;
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.contextTimer = null;
    this.reconfigureTimer = null;
    await this.hostOperations.run('unload', async () => {
      await this.bridge?.stop();
      this.bridge = null;
      await this.controller?.dispose({ stopOwned: true });
      this.controller = null;
    });
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  pluginDirectory() {
    const relative = this.manifest.dir || path.join(this.app.vault.configDir, 'plugins', this.manifest.id);
    return path.join(this.vaultRoot, relative);
  }

  stateDirectory() {
    return resolveStateDirectory({
      workspaceRoot: this.vaultRoot,
      overrideDirectory: this.settings.sharedStateDirectory
    });
  }

  logRuntime(message) {
    console.log(`[DevMate] ${message}`);
    this.runtimeDiagnostics?.append(message);
  }

  invalidateNodeRuntime() {
    this.nodeRuntime = null;
    this.nodeRuntimeKey = '';
  }

  ensureNodeRuntime() {
    if (!this.controller) throw new Error('DevMate runtime controller is unavailable');
    const key = `${this.settings.nodeExecutable || 'auto'}|${process.execPath}|${process.versions.node || ''}`;
    if (this.nodeRuntime && this.nodeRuntimeKey === key) return this.nodeRuntime;
    const runtime = resolveNodeRuntime({ preferredExecutable: this.settings.nodeExecutable });
    this.nodeRuntime = runtime;
    this.nodeRuntimeKey = key;
    this.controller.nodeExecutable = runtime.executable;
    this.logRuntime(`Using Node ${runtime.nodeVersion} Gateway runtime from ${runtime.source}: ${runtime.executable}`);
    return runtime;
  }

  updateConnectionSnapshot(patch = {}) {
    if (!this.controller?.configFile) return;
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    updateConfig(this.controller.configFile, config => {
      config.connection = { ...(config.connection || {}), ...cleanPatch };
      return config;
    });
  }

  clearPublicVerification() {
    this.lastVerifiedPublicUrl = '';
    this.lastVerifiedAt = '';
    this.lastVerifiedToolCount = 0;
  }

  publicConnection(port) {
    return resolvePublicConnection({
      stateDirectory: this.stateDirectory(),
      port,
      publicOrigin: this.settings.publicOrigin,
      config: this.controller?.readConfig?.() || null,
      logger: message => this.logRuntime(message)
    });
  }

  async verifyPublicEndpoint(publicUrl) {
    const normalized = String(publicUrl || '').trim();
    if (!normalized) throw new Error('A public HTTPS MCP origin is required');
    if (this.publicVerificationPromise) return this.publicVerificationPromise;
    this.lastPublicVerificationAttemptAt = Date.now();
    this.publicVerificationPromise = (async () => {
      try {
        const test = await preflightPublicMcp({
          publicUrl: normalized,
          token: this.controller.ownerToken(),
          clientName: 'devmate-obsidian-preflight',
          clientVersion: this.manifest.version
        });
        const stamp = new Date().toISOString();
        this.lastVerifiedPublicUrl = test.publicOrigin;
        this.lastVerifiedAt = stamp;
        this.lastVerifiedToolCount = test.toolCount;
        this.updateConnectionSnapshot({
          lastPreflightAt: stamp,
          lastPublicOrigin: test.publicOrigin,
          lastPublicHost: new URL(test.publicOrigin).host,
          lastMcpPath: '/mcp',
          lastToolCount: test.toolCount,
          lastServerName: test.server?.name || 'devmate',
          lastError: '',
          lastErrorAt: null
        });
        this.logRuntime(`Verified public MCP endpoint: ${redactUrl(test.mcpUrl)} tools=${test.toolCount}`);
        return test;
      } catch (error) {
        this.clearPublicVerification();
        this.updateConnectionSnapshot({
          lastError: String(error.message || error),
          lastErrorAt: new Date().toISOString()
        });
        throw error;
      } finally {
        this.publicVerificationPromise = null;
      }
    })();
    return this.publicVerificationPromise;
  }

  reconfigureRuntime(options = {}) {
    if (this.unloading) return Promise.resolve({ skipped: true, reason: 'unloading' });
    return this.hostOperations.run('reconfigure', () => this.reconfigureRuntimeInternal(options));
  }

  async reconfigureRuntimeInternal({ startBridge = this.layoutReady, capture = this.layoutReady } = {}) {
    await this.bridge?.stop();
    this.bridge = null;
    const pluginDirectory = this.pluginDirectory();
    const stateDirectory = this.stateDirectory();
    const sameState = this.controller && path.resolve(this.controller.stateDirectory) === path.resolve(stateDirectory);
    this.invalidateNodeRuntime();
    if (!sameState) {
      await this.controller?.dispose({ stopOwned: true });
      this.runtimeDiagnostics = new RuntimeDiagnostics({
        stateDirectory,
        pluginVersion: this.manifest.version,
        vaultRoot: this.vaultRoot
      });
      this.controller = new RuntimeController({
        workspaceRoot: this.vaultRoot,
        stateDirectory,
        gatewayEntry: path.join(pluginDirectory, 'gateway', 'server.mjs'),
        preferredPort: this.settings.preferredPort,
        appVersion: this.manifest.version,
        hostId: HOST_ID,
        logger: message => this.logRuntime(message)
      });
      this.logRuntime(`Configured isolated shared Gateway for ${this.vaultRoot}.`);
    } else {
      this.controller.preferredPort = this.settings.preferredPort;
      this.runtimeDiagnostics?.setStateDirectory(stateDirectory);
    }
    this.controller.ensureConfig();

    if (startBridge && this.settings.enabled && this.settings.startupMode !== 'disabled') {
      const bridge = new ObsidianHostBridge(this, this.controller);
      try {
        await bridge.start();
        this.bridge = bridge;
      } catch (error) {
        await bridge.stop().catch(() => {});
        this.logRuntime(`Obsidian host bridge failed: ${error.message || error}`);
        new Notice(`DevMate host bridge failed: ${error.message || error}`);
      }
    }
    if (capture) await this.captureContextInternal();
    await this.refreshStatus();
    return { configured: true, stateDirectory };
  }

  scheduleReconfigure() {
    if (this.unloading) return;
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.reconfigureTimer = window.setTimeout(() => {
      this.reconfigureTimer = null;
      this.reconfigureRuntime().catch(error => this.logRuntime(`Runtime reconfiguration failed: ${error.message || error}`));
    }, 500);
  }

  scheduleContextCapture() {
    if (this.unloading || !this.controller || !this.settings.enabled) return;
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    this.contextTimer = window.setTimeout(() => {
      this.contextTimer = null;
      this.captureContext().catch(error => this.logRuntime(`Context capture failed: ${error.message || error}`));
    }, CONTEXT_CAPTURE_DEBOUNCE_MS);
  }

  captureContext() {
    if (this.unloading) return Promise.resolve(null);
    return this.hostOperations.run('capture', () => this.captureContextInternal());
  }

  async captureContextInternal() {
    if (!this.controller) return null;
    return this.contextProvider?.capture(this.controller);
  }

  async runtimeStatus() {
    if (!this.settings.enabled || this.settings.startupMode === 'disabled') {
      return { label: 'DevMate disabled', detail: 'Enable the Obsidian host in settings.', state: 'disabled' };
    }
    try {
      const gateway = await this.controller.status();
      let connection = null;
      let connectionError = '';
      try { connection = this.publicConnection(gateway.port); }
      catch (error) { connectionError = error.message || String(error); }

      if (gateway.state === 'running') {
        const verified = !!connection && this.lastVerifiedPublicUrl === connection.publicOrigin;
        const ownership = gateway.owned ? 'running' : 'attached';
        const publicDetail = connectionError
          ? `Public ingress state error: ${connectionError}`
          : connection
            ? verified
              ? `Public MCP verified via ${connection.provider || connection.source}: ${redactUrl(`${connection.publicOrigin}/mcp`)}`
              : `Public HTTPS origin available via ${connection.provider || connection.source}; MCP verification is pending.`
            : 'No public HTTPS ingress is active or configured in Obsidian.';
        return {
          ...gateway,
          gateway,
          connection,
          connectionError,
          verified,
          publicUrl: connection?.publicOrigin || '',
          label: gateway.owned ? 'DevMate running' : 'DevMate attached',
          detail: `Gateway ${ownership} on 127.0.0.1:${gateway.port}. ${publicDetail}`
        };
      }
      if (gateway.state === 'foreign') {
        return { ...gateway, gateway, connection, connectionError, label: 'Port conflict', detail: `Another DevMate instance is using port ${gateway.port}.` };
      }
      if (this.runtimeDiagnostics?.lastFailure) {
        return {
          ...gateway,
          gateway,
          connection,
          connectionError,
          state: 'error',
          label: 'DevMate failed to start',
          detail: this.runtimeDiagnostics.lastFailure.message
        };
      }
      return { ...gateway, gateway, connection, connectionError, label: 'DevMate stopped', detail: `Preferred internal port ${gateway.port}.` };
    } catch (error) {
      return { label: 'DevMate error', detail: error.message || String(error), state: 'error' };
    }
  }

  async refreshStatus() {
    if (!this.statusBar || !this.controller || this.unloading) return;
    const status = await this.runtimeStatus();
    const statusText = status.state === 'running'
      ? status.owned ? `DevMate: on :${status.port}` : `DevMate: attached :${status.port}`
      : status.label;
    if (statusText !== this.lastStatusText) {
      this.statusBar.setText(statusText);
      this.lastStatusText = statusText;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DevMateView) await leaf.view.refresh(status);
    }

    if (
      status.gateway?.state === 'running' &&
      status.connection?.publicOrigin &&
      !status.verified &&
      !this.publicVerificationPromise &&
      Date.now() - this.lastPublicVerificationAttemptAt >= PUBLIC_REVERIFY_BACKOFF_MS
    ) {
      void this.verifyPublicEndpoint(status.connection.publicOrigin)
        .then(() => this.refreshStatus())
        .catch(error => this.logRuntime(`Public MCP verification failed: ${error.message || error}`));
    }
  }

  startRuntime(options = {}) {
    if (this.unloading) return Promise.resolve({ ok: false, reason: 'unloading' });
    return this.hostOperations.run('start', () => this.startRuntimeInternal(options));
  }

  async startRuntimeInternal({ quiet = false } = {}) {
    if (!this.settings.enabled || this.settings.startupMode === 'disabled') {
      if (!quiet) new Notice('DevMate Obsidian host is disabled.');
      return { ok: false, reason: 'disabled' };
    }
    try {
      if (!this.bridge && this.layoutReady) await this.reconfigureRuntimeInternal({ startBridge: true, capture: true });
      this.ensureNodeRuntime();
      await this.captureContextInternal();
      this.logRuntime('Starting or attaching to the shared DevMate Gateway.');
      const result = await this.controller.start();
      this.runtimeDiagnostics?.clearFailure();
      this.logRuntime(result.attached
        ? `Attached to shared DevMate Gateway on port ${result.port}.`
        : `DevMate Gateway started on internal port ${result.port}.`);
      if (!quiet) {
        new Notice(result.attached
          ? 'Attached to the existing DevMate Gateway.'
          : 'DevMate Gateway started. Public ingress is managed separately.');
      }
      return { ok: true, ...result };
    } catch (error) {
      this.runtimeDiagnostics?.recordFailure(error);
      console.error('[DevMate] Start failed', error);
      if (!quiet) new Notice(`DevMate start failed: ${error.message || error}`);
      return { ok: false, error: error.message || String(error), code: error.code || 'DEVMATE_OBSIDIAN_START_FAILED' };
    } finally {
      await this.refreshStatus();
    }
  }

  stopRuntime() {
    if (this.unloading) return Promise.resolve({ stopped: false, reason: 'unloading' });
    return this.hostOperations.run('stop', () => this.stopRuntimeInternal());
  }

  async stopRuntimeInternal() {
    try {
      const result = await this.controller.stop();
      if (result.stopped) {
        this.clearPublicVerification();
        this.runtimeDiagnostics?.clearFailure();
        this.logRuntime('DevMate Gateway stopped by the user.');
        new Notice('DevMate Gateway stopped. Public ingress was not modified.');
      } else if (result.reason === 'managed-by-another-host') {
        new Notice('Gateway is managed by another host and was left running. Public ingress was not modified.');
      } else {
        this.runtimeDiagnostics?.clearFailure();
        new Notice('DevMate Gateway is not running.');
      }
      return result;
    } catch (error) {
      new Notice(`DevMate stop failed: ${error.message || error}`);
      return { stopped: false, reason: error.message || String(error) };
    } finally {
      await this.refreshStatus();
    }
  }

  restartRuntime() {
    if (this.unloading) return Promise.resolve({ restarted: false, reason: 'unloading' });
    return this.hostOperations.run('restart', () => this.restartRuntimeInternal());
  }

  async restartRuntimeInternal() {
    try {
      this.ensureNodeRuntime();
      this.clearPublicVerification();
      this.logRuntime('Restarting the shared DevMate Gateway.');
      const result = await this.controller.restart();
      this.runtimeDiagnostics?.clearFailure();
      if (result.attached) new Notice('Gateway is managed by another host; kept the shared instance attached.');
      else new Notice('DevMate Gateway restarted. Public ingress was not modified.');
      return result;
    } catch (error) {
      this.runtimeDiagnostics?.recordFailure(error);
      new Notice(`DevMate restart failed: ${error.message || error}`);
      return { restarted: false, reason: error.message || String(error) };
    } finally {
      await this.refreshStatus();
    }
  }

  async copyConnectionUrl() {
    try {
      const gateway = await this.controller.status();
      if (gateway.state !== 'running') throw new Error('DevMate Gateway is not running. Run DevMate: Start first.');
      const connection = this.publicConnection(gateway.port);
      if (!connection?.publicOrigin) {
        throw new Error('No public HTTPS origin is available. Start the tunnel from VS Code or configure Public origin in Obsidian settings.');
      }
      const test = await this.verifyPublicEndpoint(connection.publicOrigin);
      await navigator.clipboard.writeText(test.mcpUrl);
      this.updateConnectionSnapshot({ lastCopiedAt: new Date().toISOString() });
      new Notice(`Verified public MCP URL copied: ${redactUrl(test.mcpUrl)}`);
    } catch (error) {
      new Notice(`Could not copy public MCP URL: ${error.message || error}`);
    } finally {
      await this.refreshStatus();
    }
  }

  async copyConnectionToken() {
    try {
      const token = this.controller.ownerToken();
      if (!token) {
        new Notice('DevMate authentication is disabled or no owner token is configured.');
        return;
      }
      await navigator.clipboard.writeText(token);
      new Notice('DevMate bearer token copied. Keep it private and use it in the Authorization header.');
    } catch (error) {
      new Notice(`Could not copy bearer token: ${error.message || error}`);
    }
  }

  async copyContextBundle() {
    try {
      const payload = await this.contextProvider.bundle();
      await navigator.clipboard.writeText(payload);
      new Notice(`Obsidian context copied (${payload.length} characters).`);
    } catch (error) {
      new Notice(`Could not copy context: ${error.message || error}`);
    }
  }

  async copyDiagnostics() {
    try {
      const status = await this.runtimeStatus();
      const payload = this.runtimeDiagnostics?.report({ plugin: this, controller: this.controller, status }) || 'DevMate diagnostics are unavailable.';
      await navigator.clipboard.writeText(payload);
      new Notice('DevMate diagnostics copied.');
    } catch (error) {
      new Notice(`Could not copy diagnostics: ${error.message || error}`);
    }
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
