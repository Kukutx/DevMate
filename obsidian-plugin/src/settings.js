'use strict';

const { PluginSettingTab, Setting } = require('obsidian');
const { normalizePublicOrigin } = require('../../host/public-mcp.js');

const STARTUP_MODES = new Set(['auto', 'manual', 'disabled']);
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  startupMode: 'auto',
  sharedStateDirectory: '',
  preferredPort: 8787,
  nodeExecutable: '',
  captureSelection: true,
  publicOrigin: ''
});

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return normalizePublicOrigin(text);
}

function normalizeSettings(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const port = Number(input.preferredPort);
  let publicOrigin = '';
  try { publicOrigin = normalizeOrigin(input.publicOrigin); } catch {}
  return {
    enabled: input.enabled !== false,
    startupMode: STARTUP_MODES.has(input.startupMode) ? input.startupMode : DEFAULT_SETTINGS.startupMode,
    sharedStateDirectory: String(input.sharedStateDirectory || '').trim(),
    preferredPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.preferredPort,
    nodeExecutable: String(input.nodeExecutable || '').trim(),
    captureSelection: input.captureSelection !== false,
    publicOrigin
  };
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
      .setDesc('Expose this vault and Obsidian context through the shared DevMate Gateway.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async value => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureRuntime();
        }));

    new Setting(containerEl)
      .setName('Startup mode')
      .setDesc('Auto starts or attaches the shared Gateway after the Obsidian layout is ready. Public ingress remains independently managed.')
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
      .setName('Shared state directory override')
      .setDesc('Optional absolute directory. Leave empty to use ~/.devmate/hosts/<workspace-id> and share Gateway state with VS Code for the same root.')
      .addText(text => text
        .setPlaceholder('C:\\Users\\you\\.devmate\\hosts\\my-vault')
        .setValue(this.plugin.settings.sharedStateDirectory)
        .onChange(async value => {
          this.plugin.settings.sharedStateDirectory = value.trim();
          await this.plugin.saveSettings();
          this.plugin.scheduleReconfigure();
        }));

    new Setting(containerEl)
      .setName('Preferred local Gateway port')
      .setDesc('Internal loopback port only. ChatGPT must use a separately managed or shared verified HTTPS endpoint.')
      .addText(text => text
        .setValue(String(this.plugin.settings.preferredPort))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) {
            this.plugin.settings.preferredPort = parsed;
            await this.plugin.saveSettings();
            this.plugin.scheduleReconfigure();
          }
        }));

    new Setting(containerEl)
      .setName('Node.js executable')
      .setDesc('Optional Node.js 24+ executable for the isolated Gateway process. Leave empty to auto-detect a usable runtime.')
      .addText(text => text
        .setPlaceholder('C:\\Program Files\\nodejs\\node.exe')
        .setValue(this.plugin.settings.nodeExecutable)
        .onChange(async value => {
          this.plugin.settings.nodeExecutable = value.trim();
          await this.plugin.saveSettings();
          this.plugin.invalidateNodeRuntime();
          this.plugin.scheduleReconfigure();
        }));

    new Setting(containerEl)
      .setName('Public origin')
      .setDesc('Optional clean HTTPS origin managed outside Obsidian. When set, it is the explicit endpoint used for MCP verification; otherwise DevMate discovers the active shared tunnel or shared deployment URL.')
      .addText(text => text
        .setPlaceholder('https://devmate.example.com')
        .setValue(this.plugin.settings.publicOrigin)
        .onChange(async value => {
          const raw = String(value || '').trim();
          try {
            this.plugin.settings.publicOrigin = raw ? normalizeOrigin(raw) : '';
            text.inputEl.removeClass('devmate-setting-invalid');
            await this.plugin.saveSettings();
            await this.plugin.refreshStatus();
          } catch {
            text.inputEl.addClass('devmate-setting-invalid');
          }
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
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  DevMateSettingTab,
  STARTUP_MODES,
  normalizeOrigin,
  normalizeSettings
};
