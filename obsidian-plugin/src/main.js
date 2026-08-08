'use strict';

const path = require('node:path');
const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
const { preflightPublicMcp, redactUrl } = require('../../host/public-mcp.js');
const { resolveNodeRuntime } = require('../../host/runtime/node-runtime.js');
const { OperationCoordinator } = require('../../host/runtime/operation-coordinator.js');
const { RuntimeController, resolveStateDirectory } = require('../../host/runtime-controller.js');
const { updateConfig } = require('../../shared/config-store.cjs');
const { settingsFromState } = require('../../vscode-host/effective-tunnel-settings.js');
const { TunnelController } = require('../../vscode-host/tunnel-controller.js');
const { tunnelProvider } = require('../../vscode-host/tunnel-settings.js');
const { ObsidianHostBridge } = require('./host-bridge.js');
const { ObsidianContextProvider } = require('./context-provider.js');
const { RuntimeDiagnostics } = require('./runtime-diagnostics.js');
const { decryptSecret } = require('./secret-store.js');
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
    this.tunnelController = null;
    this.bridge = null;
    this.contextProvider = null;
    this.runtimeDiagnostics = null;
    this.nodeRuntime = null;
    this.nodeRuntimeKey = '';
    this.tunnelSecretsCache = null;
    this.lastStatusText = '';
    this.lastVerifiedPublicUrl = '';
    this.lastVerifiedAt = '';
    this.lastVerifiedToolCount = 0;
    this.lastPublicVerificationAttemptAt = 0;
    this.publicVerificationPromise = null;
    this.recoveryPromise = null;
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
    if (this.settings.enabled && this.settings.autoStart) await this.startRuntime({ quiet: true });
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
      try { await this.tunnelController?.dispose({ stopOwned: true }); } catch (error) {
        this.logRuntime(`Could not stop owned public connection during unload: ${error.message || error}`);
      }
      this.tunnelController = null;
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

  invalidateTunnelSecrets() {
    this.tunnelSecretsCache = null;
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

  tunnelSecrets() {
    if (this.tunnelSecretsCache) return this.tunnelSecretsCache;
    const read = value => {
      if (!value) return '';
      try { return decryptSecret(value); }
      catch (error) {
        this.logRuntime(`Could not decrypt provider credential: ${error.message || error}`);
        return '';
      }
    };
    this.tunnelSecretsCache = {
      ngrokAuthtoken: read(this.settings.ngrokAuthtokenEncrypted),
      cloudflareTunnelToken: read(this.settings.cloudflareTunnelTokenEncrypted)
    };
    return this.tunnelSecretsCache;
  }

  localTunnelSettings() {
    const secrets = this.tunnelSecrets();
    return {
      ngrokCommandPath: this.settings.ngrokCommandPath,
      ngrokUseManagedAccount: !!secrets.ngrokAuthtoken,
      ngrokPoolingEnabled: this.settings.ngrokPoolingEnabled,
      cloudflareCommandPath: this.settings.cloudflareCommandPath,
      autoRestart: this.settings.tunnelAutoRestart,
      maxRestarts: this.settings.tunnelMaxRestarts
    };
  }

  tunnelSettings() {
    return settingsFromState({
      stateDirectory: this.stateDirectory(),
      localSettings: this.localTunnelSettings()
    });
  }

  connectionConfiguration() {
    const config = this.controller?.readConfig?.() || null;
    const deployment = config?.deployment && typeof config.deployment === 'object' ? config.deployment : {};
    return {
      provider: deployment.tunnelProvider || 'ngrok',
      publicUrl: String(deployment.publicUrl || '').trim()
    };
  }

  async configureConnection(patch = {}) {
    if (!this.controller?.configFile) return null;
    const requestedProvider = patch.provider === undefined ? null : tunnelProvider(String(patch.provider));
    const requestedPublicUrl = patch.publicUrl === undefined ? null : String(patch.publicUrl || '').trim();
    const status = await this.controller.status().catch(() => null);
    if (this.tunnelController) {
      try { await this.tunnelController.stop(); } catch (error) {
        this.logRuntime(`Connection reconfiguration stop reported: ${error.message || error}`);
      }
    }
    const updated = updateConfig(this.controller.configFile, config => {
      config.deployment ||= {};
      if (requestedProvider !== null) config.deployment.tunnelProvider = requestedProvider;
      if (requestedPublicUrl !== null) config.deployment.publicUrl = requestedPublicUrl;
      return config;
    });
    this.clearPublicVerification();
    if (status?.state === 'running') await this.startRuntime({ quiet: true });
    else await this.refreshStatus();
    return updated;
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

  async verifyPublicEndpoint(publicUrl) {
    const normalized = String(publicUrl || '').trim();
    if (!normalized) throw new Error('The public connection did not publish an HTTPS origin');
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
    this.invalidateTunnelSecrets();
    if (!sameState) {
      try { await this.tunnelController?.dispose({ stopOwned: true }); } catch {}
      this.tunnelController = null;
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
      this.tunnelController = new TunnelController({
        stateDirectory,
        settings: () => this.tunnelSettings(),
        getSecrets: async () => this.tunnelSecrets(),
        hostId: `${HOST_ID}-${process.pid}`,
        logger: message => this.logRuntime(message)
      });
      this.logRuntime(`Configured shared DevMate Gateway and public connection lifecycle for ${this.vaultRoot}.`);
    } else {
      this.controller.preferredPort = this.settings.preferredPort;
      this.runtimeDiagnostics?.setStateDirectory(stateDirectory);
      if (!this.tunnelController) {
        this.tunnelController = new TunnelController({
          stateDirectory,
          settings: () => this.tunnelSettings(),
          getSecrets: async () => this.tunnelSecrets(),
          hostId: `${HOST_ID}-${process.pid}`,
          logger: message => this.logRuntime(message)
        });
      }
    }
    this.controller.ensureConfig();

    if (startBridge && this.settings.enabled) {
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
    if (!this.settings.enabled) {
      return { label: 'DevMate disabled', detail: 'Enable DevMate in settings.', state: 'disabled' };
    }
    try {
      const gateway = await this.controller.status();
      let tunnel = { running: false, owned: false, attached: false, publicUrl: '', provider: this.connectionConfiguration().provider, port: gateway.port || 0 };
      let connectionError = '';
      try { tunnel = this.tunnelController?.status(gateway.port) || tunnel; }
      catch (error) { connectionError = error.message || String(error); }

      if (gateway.state === 'running') {
        const verified = !!tunnel.publicUrl && this.lastVerifiedPublicUrl === tunnel.publicUrl;
        if (verified) {
          return {
            ...gateway,
            gateway,
            tunnel,
            connection: tunnel,
            verified: true,
            publicUrl: tunnel.publicUrl,
            state: 'ready',
            label: 'DevMate ready',
            detail: `Verified public MCP via ${tunnel.provider}: ${redactUrl(`${tunnel.publicUrl}/mcp`)}`
          };
        }
        if (connectionError) {
          return { ...gateway, gateway, tunnel, connectionError, state: 'error', label: 'DevMate connection error', detail: connectionError };
        }
        if (tunnel.running && tunnel.publicUrl) {
          return {
            ...gateway,
            gateway,
            tunnel,
            connection: tunnel,
            verified: false,
            publicUrl: tunnel.publicUrl,
            state: 'verifying',
            label: 'DevMate verifying',
            detail: `Public HTTPS endpoint is ready via ${tunnel.provider}; verifying MCP initialize and tools/list.`
          };
        }
        return {
          ...gateway,
          gateway,
          tunnel,
          connection: tunnel,
          verified: false,
          state: 'starting',
          label: 'DevMate starting',
          detail: 'Gateway is healthy; DevMate is bringing the public MCP connection to Ready.'
        };
      }
      if (gateway.state === 'foreign') {
        return { ...gateway, gateway, tunnel, connectionError, label: 'Port conflict', detail: `Another DevMate instance is using port ${gateway.port}.` };
      }
      if (this.runtimeDiagnostics?.lastFailure) {
        return {
          ...gateway,
          gateway,
          tunnel,
          connectionError,
          state: 'error',
          label: 'DevMate failed to start',
          detail: this.runtimeDiagnostics.lastFailure.message
        };
      }
      return { ...gateway, gateway, tunnel, connectionError, state: 'stopped', label: 'DevMate stopped', detail: `Preferred internal port ${gateway.port}.` };
    } catch (error) {
      return { label: 'DevMate error', detail: error.message || String(error), state: 'error' };
    }
  }

  async refreshStatus() {
    if (!this.statusBar || !this.controller || this.unloading) return;
    const status = await this.runtimeStatus();
    const statusText = status.state === 'ready'
      ? 'DevMate: ready'
      : status.state === 'starting' || status.state === 'verifying'
        ? 'DevMate: starting'
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
      status.tunnel?.publicUrl &&
      !status.verified &&
      !this.publicVerificationPromise &&
      Date.now() - this.lastPublicVerificationAttemptAt >= PUBLIC_REVERIFY_BACKOFF_MS
    ) {
      void this.verifyPublicEndpoint(status.tunnel.publicUrl)
        .then(() => this.refreshStatus())
        .catch(error => this.logRuntime(`Public MCP verification failed: ${error.message || error}`));
    }

    if (
      this.settings.autoStart &&
      status.gateway?.state === 'running' &&
      !status.tunnel?.running &&
      !this.recoveryPromise
    ) {
      this.recoveryPromise = this.startRuntime({ quiet: true })
        .catch(error => this.logRuntime(`Automatic DevMate recovery failed: ${error.message || error}`))
        .finally(() => { this.recoveryPromise = null; });
    }
  }

  startRuntime(options = {}) {
    if (this.unloading) return Promise.resolve({ ok: false, reason: 'unloading' });
    return this.hostOperations.run('start', () => this.startRuntimeInternal(options));
  }

  async startRuntimeInternal({ quiet = false } = {}) {
    if (!this.settings.enabled) {
      if (!quiet) new Notice('DevMate is disabled in Obsidian settings.');
      return { ok: false, reason: 'disabled' };
    }
    let gateway = null;
    let tunnel = null;
    try {
      if (!this.bridge && this.layoutReady) await this.reconfigureRuntimeInternal({ startBridge: true, capture: true });
      this.ensureNodeRuntime();
      await this.captureContextInternal();

      this.logRuntime('Starting DevMate: Gateway -> public connection -> MCP verification.');
      gateway = await this.controller.start();
      this.logRuntime(gateway.attached
        ? `Attached to shared DevMate Gateway on port ${gateway.port}.`
        : `DevMate Gateway started on internal port ${gateway.port}.`);

      tunnel = await this.tunnelController.start(gateway.port);
      const publicUrl = tunnel?.publicUrl || tunnel?.record?.publicUrl || '';
      if (!publicUrl) throw new Error('The configured connection provider did not publish a public HTTPS URL');
      this.logRuntime(tunnel.attached
        ? `Attached to shared ${tunnel.record?.provider || 'public'} connection: ${redactUrl(publicUrl)}`
        : `Public connection ready: ${redactUrl(publicUrl)}`);

      const preflight = await this.verifyPublicEndpoint(publicUrl);
      this.runtimeDiagnostics?.clearFailure();
      if (this.settings.autoCopyUrl) await navigator.clipboard.writeText(preflight.mcpUrl);
      if (!quiet) {
        new Notice(this.settings.autoCopyUrl
          ? `DevMate ready. Verified MCP URL copied: ${redactUrl(preflight.mcpUrl)}`
          : `DevMate ready: ${redactUrl(preflight.mcpUrl)}`);
      }
      return {
        ok: true,
        state: 'ready',
        gateway,
        tunnel,
        publicUrl: preflight.publicOrigin,
        mcpUrl: preflight.mcpUrl,
        toolCount: preflight.toolCount,
        server: preflight.server
      };
    } catch (error) {
      if (tunnel?.owned) {
        try { await this.tunnelController.stop(); } catch (cleanupError) {
          this.logRuntime(`Could not roll back owned public connection after failed Start: ${cleanupError.message || cleanupError}`);
        }
      }
      if (gateway?.started && gateway?.owned) {
        try { await this.controller.stop(); } catch (cleanupError) {
          this.logRuntime(`Could not roll back owned Gateway after failed Start: ${cleanupError.message || cleanupError}`);
        }
      }
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

  async stopRuntimeInternal({ quiet = false } = {}) {
    let tunnel = { stopped: false, reason: 'not-running' };
    let gateway = { stopped: false, reason: 'not-running' };
    try {
      try { tunnel = await this.tunnelController?.stop() || tunnel; }
      catch (error) { this.logRuntime(`Public connection stop reported: ${error.message || error}`); }
      gateway = await this.controller.stop();
      const sharedStillActive = tunnel.reason === 'managed-by-another-host' || gateway.reason === 'managed-by-another-host' || gateway.attached;
      if (!sharedStillActive) this.clearPublicVerification();
      this.runtimeDiagnostics?.clearFailure();
      if (!quiet) {
        if (sharedStillActive) new Notice('This host released its DevMate processes; the shared instance remains active under another host.');
        else if (tunnel.stopped || gateway.stopped) new Notice('DevMate stopped.');
        else new Notice('DevMate is not running.');
      }
      return { stopped: !sharedStillActive, gateway, tunnel };
    } catch (error) {
      if (!quiet) new Notice(`DevMate stop failed: ${error.message || error}`);
      return { stopped: false, reason: error.message || String(error), gateway, tunnel };
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
      try { await this.tunnelController?.stop(); } catch (error) {
        this.logRuntime(`Public connection stop before restart reported: ${error.message || error}`);
      }
      try { await this.controller.stop(); } catch (error) {
        this.logRuntime(`Gateway stop before restart reported: ${error.message || error}`);
      }
      this.clearPublicVerification();
      const result = await this.startRuntimeInternal({ quiet: true });
      if (!result.ok) throw new Error(result.error || 'DevMate did not return to Ready');
      new Notice(`DevMate restarted and Ready: ${redactUrl(result.mcpUrl)}`);
      return { restarted: true, ...result };
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
      if (gateway.state !== 'running') throw new Error('DevMate is not running. Run DevMate: Start first.');
      const tunnel = this.tunnelController?.status(gateway.port);
      const publicUrl = tunnel?.publicUrl || '';
      if (!publicUrl) throw new Error('DevMate has no active public connection. Run DevMate: Start first.');
      const test = await this.verifyPublicEndpoint(publicUrl);
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