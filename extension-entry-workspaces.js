'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { readLifecycleIntent } = require('./shared/lifecycle-intent.cjs');
const { currentWorkspaceRoot, resolveVscodeStateDirectory } = require('./vscode-host/runtime-context.js');
const {
  addWorkspaceAccess,
  listWorkspaceAccess,
  removeWorkspaceAccess
} = require('./vscode-host/workspace-access.js');

let workspacePanel = null;
let workspaceContext = null;
let commandDisposables = [];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function configFile(context = workspaceContext) {
  if (!context) throw new Error('DevMate VS Code context is unavailable');
  return path.join(resolveVscodeStateDirectory(vscode, context), 'config.json');
}

function snapshot(context = workspaceContext) {
  return listWorkspaceAccess(configFile(context));
}

function workspacePanelHtml(context, webview) {
  const state = snapshot(context);
  const currentRoot = currentWorkspaceRoot(vscode) || state.current?.root || '';
  const additional = Array.isArray(state.additional) ? state.additional : [];
  const fullAccess = state.permissionProfile === 'fullAccess';
  const rows = additional.length
    ? additional.map(item => `
      <div class="workspace-row">
        <div class="workspace-main">
          <strong>${esc(item.name || item.id)}</strong>
          <code>${esc(item.root || '')}</code>
          <span class="muted">Workspace ID: ${esc(item.id)}</span>
        </div>
        <div class="row-actions">
          <button class="secondary" data-cmd="copyWorkspaceId" data-id="${esc(item.id)}">Copy ID</button>
          <button class="secondary" data-cmd="openWorkspace" data-root="${esc(item.root)}">Open in New Window</button>
          <button class="secondary danger" data-cmd="removeWorkspace" data-id="${esc(item.id)}">Remove</button>
        </div>
      </div>`).join('')
    : '<p class="muted">No additional writable workspaces yet.</p>';
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  return `<!doctype html><html><head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:22px;line-height:1.45;}
    h2{margin:0 0 18px;font-size:24px;} h3{margin:22px 0 8px;font-size:17px;}
    code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:3px 5px;border-radius:4px;}
    .muted{color:var(--vscode-descriptionForeground);} .card{max-width:1050px;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px 16px;margin:10px 0 18px;}
    .label{font-weight:700;display:block;margin-bottom:6px;} .path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .input-row{display:flex;gap:8px;max-width:1050px;margin:10px 0 6px;} input{flex:1;min-width:220px;box-sizing:border-box;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:4px;padding:7px 9px;}
    button{border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:6px 10px;border-radius:4px;cursor:pointer;} button:hover{background:var(--vscode-button-hoverBackground);} button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);} button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground);} button.danger{border-color:var(--vscode-inputValidation-errorBorder);} button:disabled{opacity:.55;cursor:not-allowed;}
    .workspace-list{max-width:1050px;margin-top:10px;} .workspace-row{display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--vscode-panel-border);padding:12px 0;} .workspace-main{min-width:0;display:flex;flex-direction:column;gap:5px;} .workspace-main code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} .row-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:7px;}
    .contract{max-width:1050px;margin-top:18px;padding-top:14px;border-top:1px solid var(--vscode-panel-border);}
  </style></head><body>
  <h2>DevMate Workspaces</h2>
  <div class="card">
    <span class="label">Current Project</span>
    <code class="path">${esc(currentRoot || 'Open a VS Code project folder first')}</code>
    <p class="muted">This VS Code project is the default for ChatGPT conversations until a conversation explicitly selects another workspace.</p>
  </div>

  <h3>Additional Workspaces</h3>
  <p class="muted">Add writable project roots without changing the Current Project. ChatGPT can explicitly bind a conversation to any listed workspace ID or path, and different conversations can use different workspaces at the same time.</p>
  ${fullAccess ? '' : `<p class="muted">Adding or removing writable workspaces requires the <code>fullAccess</code> permission profile. Current profile: <code>${esc(state.permissionProfile)}</code>.</p>`}
  <div class="input-row">
    <input id="workspacePath" placeholder="Absolute folder path, e.g. A:\\Project\\ProjectWaiting" ${fullAccess ? '' : 'disabled'}>
    <button data-cmd="addWorkspacePath" ${fullAccess ? '' : 'disabled'}>Add Workspace</button>
    <button class="secondary" data-cmd="browseWorkspace" ${fullAccess ? '' : 'disabled'}>Browse</button>
    <button class="secondary" data-cmd="workspaceClipboard" ${fullAccess ? '' : 'disabled'}>From Clipboard</button>
  </div>
  <div class="workspace-list">${rows}</div>

  <div class="contract">
    <strong>Routing rule</strong>
    <p class="muted">Before explicit selection, a conversation follows the current VS Code/Obsidian project. After the user explicitly selects another workspace, that conversation is pinned there across reconnects and editor changes. Workspace access never silently rewrites another conversation's explicit selection.</p>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', event => {
      const button = event.target.closest('button[data-cmd]');
      if (!button) return;
      const message = { cmd: button.dataset.cmd };
      if (message.cmd === 'addWorkspacePath') message.value = document.getElementById('workspacePath')?.value || '';
      if (button.dataset.id) message.id = button.dataset.id;
      if (button.dataset.root) message.root = button.dataset.root;
      vscode.postMessage(message);
    });
    document.getElementById('workspacePath')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') vscode.postMessage({cmd:'addWorkspacePath', value:event.currentTarget.value || ''});
    });
  </script></body></html>`;
}

function refreshWorkspacePanel() {
  if (workspacePanel && workspaceContext) {
    workspacePanel.webview.html = workspacePanelHtml(workspaceContext, workspacePanel.webview);
  }
}

async function addWorkspacePath(context, value) {
  try {
    const result = addWorkspaceAccess(configFile(context), String(value || '').trim());
    refreshWorkspacePanel();
    const label = result.workspace?.name || result.workspace?.root || 'workspace';
    vscode.window.showInformationMessage(result.added ? `DevMate workspace added: ${label}` : `DevMate workspace unchanged: ${result.reason}`);
    return result;
  } catch (error) {
    vscode.window.showErrorMessage(`Could not add DevMate workspace: ${error.message || error}`);
    return null;
  }
}

async function browseWorkspace(context) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Add DevMate Workspace'
  });
  if (!picked?.[0]) return null;
  return addWorkspacePath(context, picked[0].fsPath);
}

async function addWorkspaceFromClipboard(context) {
  const value = String(await vscode.env.clipboard.readText() || '').trim();
  if (!value) {
    vscode.window.showWarningMessage('Clipboard does not contain a workspace path.');
    return null;
  }
  return addWorkspacePath(context, value);
}

function sessionRequested(context) {
  try { return readLifecycleIntent(configFile(context))?.desiredState === 'running'; }
  catch { return false; }
}

async function removeWorkspace(context, id) {
  const state = snapshot(context);
  const target = state.additional.find(item => item.id === id);
  if (!target) {
    vscode.window.showWarningMessage('Additional workspace not found.');
    refreshWorkspacePanel();
    return null;
  }
  const choice = await vscode.window.showWarningMessage(
    `Remove writable workspace access for ${target.root}? DevMate will briefly stop the shared runtime first so no persistent process keeps using the revoked root.`,
    { modal: true },
    'Remove Workspace'
  );
  if (choice !== 'Remove Workspace') return null;
  const restart = sessionRequested(context);
  try {
    await vscode.commands.executeCommand('devMate.stop');
    const result = removeWorkspaceAccess(configFile(context), { id });
    refreshWorkspacePanel();
    if (restart) await vscode.commands.executeCommand('devMate.start', { quiet: true });
    vscode.window.showInformationMessage(`DevMate workspace removed: ${target.name || target.root}`);
    return result;
  } catch (error) {
    vscode.window.showErrorMessage(`Could not remove DevMate workspace: ${error.message || error}`);
    if (restart) {
      try { await vscode.commands.executeCommand('devMate.start', { quiet: true }); } catch {}
    }
    return null;
  }
}

async function copyWorkspaceId(id) {
  if (!id) return;
  await vscode.env.clipboard.writeText(id);
  vscode.window.showInformationMessage(`Workspace ID copied: ${id}`);
}

async function openWorkspace(root) {
  if (!root) return;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true });
}

function openWorkspacePanel(context) {
  workspaceContext = context;
  if (workspacePanel) {
    workspacePanel.reveal();
    refreshWorkspacePanel();
    return;
  }
  workspacePanel = vscode.window.createWebviewPanel(
    'devMateWorkspaces',
    'DevMate Workspaces',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  workspacePanel.onDidDispose(() => { workspacePanel = null; });
  workspacePanel.webview.onDidReceiveMessage(async message => {
    if (message.cmd === 'addWorkspacePath') await addWorkspacePath(context, message.value);
    if (message.cmd === 'browseWorkspace') await browseWorkspace(context);
    if (message.cmd === 'workspaceClipboard') await addWorkspaceFromClipboard(context);
    if (message.cmd === 'removeWorkspace') await removeWorkspace(context, message.id);
    if (message.cmd === 'copyWorkspaceId') await copyWorkspaceId(message.id);
    if (message.cmd === 'openWorkspace') await openWorkspace(message.root);
  });
  refreshWorkspacePanel();
}

function disposeCommands() {
  for (const disposable of commandDisposables.splice(0)) {
    try { disposable.dispose(); } catch {}
  }
}

function register(id, handler) {
  const disposable = vscode.commands.registerCommand(id, handler);
  commandDisposables.push(disposable);
  return disposable;
}

async function activateWorkspaceManagement(context) {
  workspaceContext = context;
  disposeCommands();
  register('devMate.manageWorkspaces', () => openWorkspacePanel(context));
  register('devMate.addWorkspace', () => browseWorkspace(context));
  return { active: true };
}

async function deactivateWorkspaceManagement() {
  disposeCommands();
  workspacePanel?.dispose();
  workspacePanel = null;
  workspaceContext = null;
}

module.exports = {
  activateWorkspaceManagement,
  addWorkspacePath,
  browseWorkspace,
  deactivateWorkspaceManagement,
  openWorkspacePanel,
  refreshWorkspacePanel,
  removeWorkspace
};
