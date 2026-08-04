'use strict';

const { ItemView } = require('obsidian');

const VIEW_TYPE = 'devmate-obsidian';

class DevMateView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'DevMate'; }
  getIcon() { return 'bot'; }

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
    const action = (label, handler) => {
      const button = actions.createEl('button', { text: label });
      button.onclick = async () => {
        button.disabled = true;
        try { await handler(); }
        finally { button.disabled = false; await this.render(); }
      };
    };
    action('Start', () => this.plugin.startRuntime());
    action('Stop', () => this.plugin.stopRuntime());
    action('Restart', () => this.plugin.restartRuntime());
    action('Copy MCP URL', () => this.plugin.copyConnectionUrl());
    action('Copy context', () => this.plugin.copyContextBundle());

    const runtime = this.plugin.controller;
    container.createEl('h3', { text: 'Workspace' });
    const list = container.createEl('dl', { cls: 'devmate-details' });
    const detail = (name, value) => {
      list.createEl('dt', { text: name });
      list.createEl('dd', { text: String(value || 'Unavailable') });
    };
    detail('Vault', this.plugin.vaultRoot);
    detail('State', runtime?.stateDirectory);
    detail('Startup', this.plugin.settings.startupMode);

    const note = this.plugin.app.workspace.getActiveFile();
    container.createEl('h3', { text: 'Active note' });
    container.createEl('div', { text: note?.path || 'No active note', cls: 'devmate-note-path' });

    const index = this.plugin.bridge?.index;
    if (index) {
      container.createEl('h3', { text: 'Vault index' });
      const indexCard = container.createDiv({ cls: 'devmate-status-card' });
      indexCard.createEl('strong', { text: `${index.records.size} Markdown notes` });
      indexCard.createEl('div', {
        text: `Generation ${index.generation} · refreshed ${index.refreshedAt || 'not yet'}`,
        cls: 'devmate-muted'
      });
    }
  }
}

module.exports = {
  DevMateView,
  VIEW_TYPE
};
