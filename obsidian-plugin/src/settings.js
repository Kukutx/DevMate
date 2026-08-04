'use strict';

const { PluginSettingTab, Setting } = require('obsidian');

const STARTUP_MODES = new Set(['auto', 'manual', 'disabled']);
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

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Public origin must be a clean HTTPS origin');
  }
  if (url.pathname && url.pathname !== '/') throw new Error('Public origin must not contain a path');
  return `${url.protocol}//${url.host}`;
}

function normalizeSettings(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const port = Number(input.preferredPort);
  let publicOrigin = '';
  try { publicOrigin = normalizeOrigin(input.publicOrigin); } catch {}
  return {
    enabled: input.enabled !== false,
    startupMode: STARTUP_MODES.has(input.startupMode) ? input.startupMode : DEFAULT_SETTINGS.startupMode,
    sharedRuntime: input.sharedRuntime !== false,
    sharedStateDirectory: String(input.sharedStateDirectory || '').trim(),
    preferredPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.preferredPort,
    stopWhenObsidianCloses: input.stopWhenObsidianCloses === true,
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
      .setDesc('Expose this vault and Obsidian context to DevMate.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async value => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureRuntime();
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
          this.plugin.scheduleReconfigure();
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
            this.plugin.scheduleReconfigure();
          }
        }));

    new Setting(containerEl)
      .setName('Public origin')
      .setDesc('Optional clean HTTPS origin managed outside Obsidian. It is used when copying the MCP URL.')
      .addText(text => text
        .setPlaceholder('https://devmate.example.com')
        .setValue(this.plugin.settings.publicOrigin)
        .onChange(async value => {
          try {
            this.plugin.settings.publicOrigin = normalizeOrigin(value);
            text.inputEl.removeClass('devmate-setting-invalid');
            await this.plugin.saveSettings();
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

module.exports = {
  DEFAULT_SETTINGS,
  DevMateSettingTab,
  STARTUP_MODES,
  normalizeOrigin,
  normalizeSettings
};
