'use strict';

const path = require('node:path');
const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
const { preflightPublicMcp, redactUrl } = require('../../host/public-mcp.js');
const { resolveNodeRuntime } = require('../../host/runtime/node-runtime.js');
const { OperationCoordinator } = require('../../host/runtime/operation-coordinator.js');
const { RuntimeController, resolveStateDirectory } = require('../../host/runtime-controller.js');
const { updateConfig } = require('../../shared/config-store.cjs');
const { normalizeInstanceConfig } = require('../../shared/instance-config.cjs');
const {
  recordGeneration,
  successfulVerificationPatch,
  verifiedForCurrentRecord
} = require('../../shared/public-ingress-verification.cjs');
const { settingsFromState } = require('../../vscode-host/effective-tunnel-settings.js');
const { TunnelController } = require('../../vscode-host/tunnel-controller.js');
const {
  assertTunnelSafeForCredentialChange,
  classifyTunnelStop,
  tunnelAllowsGatewayShutdown
} = require('../../vscode-host/tunnel-stop-policy.js');
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
const SESSION_RECOVERY_RETRY_MS = 30000;

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
    this.lastVerifiedAt = '';
    this.lastVerifiedToolCount = 0;
    this.lastPublicVerificationAttemptAt = 0;
    this.publicVerificationPromise = null;
    this.publicVerificationGeneration = '';
    this.sessionRequested = false;
    this.recoveryPromise = null;
    this.recoveryNextAt = 0;
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
    this.sessionRequested = false;
    this.recoveryNextAt = 0;
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.contextTimer = null;
    this.reconfigureTimer = null;
    await this.hostOperations.run('unload', async () => {
      await this.bridge?.stop();
      this.bridge = null;
      let tunnel = { stopped: false, reason: 'not-running' };
      try { tunnel = await this.tunnelController?.stop() || tunnel; }
      catch (error) {
        tunnel = { stopped: false, reason: error.message || String(error), error };
        this.logRuntime(`Could not stop owned public connection during unload: ${error.message || error}`);
      }
      const releaseGateway = tunnelAllowsGatewayShutdown(tunnel);
      const tunnelDisposed = await this.tunnelController?.dispose({ stopOwned: false }).catch(error => ({ disposed: false, reason: error.message || String(error) }));
      if (tunnelDisposed?.disposed === false) {
        this.logRuntime(`Public connection controller remains active after unload: ${tunnelDisposed.reason || 'stop not confirmed'}.`);
      }
      this.tunnelController = null;
      const gatewayDisposed = await this.controller?.dispose({ stopOwned: releaseGateway });
      if (gatewayDisposed?.disposed === false) {
        this.logRuntime(`Gateway is preserved because public connection shutdown was not confirmed: ${gatewayDisposed.reason || 'owned process still running'}.`);
      }
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
    const read = (value, provider) => {
      if (!value) return '';
      try { return decryptSecret(value); }
      catch (error) {
        const wrapped = new Error(`${provider} credential is configured but could not be decrypted: ${error.message || error}`);
        wrapped.code = 'DEVMATE_OBSIDIAN_CREDENTIAL_DECRYPT_FAILED';
        throw wrapped;
      }
    };
    this.tunnelSecretsCache = {
      ngrokAuthtoken: read(this.settings.ngrokAuthtokenEncrypted, 'ngrok'),
      cloudflareTunnelToken: read(this.settings.cloudflareTunnelTokenEncrypted, 'Cloudflare')
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

  tunnelSettings(stateDirectory = this.stateDirectory()) {
    return settingsFromState({
      stateDirectory,
      localSettings: this.localTunnelSettings()
    });
  }

  connectionConfiguration() {
    const config = this.controller?.readConfig?.() || null;
    if (!config) return { provider: 'ngrok', publicUrl: '' };
    normalizeInstanceConfig(config);
    return {
      provider: config.connection.provider,
      publicUrl: String(config.connection.publicUrl || '').trim()
    };
  }

  async configureConnection(patch = {}) {
    if (!this.controller?.configFile) return null;
    const requestedProvider = patch.provider === undefined ? null : tunnelProvider(String(patch.provider));
    const requestedPublicUrl = patch.publicUrl === undefined ? null : String(patch.publicUrl || '').trim();
    const status = await this.controller.status().catch(() => null);
    let stopState = { safe: true, remoteOwner: false, reason: 'not-running', tunnel: null };
    if (this.tunnelController) {
      const stopResult = await this.tunnelController.stop();
      stopState = assertTunnelSafeForCredentialChange(stopResult, 'Obsidian connection configuration change');
      if (stopState.remoteOwner) {
        this.logRuntime('The shared public connection remains active in another desktop process; the new configuration will be used by the next connection generation.');
      }
    }
    const updated = updateConfig(this.controller.configFile, config => {
      normalizeInstanceConfig(config);
      if (requestedProvider !== null) config.connection.provider = requestedProvider;
      if (requestedPublicUrl !== null) config.connection.publicUrl = requestedPublicUrl;
      return config;
    });
    this.clearPublicVerification();
    if (this.sessionRequested && status?.state === 'running' && !stopState.remoteOwner) await this.startRuntime({ quiet: true });
    else await this.refreshStatus();
    return updated;
  }

  updateConnectionSnapshot(patch = {}) {
    if (!this.controller?.configFile) return;
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    updateConfig(this.controller.configFile, config => {
      normalizeInstanceConfig(config);
      config.connection = { ...config.connection, ...cleanPatch };
      return config;
    });
  }

  clearPublicVerification() {
    this.lastVerifiedAt = '';
    this.lastVerifiedToolCount = 0;
  }

  currentTunnelRecord(port) {
    try { return this.tunnelController?.status(port)?.record || null; }
    catch { return null; }
  }

  async verifyPublicEndpoint(publicUrl, expectedRecord = null) {
    const normalized = String(publicUrl || '').trim();
    if (!normalized) throw new Error('The public connection did not publish an HTTPS origin');
    const initialRecord = expectedRecord || this.currentTunnelRecord();
    const generation = recordGeneration(initialRecord);
    if (!generation) {
      const error = new Error('The public connection is not a current ready Gateway+tunnel generation');
      error.code = 'DEVMATE_PUBLIC_MCP_GENERATION_UNAVAILABLE';
      throw error;
    }
    if (this.publicVerificationPromise) {
      if (this.publicVerificationGeneration === generation) return this.publicVerificationPromise;
      await this.publicVerificationPromise.catch(() => {});
      const latestRecord = this.currentTunnelRecord(initialRecord.port);
      return this.verifyPublicEndpoint(latestRecord?.publicUrl || normalized, latestRecord);
    }

    this.lastPublicVerificationAttemptAt = Date.now();
    this.publicVerificationGeneration = generation;
    this.publicVerificationPromise = (async () => {
      try {
        const test = await preflightPublicMcp({
          publicUrl: normalized,
          token: this.controller.ownerToken(),
          clientName: 'devmate-obsidian-preflight',
          clientVersion: this.manifest.version,
          readyTimeoutMs: 15000,
          shouldContinue: () => recordGeneration(this.currentTunnelRecord(initialRecord.port)) === generation
        });
        const currentRecord = this.currentTunnelRecord(initialRecord.port);
        if (recordGeneration(currentRecord) !== generation) {
          const error = new Error('Public MCP verification became stale because the Gateway or connection generation changed');
          error.code = 'DEVMATE_PUBLIC_MCP_STALE_GENERATION';
          throw error;
        }

        const stamp = new Date().toISOString();
        updateConfig(this.controller.configFile, config => {
          normalizeInstanceConfig(config);
          if (recordGeneration(this.currentTunnelRecord(initialRecord.port)) !== generation) return config;
          config.connection = {
            ...config.connection,
            ...successfulVerificationPatch(test, normalized, stamp, initialRecord)
          };
          return config;
        });

        const persisted = this.controller.readConfig();
        const persistedRecord = this.currentTunnelRecord(initialRecord.port);
        if (
          recordGeneration(persistedRecord) !== generation ||
          !verifiedForCurrentRecord(persisted, persistedRecord)
        ) {
          const error = new Error('Public MCP verification could not be committed for the current Gateway+connection generation');
          error.code = 'DEVMATE_PUBLIC_MCP_STALE_GENERATION';
          throw error;
        }

        this.lastVerifiedAt = stamp;
        this.lastVerifiedToolCount = test.toolCount;
        this.logRuntime(`Verified public MCP endpoint: ${redactUrl(test.mcpUrl)} tools=${test.toolCount}`);
        return test;
      } catch (error) {
        this.clearPublicVerification();
        if (recordGeneration(this.currentTunnelRecord(initialRecord.port)) === generation) {
          this.updateConnectionSnapshot({
            lastError: String(error.message || error),
            lastErrorAt: new Date().toISOString()
          });
        }
        throw error;
      } finally {
        if (this.publicVerificationGeneration === generation) {
          this.publicVerificationPromise = null;
          this.publicVerificationGeneration = '';
        }
      }
    })();
    return this.publicVerificationPromise;
  }

  reconfigureRuntime(options = {}) {
    if (this.unloading) return Promise.resolve({ skipped: true, reason: 'unloading' });
    return this.hostOperations.run('reconfigure', () => this.reconfigureRuntimeInternal(options));
  }

  async reconfigureRuntimeInternal({ startBridge = this.layoutReady, capture = this.layoutReady } = {}) {
    const pluginDirectory = this.pluginDirectory();
    const stateDirectory = this.stateDirectory();
    const sameState = this.controller && path.resolve(this.controller.stateDirectory) === path.resolve(stateDirectory);
    this.invalidateNodeRuntime();
    this.invalidateTunnelSecrets();
    if (!sameState) {
      let previousTunnel = { stopped: false, reason: 'not-running' };
      try {
        previousTunnel = await this.tunnelController?.stop() || previousTunnel;
      } catch (error) {
        previousTunnel = { stopped: false, reason: error.message || String(error), error };
      }
      const previousTunnelState = classifyTunnelStop(previousTunnel);
      if (!tunnelAllowsGatewayShutdown(previousTunnel)) {
        const error = new Error(previousTunnelState.remoteOwner
          ? 'Cannot switch DevMate state directory while another host still owns the public connection for the current Gateway.'
          : `Cannot switch DevMate state directory because public connection shutdown was not confirmed (${previousTunnelState.reason}).`);
        error.code = 'DEVMATE_OBSIDIAN_RECONFIGURE_BLOCKED';
        throw error;
      }
      await this.bridge?.stop();
      this.bridge = null;
      const tunnelDisposed = await this.tunnelController?.dispose({ stopOwned: false });
      if (tunnelDisposed?.disposed === false) {
        const error = new Error(`Cannot switch DevMate state directory because the previous public connection controller is still active (${tunnelDisposed.reason || 'unknown'}).`);
        error.code = 'DEVMATE_OBSIDIAN_RECONFIGURE_BLOCKED';
        throw error;
      }
      this.tunnelController = null;
      const gatewayDisposed = await this.controller?.dispose({ stopOwned: true });
      if (gatewayDisposed?.disposed === false) {
        const error = new Error(`Cannot switch DevMate state directory because the previous Gateway could not be released (${gatewayDisposed.reason || 'unknown'}).`);
        error.code = 'DEVMATE_OBSIDIAN_RECONFIGURE_BLOCKED';
        throw error;
      }
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
        settings: () => this.tunnelSettings(stateDirectory),
        getSecrets: async () => this.tunnelSecrets(),
        hostId: `${HOST_ID}-${process.pid}`,
        logger: message => this.logRuntime(message)
      });
      this.logRuntime(`Configured shared DevMate Gateway and public connection lifecycle for ${this.vaultRoot}.`);
    } else {
      await this.bridge?.stop();
      this.bridge = null;
      this.controller.preferredPort = this.settings.preferredPort;
      this.runtimeDiagnostics?.setStateDirectory(stateDirectory);
      if (!this.tunnelController) {
        this.tunnelController = new TunnelController({
          stateDirectory,
          settings: () => this.tunnelSettings(stateDirectory),
          getSecrets: async () => this.tunnelSecrets(),
          hostId: `${HOST_ID}-${process.pid}`,
          logger: message => this.logRuntime(message)
        });
      }
    }
    this.controller.ensureConfig();

    if (!this.settings.enabled) {
      this.sessionRequested = false;
      this.recoveryNextAt = 0;
      let stoppedTunnel = { stopped: false, reason: 'not-running' };
      try {
        stoppedTunnel = await this.tunnelController?.stop() || stoppedTunnel;
      } catch (error) {
        stoppedTunnel = { stopped: false, reason: error.message || String(error), error };
        this.logRuntime(`Could not release public connection while disabling DevMate: ${error.message || error}`);
      }
      if (tunnelAllowsGatewayShutdown(stoppedTunnel)) {
        try { await this.controller?.stop(); } catch (error) {
          this.logRuntime(`Could not release Gateway while disabling DevMate: ${error.message || error}`);
        }
      } else {
        const stoppedState = classifyTunnelStop(stoppedTunnel);
        this.logRuntime(stoppedState.remoteOwner
          ? 'DevMate is disabled locally, but the Gateway is preserved because another host still owns the public connection.'
          : `DevMate is disabled locally, but the Gateway is preserved because public connection shutdown was not confirmed (${stoppedState.reason}).`);
      }
      await this.refreshStatus();
      return { configured: true, stateDirectory, disabled: true };
    }

    if (startBridge) {
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
        const config = this.controller.readConfig();
        const verified = !!tunnel.record && verifiedForCurrentRecord(config, tunnel.record);
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
      status.tunnel?.record &&
      !status.verified &&
      !this.publicVerificationPromise &&
      Date.now() - this.lastPublicVerificationAttemptAt >= PUBLIC_REVERIFY_BACKOFF_MS
    ) {
      void this.verifyPublicEndpoint(status.tunnel.publicUrl, status.tunnel.record)
        .then(() => this.refreshStatus())
        .catch(error => this.logRuntime(`Public MCP verification failed: ${error.message || error}`));
    }

    const needsFullRecovery = this.sessionRequested && this.settings.enabled && (
      status.gateway?.state !== 'running' || !status.tunnel?.running
    );
    if (
      needsFullRecovery &&
      !this.recoveryPromise &&
      Date.now() >= this.recoveryNextAt
    ) {
      this.recoveryPromise = this.startRuntime({ quiet: true })
        .then(result => {
          if (!result?.ok || !result?.mcpUrl || Number(result?.toolCount || 0) <= 0) {
            throw new Error(result?.error || 'DevMate recovery did not reach verified Ready state');
          }
          this.recoveryNextAt = 0;
          this.logRuntime(`Recovered requested DevMate session; tools=${result.toolCount}.`);
          return result;
        })
        .catch(error => {
          this.recoveryNextAt = Date.now() + SESSION_RECOVERY_RETRY_MS;
          this.logRuntime(`Automatic DevMate recovery failed: ${error.message || error}`);
        })
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
      this.controller.activateWorkspace();
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

      const preflight = await this.verifyPublicEndpoint(publicUrl, tunnel.record);
      this.runtimeDiagnostics?.clearFailure();
      this.sessionRequested = true;
      this.recoveryNextAt = 0;
      let copied = false;
      let copyError = '';
      if (this.settings.autoCopyUrl) {
        try {
          await navigator.clipboard.writeText(preflight.mcpUrl);
          copied = true;
          this.updateConnectionSnapshot({ lastCopiedAt: new Date().toISOString() });
        } catch (error) {
          copyError = error.message || String(error);
          this.logRuntime(`DevMate reached Ready but automatic MCP URL copy failed: ${copyError}`);
        }
      }
      if (!quiet) {
        if (copied) new Notice(`DevMate ready. Verified MCP URL copied: ${redactUrl(preflight.mcpUrl)}`);
        else if (this.settings.autoCopyUrl && copyError) new Notice('DevMate ready. Automatic URL copy failed; use Copy MCP URL if needed.');
        else new Notice(`DevMate ready: ${redactUrl(preflight.mcpUrl)}`);
      }
      return {
        ok: true,
        state: 'ready',
        gateway,
        tunnel,
        publicUrl: preflight.publicOrigin,
        mcpUrl: preflight.mcpUrl,
        toolCount: preflight.toolCount,
        server: preflight.server,
        copied,
        copyError
      };
    } catch (error) {
      if (this.sessionRequested) this.recoveryNextAt = Date.now() + SESSION_RECOVERY_RETRY_MS;
      let publicConnectionSafeToReleaseGateway = !(tunnel?.attached && !tunnel?.owned);
      if (tunnel?.owned) {
        try {
          const stopped = await this.tunnelController.stop();
          publicConnectionSafeToReleaseGateway = tunnelAllowsGatewayShutdown(stopped);
        } catch (cleanupError) {
          publicConnectionSafeToReleaseGateway = false;
          this.logRuntime(`Could not roll back owned public connection after failed Start: ${cleanupError.message || cleanupError}`);
        }
      }
      if (gateway?.started && gateway?.owned) {
        this.logRuntime(publicConnectionSafeToReleaseGateway
          ? 'Public connection startup failed; keeping the local Gateway available for diagnostics and retry.'
          : 'Preserving the newly owned Gateway because the public connection is still active or its shutdown was not confirmed.');
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
    this.sessionRequested = false;
    this.recoveryNextAt = 0;
    let tunnel = { stopped: false, reason: 'not-running' };
    let gateway = { stopped: false, reason: 'not-running' };
    try {
      try { tunnel = await this.tunnelController?.stop() || tunnel; }
      catch (error) {
        tunnel = { stopped: false, reason: error.message || String(error), error };
        this.logRuntime(`Public connection stop reported: ${error.message || error}`);
      }
      const tunnelState = classifyTunnelStop(tunnel);
      if (!tunnelAllowsGatewayShutdown(tunnel)) {
        const reason = tunnelState.remoteOwner
          ? 'preserved-for-remote-public-connection'
          : 'preserved-after-public-connection-stop-failure';
        if (!quiet) new Notice(tunnelState.remoteOwner
          ? 'DevMate remains shared under another host; this Gateway was preserved.'
          : 'DevMate could not confirm public connection shutdown, so the Gateway was preserved.');
        return { stopped: false, sharedStillActive: true, reason, gateway, tunnel };
      }
      gateway = await this.controller.stop();
      const sharedStillActive = gateway.reason === 'managed-by-another-host' || gateway.attached;
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
      let tunnel = { stopped: false, reason: 'not-running' };
      try { tunnel = await this.tunnelController?.stop() || tunnel; } catch (error) {
        tunnel = { stopped: false, reason: error.message || String(error), error };
        this.logRuntime(`Public connection stop before restart reported: ${error.message || error}`);
      }
      const tunnelState = classifyTunnelStop(tunnel);
      if (!tunnelAllowsGatewayShutdown(tunnel)) {
        const reason = tunnelState.remoteOwner ? 'public connection is managed by another host' : `public connection stop was not confirmed (${tunnelState.reason})`;
        throw new Error(`DevMate restart is blocked because ${reason}; the Gateway was preserved.`);
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
      const test = await this.verifyPublicEndpoint(publicUrl, tunnel.record);
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
