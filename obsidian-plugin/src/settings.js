'use strict';

const { Notice, PluginSettingTab, Setting } = require('obsidian');
const { normalizeNgrokUrl, validateAuthtoken } = require('../../ngrok-support.js');
const { normalizePublicOrigin } = require('../../host/public-mcp.js');
const { publicConnectionStability } = require('../../shared/connection-stability.cjs');
const { PROVIDERS, tunnelMaxRestarts, tunnelProvider } = require('../../vscode-host/tunnel-settings.js');
const { cloudflaredInstallCommand, installCloudflared } = require('../../vscode-host/tunnel-executable.js');
const { encryptSecret, encryptionAvailable } = require('./secret-store.js');

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  autoStart: true,
  sharedStateDirectory: '',
  preferredPort: 8787,
  nodeExecutable: '',
  captureSelection: true,
  autoCopyUrl: true,
  authenticationMode: 'oauth',
  ngrokCommandPath: '',
  ngrokPoolingEnabled: false,
  tunnelAutoRestart: true,
  tunnelMaxRestarts: 10,
  cloudflareCommandPath: '',
  ngrokAuthtokenEncrypted: '',
  cloudflareTunnelTokenEncrypted: ''
});

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return normalizePublicOrigin(text);
}

function normalizeSettings(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const port = Number(input.preferredPort);
  return {
    enabled: input.enabled !== false,
    autoStart: input.autoStart !== false,
    sharedStateDirectory: String(input.sharedStateDirectory || '').trim(),
    preferredPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.preferredPort,
    nodeExecutable: String(input.nodeExecutable || '').trim(),
    captureSelection: input.captureSelection !== false,
    autoCopyUrl: input.autoCopyUrl !== false,
    authenticationMode: input.authenticationMode === 'none' ? 'none' : 'oauth',
    ngrokCommandPath: String(input.ngrokCommandPath || '').trim(),
    ngrokPoolingEnabled: input.ngrokPoolingEnabled === true,
    tunnelAutoRestart: input.tunnelAutoRestart !== false,
    tunnelMaxRestarts: tunnelMaxRestarts(input.tunnelMaxRestarts),
    cloudflareCommandPath: String(input.cloudflareCommandPath || '').trim(),
    ngrokAuthtokenEncrypted: String(input.ngrokAuthtokenEncrypted || '').trim(),
    cloudflareTunnelTokenEncrypted: String(input.cloudflareTunnelTokenEncrypted || '').trim()
  };
}

function tokenSetting(containerEl, plugin, {
  title,
  description,
  settingKey,
  placeholder,
  validate = value => String(value || '').trim()
}) {
  const configured = !!plugin.settings[settingKey];
  const row = new Setting(containerEl)
    .setName(title)
    .setDesc(configured
      ? `${description} A credential is configured and encrypted with the OS-backed Electron safe storage API.`
      : `${description} Leave empty to use the provider's normal machine configuration when supported.`);
  row.addText(text => {
    text.inputEl.type = 'password';
    text.setPlaceholder(configured ? 'Credential configured' : placeholder);
    text.onChange(async value => {
      const raw = String(value || '').trim();
      if (!raw) return;
      try {
        const secret = validate(raw);
        if (!encryptionAvailable()) throw new Error('OS-backed encryption is unavailable in this Obsidian environment.');
        plugin.settings[settingKey] = encryptSecret(secret);
        await plugin.saveSettings();
        text.inputEl.value = '';
        new Notice(`${title} saved securely.`);
        plugin.invalidateTunnelSecrets();
        plugin.scheduleReconfigure();
        this?.display?.();
      } catch (error) {
        new Notice(`Could not save ${title}: ${error.message || error}`);
      }
    });
    return text;
  });
  row.addButton(button => button
    .setButtonText('Clear')
    .setDisabled(!configured)
    .onClick(async () => {
      plugin.settings[settingKey] = '';
      await plugin.saveSettings();
      plugin.invalidateTunnelSecrets();
      plugin.scheduleReconfigure();
      new Notice(`${title} cleared.`);
    }));
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
      .setName('Enable DevMate')
      .setDesc('Expose this vault and Obsidian context through the shared DevMate instance.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async value => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.reconfigureRuntime();
        }));

    new Setting(containerEl)
      .setName('Start automatically')
      .setDesc('When enabled, opening Obsidian brings the complete DevMate connection to Ready automatically.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoStart)
        .onChange(async value => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        }));

    const connection = this.plugin.connectionConfiguration();
    const provider = tunnelProvider(connection.provider || 'ngrok');
    const stability = publicConnectionStability({ provider, publicUrl: connection.publicUrl || '' });

    new Setting(containerEl)
      .setName('Connection provider')
      .setDesc('The shared HTTPS provider used by this DevMate instance. ngrok is the default persistent ChatGPT connection; Cloudflare and external ingress are optional.')
      .addDropdown(dropdown => {
        for (const value of PROVIDERS) dropdown.addOption(value, value);
        return dropdown
          .setValue(provider)
          .onChange(async value => {
            await this.plugin.configureConnection({ provider: value });
            this.display();
          });
      });

    if (provider !== 'cloudflare-quick') {
      new Setting(containerEl)
        .setName(provider === 'ngrok' ? 'Stable ngrok URL' : 'Public HTTPS URL')
        .setDesc(provider === 'external'
          ? 'Required HTTPS origin for the external ingress.'
          : 'Required for a persistent ChatGPT app. Leave empty only when the provider publishes a session-only endpoint.')
        .addText(text => text
          .setPlaceholder('https://devmate.example.com')
          .setValue(connection.publicUrl || '')
          .onChange(async value => {
            const raw = String(value || '').trim();
            try {
              const normalized = raw
                ? provider === 'ngrok' ? normalizeNgrokUrl(raw) : normalizeOrigin(raw)
                : '';
              text.inputEl.removeClass('devmate-setting-invalid');
              await this.plugin.configureConnection({ publicUrl: normalized });
            } catch {
              text.inputEl.addClass('devmate-setting-invalid');
            }
          }));
    }

    new Setting(containerEl)
      .setName('ChatGPT app address')
      .setDesc(stability.message);

    new Setting(containerEl)
      .setName('MCP authentication')
      .setDesc('None is the direct private-use default. Choose OAuth only when sharing or publishing this DevMate app.')
      .addDropdown(dropdown => dropdown
        .addOption('none', 'None (default)')
        .addOption('oauth', 'OAuth (shared or published app)')
        .setValue(this.plugin.settings.authenticationMode)
        .onChange(async value => {
          this.plugin.settings.authenticationMode = value === 'oauth' ? 'oauth' : 'none';
          await this.plugin.saveSettings();
          this.plugin.scheduleReconfigure();
        }));

    if (provider === 'ngrok') {
      new Setting(containerEl)
        .setName('ngrok executable')
        .setDesc('Optional ngrok executable path. Leave empty to use ngrok from PATH.')
        .addText(text => text
          .setPlaceholder('ngrok')
          .setValue(this.plugin.settings.ngrokCommandPath)
          .onChange(async value => {
            this.plugin.settings.ngrokCommandPath = String(value || '').trim();
            await this.plugin.saveSettings();
            this.plugin.scheduleReconfigure();
          }));

      tokenSetting(containerEl, this.plugin, {
        title: 'ngrok Authtoken',
        description: 'Optional DevMate-managed credential.',
        settingKey: 'ngrokAuthtokenEncrypted',
        placeholder: 'Paste ngrok Authtoken',
        validate: validateAuthtoken
      });

      new Setting(containerEl)
        .setName('ngrok endpoint pooling')
        .setDesc('Off by default. Enable only when intentionally pooling the same endpoint across trusted agents.')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.ngrokPoolingEnabled)
          .onChange(async value => {
            this.plugin.settings.ngrokPoolingEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.scheduleReconfigure();
          }));
    }

    if (provider === 'cloudflare-quick' || provider === 'cloudflare-managed') {
      new Setting(containerEl)
        .setName('cloudflared executable')
        .setDesc('Optional cloudflared executable path. Leave empty to use cloudflared from PATH.')
        .addText(text => text
          .setPlaceholder('cloudflared')
          .setValue(this.plugin.settings.cloudflareCommandPath)
          .onChange(async value => {
            this.plugin.settings.cloudflareCommandPath = String(value || '').trim();
            await this.plugin.saveSettings();
            this.plugin.scheduleReconfigure();
          }));

      const installer = cloudflaredInstallCommand();
      const install = new Setting(containerEl)
        .setName('cloudflared helper')
        .setDesc(installer
          ? `Install or repair cloudflared automatically with ${installer.label}.`
          : 'Install cloudflared once, then DevMate finds it automatically.');
      if (installer) install.addButton(button => button
        .setButtonText('Install automatically')
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await installCloudflared();
            new Notice(result.ok ? 'cloudflared is installed. DevMate will use it automatically.' : 'cloudflared installation failed. Open the install guide for details.');
            if (result.ok) this.plugin.scheduleReconfigure();
          } finally {
            button.setDisabled(false);
          }
        }));
      install.addExtraButton(button => button
        .setIcon('external-link')
        .setTooltip('Open cloudflared install guide')
        .onClick(() => window.open('https://developers.cloudflare.com/tunnel/setup/')));
    }

    if (provider === 'cloudflare-managed') {
      tokenSetting(containerEl, this.plugin, {
        title: 'Cloudflare tunnel token',
        description: 'Credential for the configured managed Cloudflare tunnel.',
        settingKey: 'cloudflareTunnelTokenEncrypted',
        placeholder: 'Paste Cloudflare tunnel token'
      });
    }

    new Setting(containerEl)
      .setName('Restart connection after unexpected exit')
      .setDesc('Keep the ChatGPT-facing HTTPS connection alive after an unexpected provider exit.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.tunnelAutoRestart)
        .onChange(async value => {
          this.plugin.settings.tunnelAutoRestart = value;
          await this.plugin.saveSettings();
          this.plugin.scheduleReconfigure();
        }));

    new Setting(containerEl)
      .setName('Maximum connection restarts')
      .setDesc('Maximum automatic provider restarts after unexpected exits (0–100).')
      .addText(text => text
        .setValue(String(this.plugin.settings.tunnelMaxRestarts))
        .onChange(async value => {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
            this.plugin.settings.tunnelMaxRestarts = parsed;
            await this.plugin.saveSettings();
            this.plugin.scheduleReconfigure();
          }
        }));

    new Setting(containerEl)
      .setName('Shared state directory override')
      .setDesc('Optional absolute directory. Leave empty to use the machine-wide ~/.devmate/desktop instance shared with VS Code.')
      .addText(text => text
        .setPlaceholder('C:\\Users\\you\\.devmate\\desktop')
        .setValue(this.plugin.settings.sharedStateDirectory)
        .onChange(async value => {
          this.plugin.settings.sharedStateDirectory = value.trim();
          await this.plugin.saveSettings();
          this.plugin.scheduleReconfigure();
        }));

    new Setting(containerEl)
      .setName('Preferred local Gateway port')
      .setDesc('Internal loopback port. DevMate chooses another free port automatically when needed.')
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
      .setDesc('Optional Node.js 24+ executable override. Leave empty to auto-detect a usable runtime.')
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
      .setName('Copy verified MCP URL after Start')
      .setDesc('Copy the MCP URL only after DevMate has completed initialize and tools/list successfully.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoCopyUrl)
        .onChange(async value => {
          this.plugin.settings.autoCopyUrl = value;
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
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  DevMateSettingTab,
  normalizeOrigin,
  normalizeSettings
};
