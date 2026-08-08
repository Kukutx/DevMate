'use strict';

const { decryptSecret } = require('./secret-store.js');
const { TunnelController } = require('../../vscode-host/tunnel-controller.js');
const {
  clearTunnelController,
  setTunnelController,
  startTunnel,
  stopTunnel,
  tunnelStatus
} = require('../../vscode-host/tunnel-runtime.js');

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
    setTunnelController(this.controller);
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
    return startTunnel(port);
  }

  status(port) {
    return tunnelStatus(port);
  }

  stop() {
    return stopTunnel();
  }

  async dispose({ stopOwned = true } = {}) {
    const current = this.controller;
    clearTunnelController(current);
    this.controller = null;
    return current?.dispose({ stopOwned }) || { disposed: true };
  }
}

module.exports = {
  ObsidianNgrokRuntime
};
