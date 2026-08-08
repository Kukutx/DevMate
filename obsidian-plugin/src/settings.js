'use strict';

const { Notice, PluginSettingTab, Setting } = require('obsidian');
const { normalizeNgrokUrl, validateAuthtoken } = require('../../ngrok-support.js');
const { encryptSecret, encryptionAvailable } = require('./secret-store.js');

const STARTUP_MODES = new Set(['auto', 'manual', 'disabled']);
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  startupMode: 'auto',
  sharedStateDirectory: '',
  preferredPort: 8787,
  nodeExecutable: '',
  captureSelection: true,
  autoCopyUrl: true,
  ngrokCommandPath: '',
  ngrokUrl: '',
  ngrokPoolingEnabled: false,
  tunnelAutoRestart: true,
  tunnelMaxRestarts: 10,
  ngrokAuthtokenEncrypted: ''
});

function boundedRestarts(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 100
    ? numeric
    : DEFAULT_SETTINGS.tunnelMaxRestarts;
}

function normalizedNgrokUrl(value) {
  try { return normalizeNgrokUrl(value); }
  catch { return ''; }
}

function normalizeSettings(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const port = Number(input.preferredPort);
  return {
    enabled: input.enabled !== false,
    startupMode: STARTUP_MODES.has(input.startupMode) ? input.startupMode : DEFAULT_SETTINGS.startupMode,
    sharedStateDirectory: String(input.sharedStateDirectory || '').trim(),
    preferredPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.preferredPort,
    nodeExecutable: String(input.nodeExecutable || '').trim(),
    captureSelection: input.captureSelection !== false,
    autoCopyUrl: input.autoCopyUrl !== false,
    ngrokCommandPath: String(input.ngrokCommandPath || '').trim(),
    ngrokUrl: normalizedNgrokUrl(input.ngrokUrl),
    ngrokPoolingEnabled: input.ngrokPoolingEnabled === true,
    tunnelAutoRestart: input.tunnelAutoRestart !== false,
    tunnelMaxRestarts: boundedRestarts(input.tunnelMaxRestarts),
    ngrokAuthtokenEncrypted: String(input.ngrokAuthtokenEncrypted || '').trim()
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
      .setDesc('Expose this vault through the DevMate Gateway and verified ngrok MCP endpoint.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async value => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureRuntime();
        }));

    new Setting(containerEl)
      .setName('Startup mode')
      .setDesc('Auto starts the Gateway, ngrok tunnel, and public MCP verification after the Obsidian layout is ready.')
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
      .setName('Copy verified MCP URL after Start')
      .setDesc('When enabled, Start copies the public ngrok /mcp URL only after initialize and tools/list both succeed.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoCopyUrl)
        .onChange(async value => {
          this.plugin.settings.autoCopyUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Shared state directory override')
      .setDesc('Optional absolute directory. Leave empty to use ~/.devmate/hosts/<workspace-id> and share Gateway/tunnel ownership with VS Code for the same root.')
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
      .setDesc('Internal loopback port only. The ChatGPT-facing address is the verified ngrok HTTPS MCP URL.')
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
      .setName('ngrok executable')
      .setDesc('Optional ngrok executable path. Leave empty to use ngrok from PATH.')
      .addText(text => text
        .setPlaceholder('ngrok')
        .setValue(this.plugin.settings.ngrokCommandPath)
        .onChange(async value => {
          this.plugin.settings.ngrokCommandPath = value.trim();
          await this.plugin.saveSettings();
        }));

    const tokenSetting = new Setting(containerEl)
      .setName('ngrok Authtoken')
      .setDesc(this.plugin.settings.ngrokAuthtokenEncrypted
        ? 'A DevMate-managed ngrok token is configured and encrypted with the OS-backed Electron safe storage API.'
        : 'Optional. If empty, DevMate uses your normal ngrok global configuration. A pasted token is encrypted before it is saved.');
    tokenSetting.addText(text => {
      text.inputEl.type = 'password';
      text.setPlaceholder(this.plugin.settings.ngrokAuthtokenEncrypted ? 'Managed token configured' : 'Paste ngrok Authtoken');
      text.onChange(async value => {
        const token = String(value || '').trim();
        if (!token) return;
        try {
          validateAuthtoken(token);
          if (!encryptionAvailable()) throw new Error('OS-backed encryption is unavailable; use the normal ngrok global configuration instead.');
          this.plugin.settings.ngrokAuthtokenEncrypted = encryptSecret(token);
          await this.plugin.saveSettings();
          text.inputEl.value = '';
          new Notice('DevMate saved the ngrok Authtoken using OS-backed encryption.');
          this.display();
        } catch (error) {
          new Notice(`Could not save ngrok Authtoken: ${error.message || error}`);
        }
      });
      return text;
    });
    tokenSetting.addButton(button => button
      .setButtonText('Clear managed token')
      .setDisabled(!this.plugin.settings.ngrokAuthtokenEncrypted)
      .onClick(async () => {
        this.plugin.settings.ngrokAuthtokenEncrypted = '';
        await this.plugin.saveSettings();
        new Notice('DevMate managed ngrok token cleared; global ngrok configuration will be used.');
        this.display();
      }));

    new Setting(containerEl)
      .setName('Stable ngrok URL')
      .setDesc('Optional ngrok URL/hostname owned by the configured account. Leave empty to use the account default development endpoint.')
      .addText(text => text
        .setPlaceholder('https://your-name.ngrok-free.app')
        .setValue(this.plugin.settings.ngrokUrl)
        .onChange(async value => {
          const raw = String(value || '').trim();
          try {
            this.plugin.settings.ngrokUrl = raw ? normalizeNgrokUrl(raw) : '';
            text.inputEl.removeClass('devmate-setting-invalid');
            await this.plugin.saveSettings();
          } catch {
            text.inputEl.addClass('devmate-setting-invalid');
          }
        }));

    new Setting(containerEl)
      .setName('ngrok endpoint pooling')
      .setDesc('Off by default. Enable only when intentionally sharing one stable ngrok endpoint across multiple agents.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.ngrokPoolingEnabled)
        .onChange(async value => {
          this.plugin.settings.ngrokPoolingEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Restart ngrok after unexpected exit')
      .setDesc('Keep the ChatGPT-facing MCP endpoint alive when the managed ngrok process exits unexpectedly.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.tunnelAutoRestart)
        .onChange(async value => {
          this.plugin.settings.tunnelAutoRestart = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Maximum ngrok restarts')
      .setDesc('Maximum automatic restarts after unexpected tunnel exits (0–100).')
      .addText(text => text
        .setValue(String(this.plugin.settings.tunnelMaxRestarts))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
            this.plugin.settings.tunnelMaxRestarts = parsed;
            await this.plugin.saveSettings();
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
  boundedRestarts,
  normalizeSettings
};
