'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');
const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
const { preflightPublicMcp, redactUrl } = require('../../host/public-mcp.js');
const { resolveNodeRuntime } = require('../../host/runtime/node-runtime.js');
const { OperationCoordinator } = require('../../host/runtime/operation-coordinator.js');
const { RuntimeController, resolveStateDirectory } = require('../../host/runtime-controller.js');
const { updateConfig } = require('../../shared/config-store.cjs');
const { ObsidianHostBridge } = require('./host-bridge.js');
const { ObsidianContextProvider } = require('./context-provider.js');
const { ObsidianNgrokRuntime } = require('./ngrok-runtime.js');
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
    this.ngrokRuntime = null;
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
    this.addCommand({ id: 'ngrok-doctor', name: 'ngrok Doctor', callback: () => this.ngrokDoctor() });
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
      try { await this.ngrokRuntime?.dispose({ stopOwned: true }); } catch (error) {
        this.logRuntime(`Could not stop owned ngrok runtime during unload: ${error.message || error}`);
      }
      this.ngrokRuntime = null;
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
      config.deployment ||= {};
      config.deployment.tunnelProvider = 'ngrok';
      if (cleanPatch.publicUrl !== undefined) config.deployment.publicUrl = cleanPatch.publicUrl || '';
      return config;
    });
  }

  clearPublicVerification() {
    this.lastVerifiedPublicUrl = '';
    this.lastVerifiedAt = '';
    this.lastVerifiedToolCount = 0;
  }

  async verifyPublicEndpoint(publicUrl, { recordFailure = true } = {}) {
    const normalized = String(publicUrl || '').trim();
    if (!normalized) throw new Error('ngrok did not publish a public HTTPS URL');
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
          publicUrl: test.publicOrigin,
          lastPreflightAt: stamp,
          lastPublicHost: new URL(test.publicOrigin).host,
          lastMcpPath: '/mcp',
          lastToolCount: test.toolCount,
          lastServerName: test.server?.name || 'devmate',
          lastError: '',
          lastErrorAt: null
        });
        this.logRuntime(`Verified public MCP through ngrok: ${redactUrl(test.mcpUrl)} tools=${test.toolCount}`);
        return test;
      } catch (error) {
        this.clearPublicVerification();
        this.updateConnectionSnapshot({
          lastError: String(error.message || error),
          lastErrorAt: new Date().toISOString()
        });
        if (recordFailure) this.runtimeDiagnostics?.recordFailure(error);
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
      try { await this.ngrokRuntime?.dispose({ stopOwned: true }); } catch {}
      this.ngrokRuntime = null;
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
      this.ngrokRuntime = new ObsidianNgrokRuntime({
        plugin: this,
        stateDirectory,
        logger: message => this.logRuntime(message)
      });
      this.logRuntime(`Configured isolated Gateway + shared ngrok runtime for ${this.vaultRoot}.`);
    } else {
      this.controller.preferredPort = this.settings.preferredPort;
      this.runtimeDiagnostics?.setStateDirectory(stateDirectory);
      if (!this.ngrokRuntime) {
        this.ngrokRuntime = new ObsidianNgrokRuntime({
          plugin: this,
          stateDirectory,
          logger: message => this.logRuntime(message)
        });
      }
    }
    this.controller.ensureConfig();
    this.updateConnectionSnapshot({});

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
      let tunnel = { running: false, publicUrl: '', provider: 'ngrok', owned: false, attached: false, port: gateway.port || 0 };
      try { tunnel = this.ngrokRuntime?.status(gateway.port) || tunnel; }
      catch (error) {
        return {
          ...gateway,
          gateway,
          tunnel,
          state: 'error',
          label: 'DevMate tunnel error',
          detail: error.message || String(error)
        };
      }

      if (gateway.state === 'running') {
        if (tunnel.running && tunnel.publicUrl) {
          const verified = this.lastVerifiedPublicUrl === tunnel.publicUrl;
          return {
            ...gateway,
            gateway,
            tunnel,
            publicUrl: tunnel.publicUrl,
            verified,
            state: verified ? 'ready' : 'public-unverified',
            label: verified ? 'DevMate ready' : 'DevMate public endpoint pending verification',
            detail: verified
              ? `Verified public MCP: ${redactUrl(`${tunnel.publicUrl}/mcp`)}`
              : `ngrok is public at ${redactUrl(tunnel.publicUrl)}; MCP verification is pending.`
          };
        }
        if (tunnel.running) {
          return {
            ...gateway,
            gateway,
            tunnel,
            state: 'tunnel-starting',
            label: 'DevMate starting ngrok',
            detail: 'Gateway is healthy; waiting for ngrok to publish the ChatGPT-facing HTTPS endpoint.'
          };
        }
        return {
          ...gateway,
          gateway,
          tunnel,
          state: 'tunnel-offline',
          label: 'DevMate not public',
          detail: 'Gateway is healthy internally, but ngrok is not running. Run DevMate: Start.'
        };
      }
      if (gateway.state === 'foreign') {
        return { ...gateway, gateway, tunnel, label: 'Port conflict', detail: `Another DevMate instance is using port ${gateway.port}.` };
      }
      if (this.runtimeDiagnostics?.lastFailure) {
        return {
          ...gateway,
          gateway,
          tunnel,
          state: 'error',
          label: 'DevMate failed to become public',
          detail: this.runtimeDiagnostics.lastFailure.message
        };
      }
      return { ...gateway, gateway, tunnel, label: 'DevMate stopped', detail: 'Gateway and ngrok are not running.' };
    } catch (error) {
      return { label: 'DevMate error', detail: error.message || String(error), state: 'error' };
    }
  }

  async refreshStatus() {
    if (!this.statusBar || !this.controller || this.unloading) return;
    const status = await this.runtimeStatus();
    const statusText = status.state === 'ready'
      ? 'DevMate: ready'
      : status.state === 'tunnel-starting' || status.state === 'public-unverified'
        ? 'DevMate: verifying public MCP'
        : status.state === 'tunnel-offline'
          ? 'DevMate: ngrok offline'
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
      void this.verifyPublicEndpoint(status.tunnel.publicUrl, { recordFailure: false })
        .then(() => this.refreshStatus())
        .catch(error => this.logRuntime(`Public MCP re-verification failed: ${error.message || error}`));
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

      this.logRuntime('Starting DevMate Gateway for the ngrok public MCP endpoint.');
      const gateway = await this.controller.start();
      this.logRuntime(gateway.attached
        ? `Attached to shared DevMate Gateway on port ${gateway.port}.`
        : `DevMate Gateway started on internal port ${gateway.port}.`);

      this.logRuntime(`Starting or attaching to shared ngrok tunnel for Gateway port ${gateway.port}.`);
      const tunnel = await this.ngrokRuntime.start(gateway.port);
      const publicUrl = tunnel?.publicUrl || tunnel?.record?.publicUrl || '';
      if (!publicUrl) throw new Error('ngrok did not publish a public HTTPS URL');
      this.logRuntime(tunnel.attached
        ? `Attached to shared ngrok endpoint: ${redactUrl(publicUrl)}`
        : `ngrok public endpoint ready: ${redactUrl(publicUrl)}`);

      const preflight = await this.verifyPublicEndpoint(publicUrl);
      this.runtimeDiagnostics?.clearFailure();
      if (this.settings.autoCopyUrl !== false) {
        await navigator.clipboard.writeText(preflight.mcpUrl);
      }
      if (!quiet) {
        new Notice(this.settings.autoCopyUrl !== false
          ? `DevMate ready. Verified public MCP URL copied: ${redactUrl(preflight.mcpUrl)}`
          : `DevMate ready: ${redactUrl(preflight.mcpUrl)}`);
      }
      return {
        ok: true,
        gateway,
        tunnel,
        publicUrl: preflight.publicOrigin,
        mcpUrl: preflight.mcpUrl,
        toolCount: preflight.toolCount,
        server: preflight.server
      };
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
    let tunnel = { stopped: false, reason: 'not-running' };
    let gateway = { stopped: false, reason: 'not-running' };
    try {
      try { tunnel = await this.ngrokRuntime?.stop() || tunnel; }
      catch (error) { this.logRuntime(`Could not stop ngrok cleanly: ${error.message || error}`); }
      gateway = await this.controller.stop();

      const sharedStillActive = tunnel.reason === 'managed-by-another-host' || gateway.reason === 'managed-by-another-host';
      if (!sharedStillActive) {
        this.clearPublicVerification();
        this.updateConnectionSnapshot({ publicUrl: '' });
      }
      this.runtimeDiagnostics?.clearFailure();
      if (sharedStillActive) {
        new Notice('This host stopped its owned processes; the shared DevMate runtime remains active under another host.');
      } else if (tunnel.stopped || gateway.stopped) {
        this.logRuntime('DevMate Gateway and ngrok public endpoint stopped by the user.');
        new Notice('DevMate stopped.');
      } else {
        new Notice('DevMate is not running.');
      }
      return { stopped: !sharedStillActive, gateway, tunnel };
    } catch (error) {
      new Notice(`DevMate stop failed: ${error.message || error}`);
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
      try { await this.ngrokRuntime?.stop(); } catch (error) {
        this.logRuntime(`ngrok stop before restart reported: ${error.message || error}`);
      }
      this.clearPublicVerification();
      this.logRuntime('Restarting DevMate Gateway and public ngrok endpoint.');
      const gateway = await this.controller.restart();
      const tunnel = await this.ngrokRuntime.start(gateway.port);
      const publicUrl = tunnel?.publicUrl || tunnel?.record?.publicUrl || '';
      const preflight = await this.verifyPublicEndpoint(publicUrl);
      this.runtimeDiagnostics?.clearFailure();
      if (this.settings.autoCopyUrl !== false) await navigator.clipboard.writeText(preflight.mcpUrl);
      new Notice(`DevMate restarted and public MCP verified: ${redactUrl(preflight.mcpUrl)}`);
      return { restarted: true, gateway, tunnel, publicUrl: preflight.publicOrigin, mcpUrl: preflight.mcpUrl };
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
      const tunnel = this.ngrokRuntime?.status(gateway.port);
      const publicUrl = tunnel?.publicUrl || '';
      if (!publicUrl) throw new Error('No ngrok public URL is active. Run DevMate: Start first.');
      const test = await this.verifyPublicEndpoint(publicUrl);
      await navigator.clipboard.writeText(test.mcpUrl);
      this.updateConnectionSnapshot({ lastCopiedAt: new Date().toISOString() });
      this.runtimeDiagnostics?.clearFailure();
      new Notice(`Verified public MCP URL copied: ${redactUrl(test.mcpUrl)}`);
    } catch (error) {
      this.runtimeDiagnostics?.recordFailure(error);
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

  async ngrokDoctor() {
    try {
      const command = String(this.settings.ngrokCommandPath || 'ngrok').trim() || 'ngrok';
      const managed = !!this.settings.ngrokAuthtokenEncrypted;
      const secrets = await this.ngrokRuntime?.secrets() || { ngrokAuthtoken: '' };
      const env = managed && secrets.ngrokAuthtoken
        ? { ...process.env, NGROK_AUTHTOKEN: secrets.ngrokAuthtoken }
        : process.env;
      const version = childProcess.spawnSync(command, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env });
      const configCheck = childProcess.spawnSync(command, ['config', 'check'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env });
      const versionText = String(version.stdout || version.stderr || version.error?.message || '').trim().split(/\r?\n/)[0];
      const configText = String(configCheck.stdout || configCheck.stderr || configCheck.error?.message || '').trim().split(/\r?\n/)[0];
      const ok = !version.error && version.status === 0 && !configCheck.error && configCheck.status === 0;
      this.logRuntime(`ngrok doctor: executable=${command}; version=${versionText || 'unavailable'}; account=${managed ? 'DevMate encrypted token' : 'global ngrok config'}; config=${configText || 'no output'}`);
      new Notice(ok ? `ngrok ready: ${versionText}` : `ngrok setup needs attention. ${configText || versionText || 'See DevMate diagnostics.'}`);
      return { ok, command, version: versionText, config: configText, managed };
    } catch (error) {
      this.logRuntime(`ngrok doctor failed: ${error.message || error}`);
      new Notice(`ngrok doctor failed: ${error.message || error}`);
      return { ok: false, error: error.message || String(error) };
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
