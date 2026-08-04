'use strict';

const path = require('node:path');
const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
const { ObsidianHostBridge } = require('./host-bridge.js');
const { ObsidianContextProvider } = require('./context-provider.js');
const { DevMateSettingTab, normalizeSettings } = require('./settings.js');
const { DevMateView, VIEW_TYPE } = require('./view.js');
const {
  RuntimeController,
  migrateLegacyState,
  resolveStateDirectory
} = require('../../host/runtime-controller.js');

const HOST_ID = 'obsidian';

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
    this.vaultRoot = '';
    this.layoutReady = false;

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
    this.addCommand({ id: 'copy-context', name: 'Copy active vault context', callback: () => this.copyContextBundle() });

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
    this.registerInterval(window.setInterval(() => this.refreshStatus(), 5000));

    await this.reconfigureRuntime({ startBridge: true, capture: true });
    if (this.settings.enabled && this.settings.startupMode === 'auto') await this.startRuntime({ quiet: true });
    else await this.refreshStatus();
  }

  async onunload() {
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.contextTimer = null;
    this.reconfigureTimer = null;
    await this.bridge?.stop();
    this.bridge = null;
    await this.controller?.dispose({ stopOwned: this.settings.stopWhenObsidianCloses });
    this.controller = null;
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  pluginDirectory() {
    const relative = this.manifest.dir || path.join(this.app.vault.configDir, 'plugins', this.manifest.id);
    return path.join(this.vaultRoot, relative);
  }

  stateDirectory(pluginDirectory) {
    const legacyDirectory = path.join(pluginDirectory, 'state');
    const stateDirectory = resolveStateDirectory({
      workspaceRoot: this.vaultRoot,
      overrideDirectory: this.settings.sharedStateDirectory,
      legacyDirectory,
      shared: this.settings.sharedRuntime
    });
    if (this.settings.sharedRuntime) migrateLegacyState({ legacyDirectory, stateDirectory });
    return stateDirectory;
  }

  async reconfigureRuntime({ startBridge = this.layoutReady, capture = this.layoutReady } = {}) {
    await this.bridge?.stop();
    this.bridge = null;
    const pluginDirectory = this.pluginDirectory();
    const stateDirectory = this.stateDirectory(pluginDirectory);
    const sameState = this.controller && path.resolve(this.controller.stateDirectory) === path.resolve(stateDirectory);
    if (!sameState) {
      await this.controller?.dispose({ stopOwned: true });
      this.controller = new RuntimeController({
        workspaceRoot: this.vaultRoot,
        stateDirectory,
        gatewayEntry: path.join(pluginDirectory, 'gateway', 'server.mjs'),
        preferredPort: this.settings.preferredPort,
        appVersion: this.manifest.version,
        hostId: HOST_ID,
        logger: message => console.log(`[DevMate] ${message}`)
      });
    } else {
      this.controller.preferredPort = this.settings.preferredPort;
    }
    this.controller.ensureConfig();

    if (startBridge && this.settings.enabled && this.settings.startupMode !== 'disabled') {
      const bridge = new ObsidianHostBridge(this, this.controller);
      try {
        await bridge.start();
        this.bridge = bridge;
      } catch (error) {
        await bridge.stop().catch(() => {});
        console.error('[DevMate] Obsidian host bridge failed', error);
        new Notice(`DevMate host bridge failed: ${error.message || error}`);
      }
    }
    if (capture) await this.captureContext();
    await this.refreshStatus();
  }

  scheduleReconfigure() {
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.reconfigureTimer = window.setTimeout(() => {
      this.reconfigureTimer = null;
      this.reconfigureRuntime().catch(error => console.warn('[DevMate] Runtime reconfiguration failed', error));
    }, 500);
  }

  scheduleContextCapture() {
    if (!this.controller || !this.settings.enabled) return;
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    this.contextTimer = window.setTimeout(() => {
      this.contextTimer = null;
      this.captureContext().catch(error => console.warn('[DevMate] Context capture failed', error));
    }, 350);
  }

  async captureContext() {
    return this.contextProvider?.capture(this.controller);
  }

  async runtimeStatus() {
    if (!this.settings.enabled || this.settings.startupMode === 'disabled') {
      return { label: 'DevMate disabled', detail: 'Enable the Obsidian host in settings.', state: 'disabled' };
    }
    try {
      const status = await this.controller.status();
      if (status.state === 'running') {
        return {
          label: status.owned ? 'DevMate running' : 'DevMate attached',
          detail: `Gateway available on 127.0.0.1:${status.port}`,
          ...status
        };
      }
      if (status.state === 'foreign') {
        return { label: 'Port conflict', detail: `Another DevMate instance is using port ${status.port}.`, ...status };
      }
      return { label: 'DevMate stopped', detail: `Preferred port ${status.port}`, ...status };
    } catch (error) {
      return { label: 'DevMate error', detail: error.message || String(error), state: 'error' };
    }
  }

  async refreshStatus() {
    if (!this.statusBar || !this.controller) return;
    const status = await this.runtimeStatus();
    this.statusBar.setText(status.state === 'running' ? `DevMate: on :${status.port}` : status.label);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DevMateView) leaf.view.render();
    }
  }

  async startRuntime({ quiet = false } = {}) {
    if (!this.settings.enabled || this.settings.startupMode === 'disabled') {
      if (!quiet) new Notice('DevMate Obsidian host is disabled.');
      return;
    }
    try {
      if (!this.bridge && this.layoutReady) await this.reconfigureRuntime({ startBridge: true, capture: true });
      await this.captureContext();
      const result = await this.controller.start();
      if (!quiet) new Notice(result.attached ? 'Attached to the existing DevMate Gateway.' : 'DevMate Gateway started.');
    } catch (error) {
      console.error('[DevMate] Start failed', error);
      if (!quiet) new Notice(`DevMate start failed: ${error.message || error}`);
    } finally {
      await this.refreshStatus();
    }
  }

  async stopRuntime() {
    try {
      const result = await this.controller.stop();
      if (result.stopped) new Notice('DevMate Gateway stopped.');
      else if (result.reason === 'managed-by-another-host') new Notice('Gateway is managed by another host and was left running.');
      else new Notice('DevMate Gateway is not running.');
    } catch (error) {
      new Notice(`DevMate stop failed: ${error.message || error}`);
    } finally {
      await this.refreshStatus();
    }
  }

  async restartRuntime() {
    try {
      const result = await this.controller.restart();
      if (result.attached) new Notice('Gateway is managed by another host; kept the shared instance attached.');
      else new Notice('DevMate Gateway restarted.');
    } catch (error) {
      new Notice(`DevMate restart failed: ${error.message || error}`);
    } finally {
      await this.refreshStatus();
    }
  }

  async copyConnectionUrl() {
    try {
      const url = this.controller.ownerUrl(this.settings.publicOrigin);
      await navigator.clipboard.writeText(url);
      new Notice('DevMate MCP URL copied.');
    } catch (error) {
      new Notice(`Could not copy MCP URL: ${error.message || error}`);
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

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
