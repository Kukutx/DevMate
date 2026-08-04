'use strict';

const path = require('node:path');
const {
  FileSystemAdapter,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting
} = require('obsidian');
const { ObsidianHostBridge } = require('./host-bridge.js');
const {
  RuntimeController,
  migrateLegacyState,
  resolveStateDirectory
} = require('../../host/runtime-controller.js');

const VIEW_TYPE = 'devmate-obsidian';
const HOST_ID = 'obsidian';
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  startupMode: 'auto',
  sharedRuntime: true,
  sharedStateDirectory: '',
  preferredPort: 8787,
  stopWhenObsidianCloses: false,
  captureSelection: true,
  publicOrigin: ''
});

function clampText(value, max = 20000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function safeFrontmatter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'position') continue;
    output[key] = item;
  }
  return output;
}

class DevMateView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'DevMate';
  }

  getIcon() {
    return 'bot';
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('devmate-obsidian-panel');
    container.createEl('h2', { text: 'DevMate' });

    const status = await this.plugin.runtimeStatus();
    const statusCard = container.createDiv({ cls: 'devmate-status-card' });
    statusCard.createEl('strong', { text: status.label });
    statusCard.createEl('div', { text: status.detail, cls: 'devmate-muted' });

    const actions = container.createDiv({ cls: 'devmate-actions' });
    const start = actions.createEl('button', { text: 'Start' });
    start.onclick = async () => { await this.plugin.startRuntime(); await this.render(); };
    const stop = actions.createEl('button', { text: 'Stop' });
    stop.onclick = async () => { await this.plugin.stopRuntime(); await this.render(); };
    const restart = actions.createEl('button', { text: 'Restart' });
    restart.onclick = async () => { await this.plugin.restartRuntime(); await this.render(); };

    const copy = actions.createEl('button', { text: 'Copy MCP URL' });
    copy.onclick = () => this.plugin.copyConnectionUrl();
    const context = actions.createEl('button', { text: 'Copy context' });
    context.onclick = () => this.plugin.copyContextBundle();

    container.createEl('h3', { text: 'Workspace' });
    const runtime = this.plugin.controller;
    const list = container.createEl('dl', { cls: 'devmate-details' });
    list.createEl('dt', { text: 'Vault' });
    list.createEl('dd', { text: this.plugin.vaultRoot || 'Unavailable' });
    list.createEl('dt', { text: 'State' });
    list.createEl('dd', { text: runtime?.stateDirectory || 'Unavailable' });
    list.createEl('dt', { text: 'Startup' });
    list.createEl('dd', { text: this.plugin.settings.startupMode });

    const note = this.plugin.app.workspace.getActiveFile();
    container.createEl('h3', { text: 'Active note' });
    container.createEl('div', { text: note?.path || 'No active note', cls: 'devmate-note-path' });
  }
}

class DevMateSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'DevMate' });

    new Setting(containerEl)
      .setName('Enable Obsidian host')
      .setDesc('Expose this vault and Obsidian context to DevMate.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async value => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          if (value) await this.plugin.reconfigureRuntime();
          else await this.plugin.bridge?.stop();
          await this.plugin.refreshStatus();
        }));

    new Setting(containerEl)
      .setName('Startup mode')
      .setDesc('Auto starts DevMate after the Obsidian layout is ready. Manual keeps commands available without starting it.')
      .addDropdown(dropdown => dropdown
        .addOption('auto', 'Auto start')
        .addOption('manual', 'Manual start')
        .addOption('disabled', 'Disabled')
        .setValue(this.plugin.settings.startupMode)
        .onChange(async value => {
          this.plugin.settings.startupMode = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureRuntime();
        }));

    new Setting(containerEl)
      .setName('Use shared runtime state')
      .setDesc('Use the same workspace-derived state directory as the VS Code host so both applications attach to one Gateway.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.sharedRuntime)
        .onChange(async value => {
          this.plugin.settings.sharedRuntime = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureRuntime();
        }));

    new Setting(containerEl)
      .setName('Shared state directory override')
      .setDesc('Optional absolute directory. Leave empty to use ~/.devmate/hosts/<workspace-id>.')
      .addText(text => text
        .setPlaceholder('C:\\Users\\you\\.devmate\\hosts\\my-vault')
        .setValue(this.plugin.settings.sharedStateDirectory)
        .onChange(async value => {
          this.plugin.settings.sharedStateDirectory = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Preferred local port')
      .setDesc('DevMate searches this port and the next 19 ports when starting a new Gateway.')
      .addText(text => text
        .setValue(String(this.plugin.settings.preferredPort))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) {
            this.plugin.settings.preferredPort = parsed;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Public origin')
      .setDesc('Optional HTTPS origin managed outside Obsidian. It is used when copying the MCP URL.')
      .addText(text => text
        .setPlaceholder('https://devmate.example.com')
        .setValue(this.plugin.settings.publicOrigin)
        .onChange(async value => {
          this.plugin.settings.publicOrigin = value.trim().replace(/\/$/, '');
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Capture active selection')
      .setDesc('Include at most 20,000 selected characters in the current Obsidian host context.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.captureSelection)
        .onChange(async value => {
          this.plugin.settings.captureSelection = value;
          await this.plugin.saveSettings();
          this.plugin.scheduleContextCapture();
        }));

    new Setting(containerEl)
      .setName('Stop owned Gateway when Obsidian closes')
      .setDesc('Off by default so VS Code or another host can keep using the shared Gateway.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.stopWhenObsidianCloses)
        .onChange(async value => {
          this.plugin.settings.stopWhenObsidianCloses = value;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = class DevMateObsidianPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText('DevMate: loading');
    this.contextTimer = null;
    this.controller = null;
    this.bridge = null;
    this.vaultRoot = '';

    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      this.statusBar.setText('DevMate: desktop only');
      new Notice('DevMate requires the Obsidian desktop app and a filesystem-backed vault.');
      return;
    }

    this.vaultRoot = this.app.vault.adapter.getBasePath();
    await this.reconfigureRuntime();

    this.registerView(VIEW_TYPE, leaf => new DevMateView(leaf, this));
    this.addRibbonIcon('bot', 'Open DevMate', () => this.openView());
    this.addSettingTab(new DevMateSettingTab(this.app, this));

    this.addCommand({ id: 'start', name: 'Start', callback: () => this.startRuntime() });
    this.addCommand({ id: 'stop', name: 'Stop', callback: () => this.stopRuntime() });
    this.addCommand({ id: 'restart', name: 'Restart', callback: () => this.restartRuntime() });
    this.addCommand({ id: 'open', name: 'Open panel', callback: () => this.openView() });
    this.addCommand({ id: 'copy-url', name: 'Copy MCP URL', callback: () => this.copyConnectionUrl() });
    this.addCommand({ id: 'copy-context', name: 'Copy active vault context', callback: () => this.copyContextBundle() });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleContextCapture()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleContextCapture()));
    this.registerInterval(window.setInterval(() => this.refreshStatus(), 5000));

    this.app.workspace.onLayoutReady(async () => {
      await this.captureContext();
      if (this.settings.enabled && this.settings.startupMode === 'auto') await this.startRuntime({ quiet: true });
      else await this.refreshStatus();
    });
  }

  async onunload() {
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    this.contextTimer = null;
    await this.bridge?.stop();
    this.bridge = null;
    await this.controller?.dispose({ stopOwned: this.settings.stopWhenObsidianCloses });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  pluginDirectory() {
    const relative = this.manifest.dir || path.join(this.app.vault.configDir, 'plugins', this.manifest.id);
    return path.join(this.vaultRoot, relative);
  }

  async reconfigureRuntime() {
    await this.bridge?.stop();
    this.bridge = null;
    await this.controller?.dispose({ stopOwned: false });
    const pluginDirectory = this.pluginDirectory();
    const legacyDirectory = path.join(pluginDirectory, 'state');
    const stateDirectory = resolveStateDirectory({
      workspaceRoot: this.vaultRoot,
      overrideDirectory: this.settings.sharedStateDirectory,
      legacyDirectory,
      shared: this.settings.sharedRuntime
    });
    if (this.settings.sharedRuntime) migrateLegacyState({ legacyDirectory, stateDirectory });
    this.controller = new RuntimeController({
      workspaceRoot: this.vaultRoot,
      stateDirectory,
      gatewayEntry: path.join(pluginDirectory, 'gateway', 'server.mjs'),
      preferredPort: this.settings.preferredPort,
      appVersion: this.manifest.version,
      hostId: HOST_ID,
      logger: message => console.log(`[DevMate] ${message}`)
    });
    this.controller.ensureConfig();
    if (this.settings.enabled && this.settings.startupMode !== 'disabled') {
      this.bridge = new ObsidianHostBridge(this, this.controller);
      try { await this.bridge.start(); }
      catch (error) {
        this.bridge = null;
        console.error('[DevMate] Obsidian host bridge failed', error);
        new Notice(`DevMate host bridge failed: ${error.message || error}`);
      }
    }
    await this.captureContext();
    await this.refreshStatus();
  }

  scheduleContextCapture() {
    if (!this.controller || !this.settings.enabled) return;
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    this.contextTimer = window.setTimeout(() => {
      this.contextTimer = null;
      this.captureContext().catch(error => console.warn('[DevMate] Context capture failed', error));
    }, 350);
  }

  activeEditorContext() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return null;
    const editor = view.editor;
    return {
      path: view.file.path,
      mode: view.getMode?.() || 'source',
      cursor: editor?.getCursor?.() || null,
      selection: this.settings.captureSelection ? clampText(editor?.getSelection?.() || '') : '',
      lineCount: editor?.lineCount?.() || null
    };
  }

  vaultSummary() {
    const files = this.app.vault.getFiles();
    const markdown = files.filter(file => file.extension === 'md');
    const rootChildren = this.app.vault.getRoot().children || [];
    return {
      name: this.app.vault.getName(),
      root: this.vaultRoot,
      files: files.length,
      markdownFiles: markdown.length,
      attachments: files.length - markdown.length,
      topLevel: rootChildren.slice(0, 100).map(item => ({
        path: item.path,
        type: 'children' in item ? 'folder' : 'file'
      }))
    };
  }

  currentNoteContext() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const cache = this.app.metadataCache.getFileCache(file) || {};
    return {
      path: file.path,
      name: file.basename,
      extension: file.extension,
      createdAt: new Date(file.stat.ctime).toISOString(),
      modifiedAt: new Date(file.stat.mtime).toISOString(),
      size: file.stat.size,
      frontmatter: safeFrontmatter(cache.frontmatter),
      headings: (cache.headings || []).slice(0, 200).map(item => ({ heading: item.heading, level: item.level })),
      links: (cache.links || []).slice(0, 200).map(item => item.link),
      embeds: (cache.embeds || []).slice(0, 100).map(item => item.link),
      tags: (cache.tags || []).slice(0, 100).map(item => item.tag)
    };
  }

  async captureContext() {
    if (!this.controller || !this.settings.enabled) return;
    this.controller.updateHostContext({
      kind: 'knowledge-base',
      capturedAt: new Date().toISOString(),
      workspaceRoot: this.vaultRoot,
      vault: this.vaultSummary(),
      activeDocument: this.currentNoteContext(),
      editor: this.activeEditorContext()
    });
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
      const file = this.app.workspace.getActiveFile();
      const content = file ? clampText(await this.app.vault.cachedRead(file), 30000) : '';
      const payload = [
        '# DevMate Obsidian Context',
        `Generated: ${new Date().toISOString()}`,
        `Vault: ${this.app.vault.getName()}`,
        `Root: ${this.vaultRoot}`,
        '',
        '## Active document',
        '```json',
        JSON.stringify({ note: this.currentNoteContext(), editor: this.activeEditorContext() }, null, 2),
        '```',
        '',
        '## Content',
        '```markdown',
        content || '(no active note)',
        '```'
      ].join('\n');
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
