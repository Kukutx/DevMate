'use strict';

const { ItemView } = require('obsidian');

const VIEW_TYPE = 'devmate-obsidian';

function setText(element, value) {
  if (!element) return;
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}

function setVisible(element, visible) {
  if (!element) return;
  const display = visible ? '' : 'none';
  if (element.style.display !== display) element.style.display = display;
}

class DevMateView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.ui = null;
    this.refreshGeneration = 0;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'DevMate'; }
  getIcon() { return 'bot'; }

  async onOpen() {
    this.build();
    await this.refresh();
  }

  async onClose() {
    this.refreshGeneration += 1;
    this.ui = null;
  }

  build() {
    if (this.ui) return;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('devmate-obsidian-panel');
    container.createEl('h2', { text: 'DevMate' });

    const statusCard = container.createDiv({ cls: 'devmate-status-card' });
    const statusLabel = statusCard.createEl('strong');
    const statusDetail = statusCard.createEl('div', { cls: 'devmate-muted' });

    const actions = container.createDiv({ cls: 'devmate-actions' });
    const action = (label, handler) => {
      const button = actions.createEl('button', { text: label });
      button.onclick = async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await handler(); }
        finally { button.disabled = false; }
      };
      return button;
    };
    action('Start', () => this.plugin.startRuntime());
    action('Stop', () => this.plugin.stopRuntime());
    action('Restart', () => this.plugin.restartRuntime());
    action('Copy MCP URL', () => this.plugin.copyConnectionUrl());
    action('Copy Bearer Token', () => this.plugin.copyConnectionToken());
    action('Copy context', () => this.plugin.copyContextBundle());
    action('Copy diagnostics', () => this.plugin.copyDiagnostics());

    container.createEl('h3', { text: 'Connection' });
    const connectionList = container.createEl('dl', { cls: 'devmate-details' });
    const connectionDetail = name => {
      connectionList.createEl('dt', { text: name });
      return connectionList.createEl('dd');
    };
    const publicMcp = connectionDetail('Public MCP');
    const publicIngress = connectionDetail('Public ingress');
    const internalGateway = connectionDetail('Internal Gateway');
    const verification = connectionDetail('Verification');

    container.createEl('h3', { text: 'Workspace' });
    const list = container.createEl('dl', { cls: 'devmate-details' });
    const detail = name => {
      list.createEl('dt', { text: name });
      return list.createEl('dd');
    };
    const vault = detail('Vault');
    const state = detail('State');
    const startup = detail('Startup');
    const gatewayRuntime = detail('Gateway runtime');
    const nodeRuntime = detail('Node runtime');

    const failureSection = container.createDiv();
    failureSection.createEl('h3', { text: 'Startup problem' });
    const failureCard = failureSection.createDiv({ cls: 'devmate-status-card' });
    const failureMessage = failureCard.createEl('strong');
    failureCard.createEl('div', {
      text: 'Use Copy diagnostics when reporting this problem. Note content and bearer tokens are not included.',
      cls: 'devmate-muted'
    });

    container.createEl('h3', { text: 'Active note' });
    const activeNote = container.createEl('div', { cls: 'devmate-note-path' });

    const indexSection = container.createDiv();
    indexSection.createEl('h3', { text: 'Vault index' });
    const indexCard = indexSection.createDiv({ cls: 'devmate-status-card' });
    const indexCount = indexCard.createEl('strong');
    const indexDetail = indexCard.createEl('div', { cls: 'devmate-muted' });

    this.ui = {
      statusLabel,
      statusDetail,
      publicMcp,
      publicIngress,
      internalGateway,
      verification,
      vault,
      state,
      startup,
      gatewayRuntime,
      nodeRuntime,
      failureSection,
      failureMessage,
      activeNote,
      indexSection,
      indexCount,
      indexDetail
    };
    setVisible(failureSection, false);
    setVisible(indexSection, false);
  }

  async refresh(status = null) {
    this.build();
    const generation = ++this.refreshGeneration;
    const resolvedStatus = status || await this.plugin.runtimeStatus();
    if (generation !== this.refreshGeneration || !this.ui) return;

    const runtime = this.plugin.controller;
    const failure = this.plugin.runtimeDiagnostics?.lastFailure;
    const note = this.plugin.app.workspace.getActiveFile();
    const index = this.plugin.bridge?.index;
    const node = this.plugin.nodeRuntime;
    const gateway = resolvedStatus.gateway || {};
    const connection = resolvedStatus.connection || null;
    const publicMcp = connection?.publicOrigin
      ? `${String(connection.publicOrigin).replace(/\/$/, '')}/mcp`
      : 'Not available';

    setText(this.ui.statusLabel, resolvedStatus.label);
    setText(this.ui.statusDetail, resolvedStatus.detail);
    setText(this.ui.publicMcp, publicMcp);
    setText(this.ui.publicIngress,
      resolvedStatus.connectionError
        ? `State error · ${resolvedStatus.connectionError}`
        : connection
          ? connection.source === 'shared-tunnel'
            ? `${connection.provider || 'tunnel'} · shared from ${connection.ownerHostId || 'another host'}`
            : connection.source === 'obsidian-setting'
              ? 'External · Obsidian Public origin'
              : `${connection.provider || 'external'} · shared deployment config`
          : 'Not configured or active');
    setText(this.ui.internalGateway,
      gateway.state === 'running' || resolvedStatus.port
        ? `127.0.0.1:${gateway.port || resolvedStatus.port || this.plugin.settings.preferredPort} · internal only`
        : 'Not running');
    setText(this.ui.verification,
      resolvedStatus.verified
        ? `${this.plugin.lastVerifiedAt || 'verified'} · ${this.plugin.lastVerifiedToolCount || 0} tools`
        : connection?.publicOrigin ? 'Pending public MCP verification' : 'No public endpoint to verify');

    setText(this.ui.vault, this.plugin.vaultRoot || 'Unavailable');
    setText(this.ui.state, runtime?.stateDirectory || 'Unavailable');
    setText(this.ui.startup, this.plugin.settings.startupMode);
    setText(this.ui.gatewayRuntime, runtime?.lastLaunch?.mode || 'child_process');
    setText(this.ui.nodeRuntime, node ? `${node.nodeVersion} · ${node.executable}` : 'Auto-detect on start');

    setVisible(this.ui.failureSection, !!failure);
    if (failure) setText(this.ui.failureMessage, failure.message);

    setText(this.ui.activeNote, note?.path || 'No active note');

    setVisible(this.ui.indexSection, !!index);
    if (index) {
      setText(this.ui.indexCount, `${index.records.size} Markdown notes`);
      setText(this.ui.indexDetail, `Generation ${index.generation} · refreshed ${index.refreshedAt || 'not yet'}`);
    }
  }

  render(status = null) {
    return this.refresh(status);
  }
}

module.exports = {
  DevMateView,
  VIEW_TYPE,
  setText,
  setVisible
};
