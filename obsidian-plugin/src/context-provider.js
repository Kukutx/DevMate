'use strict';

const { getAllTags, MarkdownView } = require('obsidian');
const { safeFrontmatter } = require('./bridge/vault-index-core.js');

function clampText(value, max = 20000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

class ObsidianContextProvider {
  constructor(plugin) {
    this.plugin = plugin;
  }

  activeEditorContext() {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return null;
    const editor = view.editor;
    return {
      path: view.file.path,
      mode: view.getMode?.() || 'source',
      cursor: editor?.getCursor?.() || null,
      selection: this.plugin.settings.captureSelection ? clampText(editor?.getSelection?.() || '') : '',
      lineCount: editor?.lineCount?.() || null
    };
  }

  vaultSummary() {
    const files = this.plugin.app.vault.getFiles();
    const markdown = files.filter(file => file.extension === 'md');
    const rootChildren = this.plugin.app.vault.getRoot().children || [];
    return {
      name: this.plugin.app.vault.getName(),
      root: this.plugin.vaultRoot,
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
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return null;
    const cache = this.plugin.app.metadataCache.getFileCache(file) || {};
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
      tags: (getAllTags(cache) || []).slice(0, 200)
    };
  }

  capture(controller) {
    if (!controller || !this.plugin.settings.enabled) return null;
    return controller.updateHostContext({
      kind: 'knowledge-base',
      capturedAt: new Date().toISOString(),
      workspaceRoot: this.plugin.vaultRoot,
      vault: this.vaultSummary(),
      activeDocument: this.currentNoteContext(),
      editor: this.activeEditorContext()
    });
  }

  async bundle() {
    const file = this.plugin.app.workspace.getActiveFile();
    const content = file ? clampText(await this.plugin.app.vault.cachedRead(file), 30000) : '';
    return [
      '# DevMate Obsidian Context',
      `Generated: ${new Date().toISOString()}`,
      `Vault: ${this.plugin.app.vault.getName()}`,
      `Root: ${this.plugin.vaultRoot}`,
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
  }
}

module.exports = {
  ObsidianContextProvider,
  clampText
};
