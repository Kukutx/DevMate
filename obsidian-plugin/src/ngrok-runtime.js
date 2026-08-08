'use strict';

const { decryptSecret } = require('./secret-store.js');
const { TunnelController } = require('../../vscode-host/tunnel-controller.js');

const DEFAULT_ATTACHMENT_POLL_MS = 1000;

class ObsidianNgrokRuntime {
  constructor({
    plugin,
    stateDirectory,
    logger = () => {},
    childProcess = undefined,
    httpRequest = undefined,
    controllerOptions = {},
    attachmentPollMs = DEFAULT_ATTACHMENT_POLL_MS
  } = {}) {
    if (!plugin) throw new Error('Obsidian DevMate plugin is required');
    if (!stateDirectory) throw new Error('Shared DevMate state directory is required');
    this.plugin = plugin;
    this.stateDirectory = stateDirectory;
    this.logger = logger;
    this.attachmentPollMs = Math.max(50, Number(attachmentPollMs) || DEFAULT_ATTACHMENT_POLL_MS);
    this.attachmentTimer = null;
    this.attachmentPort = 0;
    this.recoveringAttachment = false;
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

  readyForeignRecord(port) {
    if (!this.controller) return null;
    const numericPort = Number(port);
    const existing = this.controller.store.read();
    if (
      existing &&
      existing.status === 'ready' &&
      existing.provider === 'ngrok' &&
      Number(existing.port) === numericPort &&
      existing.publicUrl &&
      existing.ownerId !== this.controller.ownerId
    ) return existing;
    return null;
  }

  stopAttachmentWatcher() {
    if (this.attachmentTimer) clearInterval(this.attachmentTimer);
    this.attachmentTimer = null;
    this.attachmentPort = 0;
    this.recoveringAttachment = false;
  }

  startAttachmentWatcher(port) {
    this.stopAttachmentWatcher();
    this.attachmentPort = Number(port) || 0;
    if (!this.attachmentPort || !this.controller) return;
    this.attachmentTimer = setInterval(() => {
      const current = this.controller;
      const targetPort = this.attachmentPort;
      if (!current || !targetPort || this.recoveringAttachment) return;
      try {
        if (this.readyForeignRecord(targetPort)) return;
        const localStatus = current.status(targetPort);
        if (localStatus.owned) {
          this.stopAttachmentWatcher();
          return;
        }
        if (localStatus.running) return;
      } catch (error) {
        // A stale configuration mismatch is irrelevant after the foreign owner is gone;
        // the recovery start below re-evaluates current settings under the startup lease.
        this.logger(`Obsidian ngrok attachment status changed: ${error.message || error}`);
      }
      this.recoveringAttachment = true;
      Promise.resolve(current.start(targetPort))
        .then(result => {
          if (this.controller !== current) return;
          if (result?.owned) {
            this.logger(`Obsidian took ownership of ngrok after the shared owner exited: ${result.publicUrl || 'starting'}.`);
            this.stopAttachmentWatcher();
          }
        })
        .catch(error => this.logger(`Obsidian ngrok follower recovery failed: ${error.message || error}`))
        .finally(() => { this.recoveringAttachment = false; });
    }, this.attachmentPollMs);
    this.attachmentTimer.unref?.();
  }

  async start(port) {
    if (!this.controller) throw new Error('Obsidian ngrok runtime is disposed');
    const numericPort = Number(port);
    const existing = this.readyForeignRecord(numericPort);
    if (existing) {
      this.logger(`Attached to existing shared ngrok endpoint owned by ${existing.hostId || 'another host'}.`);
      this.startAttachmentWatcher(numericPort);
      return {
        attached: true,
        owned: false,
        publicUrl: existing.publicUrl,
        record: existing
      };
    }
    const result = await this.controller.start(numericPort);
    if (result?.attached) this.startAttachmentWatcher(numericPort);
    else this.stopAttachmentWatcher();
    return result;
  }

  status(port) {
    if (!this.controller) return { running: false, owned: false, attached: false, publicUrl: '', provider: 'ngrok', port: Number(port) || 0, record: null };
    const numericPort = Number(port);
    const existing = this.readyForeignRecord(numericPort);
    if (existing) {
      return {
        running: true,
        owned: false,
        attached: true,
        publicUrl: existing.publicUrl,
        provider: 'ngrok',
        port: numericPort,
        record: existing
      };
    }
    return this.controller.status(numericPort);
  }

  async stop() {
    this.stopAttachmentWatcher();
    if (!this.controller) return { stopped: false, reason: 'not-running' };
    return this.controller.stop();
  }

  async dispose({ stopOwned = true } = {}) {
    this.stopAttachmentWatcher();
    const current = this.controller;
    this.controller = null;
    return current?.dispose({ stopOwned }) || { disposed: true };
  }
}

module.exports = {
  DEFAULT_ATTACHMENT_POLL_MS,
  ObsidianNgrokRuntime
};
