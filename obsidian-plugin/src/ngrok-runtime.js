'use strict';

const { decryptSecret } = require('./secret-store.js');
const { TunnelController } = require('../../vscode-host/tunnel-controller.js');

class ObsidianNgrokRuntime {
  constructor({
    plugin,
    stateDirectory,
    logger = () => {},
    childProcess = undefined,
    httpRequest = undefined,
    controllerOptions = {}
  } = {}) {
    if (!plugin) throw new Error('Obsidian DevMate plugin is required');
    if (!stateDirectory) throw new Error('Shared DevMate state directory is required');
    this.plugin = plugin;
    this.stateDirectory = stateDirectory;
    this.logger = logger;
    this.controller = new TunnelController({
      stateDirectory,
      settings: () => this.settings(),
      getSecrets: () => this.secrets(),
      hostId: `obsidian-${process.pid}`,
      logger,
      ...(childProcess ? { childProcess } : {}),
      ...(httpRequest ? { httpRequest } : {}),
      ...controllerOptions
    });
  }

  settings() {
    const settings = this.plugin.settings || {};
    const deploymentMode = this.plugin.controller?.readConfig?.()?.deployment?.mode || 'personal';
    return {
      provider: 'ngrok',
      publicUrl: '',
      ngrokUrl: settings.ngrokUrl || '',
      ngrokCommandPath: settings.ngrokCommandPath || '',
      ngrokUseManagedAccount: !!settings.ngrokAuthtokenEncrypted,
      ngrokPoolingEnabled: settings.ngrokPoolingEnabled === true,
      ngrokTrafficPolicyFile: '',
      cloudflareCommandPath: '',
      autoRestart: settings.tunnelAutoRestart !== false,
      maxRestarts: Number.isInteger(settings.tunnelMaxRestarts) ? settings.tunnelMaxRestarts : 10,
      deploymentMode
    };
  }

  async secrets() {
    const encrypted = String(this.plugin.settings?.ngrokAuthtokenEncrypted || '').trim();
    return {
      ngrokAuthtoken: encrypted ? decryptSecret(encrypted) : '',
      cloudflareTunnelToken: ''
    };
  }

  start(port) {
    if (!this.controller) throw new Error('Obsidian ngrok runtime is disposed');
    return this.controller.start(port);
  }

  status(port) {
    if (!this.controller) return { running: false, owned: false, attached: false, publicUrl: '', provider: 'ngrok', port: Number(port) || 0, record: null };
    return this.controller.status(port);
  }

  stop() {
    if (!this.controller) return Promise.resolve({ stopped: false, reason: 'not-running' });
    return this.controller.stop();
  }

  async dispose({ stopOwned = true } = {}) {
    const current = this.controller;
    this.controller = null;
    return current?.dispose({ stopOwned }) || { disposed: true };
  }
}

module.exports = {
  ObsidianNgrokRuntime
};
