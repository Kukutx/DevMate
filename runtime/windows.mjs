import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from './store.mjs';
import { isSensitiveWorkspacePath } from './platform/sensitive-path-policy.mjs';

const ttlMs = 5 * 60_000;
const MAX_SELECTION = 20000;
const MAX_OPEN = 100;
const MAX_DIAGNOSTICS = 500;
const fault = (code, message) => new DomainError(code, message);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

/**
 * Window attachments are ephemeral local-host observations, not durable projects.
 * Each extension-host window owns one identity; no active-project global exists.
 */
export function createWindowRegistry({ store, registerProject, isDeclined = () => false, now = Date.now } = {}) {
  if (!store || typeof registerProject !== 'function') throw new TypeError('Window registry needs the current store and project registration.');
  const windows = new Map();
  const access = projectId => { try { return store.get('project', projectId).access; } catch { return null; } };
  function prune() {
    for (const [id, value] of windows) if (now() - value.seenAt > ttlMs) windows.delete(id);
  }
  function list() {
    prune();
    return [...windows.values()].sort((a,b) => a.windowId.localeCompare(b.windowId)).map(value => ({
      windowId: value.windowId, title: value.title, trusted: value.trusted,
      roots: value.roots.map(({root, opened, name, projectId, reason}) => ({root, opened, name, projectId, access: projectId ? access(projectId) : null,
        ...(!projectId && reason ? {reason} : {}), ...(!projectId && isDeclined(root) ? {declined: true} : {})})),
      selectedProjectId: value.selectedProjectId, lastSeenAt: new Date(value.seenAt).toISOString()
    }));
  }
  function attach({windowId, title, roots = [], selectedRoot, trusted = true}) {
    prune();
    if (!trusted && roots.length) throw fault('untrusted_workspace', 'An untrusted window cannot register writable folders.');
    const canonical = [], unavailable = [], observed = new Set();
    for (const folder of roots) {
      if (!path.isAbsolute(folder.root)) throw fault('invalid_path', 'A folder root must be an absolute local path.');
      // One folder that is gone (deleted, on an unplugged drive) does not cost the window its other folders.
      let real;
      try { real = fs.realpathSync.native(folder.root); if (!fs.statSync(real).isDirectory()) real = null; } catch { real = null; }
      if (!real) { unavailable.push({root:path.resolve(folder.root),opened:path.resolve(folder.root),name:folder.name,projectId:null,reason:'This folder cannot be opened.'}); continue; }
      const identity = key(real);
      if (observed.has(identity)) continue;
      observed.add(identity);
      // `opened` is the folder as the editor names it (through a junction, a
      // substituted drive, a symlink); the editor reports its files under that spelling.
      canonical.push({root:real,opened:path.resolve(folder.root),name:folder.name,register:folder.register,chosen:folder.chosen === true});
    }
    let selectedIdentity = null;
    if (selectedRoot) {
      if (!path.isAbsolute(selectedRoot)) throw fault('invalid_selection','Select a folder of this editor window.');
      // A remembered folder that has since gone is simply no selection.
      try { selectedIdentity = key(fs.realpathSync.native(selectedRoot)); } catch { selectedIdentity = null; }
      if (selectedIdentity && !observed.has(selectedIdentity)) throw fault('invalid_selection','The chosen folder is not open in this editor window.');
    }
    const previous = windows.get(windowId);
    const result = store.transaction(() => canonical.map(folder => {
      // A folder becomes a project by the editor's default or by its owner's explicit choice. The default never
      // brings back a folder the owner took out, and a folder that cannot be a project stays listed, unbound, with the reason.
      let project = store.projectForRoot(folder.root), reason = null;
      if (!project && folder.register && (folder.chosen || !isDeclined(folder.root))) {
        try { project = registerProject(folder.root,folder.name,folder.register); }
        catch (error) { if (folder.chosen || !(error instanceof DomainError)) throw error; reason = error.message; }
      }
      return {root:folder.root,opened:folder.opened,name:folder.name,projectId:project ? project.id : null,...(reason ? {reason} : {})};
    })).concat(unavailable);
    const bound = result.filter(item => item.projectId);
    let selected = null;
    if (selectedIdentity) selected = result.find(item => key(item.root) === selectedIdentity);
    else if (previous?.selectedProjectId) selected = result.find(item => item.projectId === previous.selectedProjectId);
    // One shared folder needs no choice, whatever else is open beside it.
    if (!selected?.projectId && bound.length === 1) selected = bound[0];
    const entry = {windowId,title:title||'Editor window',trusted,roots:result,
      selectedProjectId:selected?.projectId||null,seenAt:now(),focusedAt:previous?.focusedAt||0,
      // The editor keeps publishing only what changes; a re-attach of the same window keeps what it last said.
      ...(previous?.editor ? {editor:previous.editor} : {})};
    windows.set(windowId,entry);
    return list().find(item => item.windowId === windowId);
  }

  function get(windowId) {
    prune();
    const entry=windows.get(windowId);
    if (!entry) throw fault('window_missing','This editor window is not attached.');
    return {windowId,selectedProjectId:entry.selectedProjectId,
      projectIds:entry.roots.map(root=>root.projectId).filter(Boolean)};
  }
  function select({windowId,projectId}) {
    prune();
    const item = windows.get(windowId);
    if (!item) throw fault('window_missing','This editor window is not attached.');
    if (!item.roots.some(root => root.projectId === projectId)) throw fault('scope_mismatch','Project is outside this editor window.');
    item.selectedProjectId = projectId;
    item.seenAt = item.focusedAt = now();
    return list().find(window => window.windowId === windowId);
  }
  function heartbeat({windowId}) {
    prune();
    const entry=windows.get(windowId);
    if (!entry) throw fault('window_missing','This editor window must attach before heartbeats.');
    entry.seenAt=now();
    // The window learns here what changed elsewhere: a folder made read only or taken out in the workbench or another window.
    return {...list().find(item => item.windowId === windowId),attached:true};
  }
  function detach({windowId}) {
    return {windowId,detached:windows.delete(windowId)};
  }
  function projectRemoved(projectId) {
    for (const item of windows.values()) {
      for (const root of item.roots) if (root.projectId === projectId) root.projectId = null;
      if (item.selectedProjectId===projectId) item.selectedProjectId=null;
    }
  }

  // Editor state is a volatile observation published by the window itself:
  // the active file, selection, open tabs and language diagnostics. Paths are
  // reduced to project-relative ones; anything outside the window's own
  // folders or under a protected path is dropped before it is kept.
  function inside(directory, file) {
    const relative = path.relative(directory, file);
    return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? null : relative;
  }
  function locate(entry, file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    // The innermost folder wins when one open folder contains another.
    let best = null;
    for (const root of entry.roots) {
      if (!root.projectId) continue;
      const relative = inside(root.opened, file) ?? inside(root.root, file);
      if (relative !== null && (!best || relative.length < best.relative.length)) best = { root, relative };
    }
    if (!best) return null;
    const projectPath = best.relative.split(path.sep).join('/');
    if (best.root.protect !== false && isSensitiveWorkspacePath(projectPath)) return null;
    return { projectId: best.root.projectId, path: projectPath };
  }
  const position = value => Number.isInteger(value) && value >= 0 ? value : 0;
  function context({windowId, context: input = {}}) {
    prune();
    const entry = windows.get(windowId);
    if (!entry) throw fault('window_missing','This editor window is not attached.');
    // Whether credential-like paths are withheld is the project's own setting, read when the state arrives. The state
    // is one for every reader, so the full access profile, which is the owner's alone, does not change it.
    for (const root of entry.roots) {
      if (!root.projectId) continue;
      try { root.protect = store.get('project', root.projectId).protectSecrets !== false; } catch { root.protect = true; }
    }
    const editor = {capturedAt: new Date(now()).toISOString(), active: null, open: [], diagnostics: [], diagnosticsTruncated: false};
    const active = input.active && locate(entry, input.active.file);
    if (active) {
      const selection = input.active.selection || {};
      const selectedText = typeof input.active.selectedText === 'string' ? input.active.selectedText : '';
      editor.active = {...active, languageId: String(input.active.languageId || '').slice(0, 80), dirty: input.active.dirty === true,
        lineCount: position(input.active.lineCount),
        selection: {startLine: position(selection.startLine) + 1, startCharacter: position(selection.startCharacter) + 1,
          endLine: position(selection.endLine) + 1, endCharacter: position(selection.endCharacter) + 1},
        selectedText: selectedText.slice(0, MAX_SELECTION), selectionTruncated: selectedText.length > MAX_SELECTION};
    }
    for (const item of Array.isArray(input.open) ? input.open.slice(0, 400) : []) {
      const located = locate(entry, item?.file);
      if (located && editor.open.length < MAX_OPEN) editor.open.push({...located, dirty: item.dirty === true});
    }
    const severities = ['error','warning','info','hint'];
    const incoming = Array.isArray(input.diagnostics) ? input.diagnostics : [];
    // Errors first, so a truncated list never hides one behind hints.
    for (const severity of severities) for (const item of incoming) {
      if (item?.severity !== severity) continue;
      const located = locate(entry, item.file);
      if (!located) continue;
      if (editor.diagnostics.length >= MAX_DIAGNOSTICS) { editor.diagnosticsTruncated = true; break; }
      editor.diagnostics.push({...located, severity, line: position(item.line) + 1, character: position(item.character) + 1,
        message: String(item.message || '').slice(0, 1000), ...(item.source ? {source: String(item.source).slice(0, 80)} : {}),
        ...(item.code !== undefined && item.code !== null ? {code: String(item.code).slice(0, 80)} : {})});
    }
    entry.editor = editor;
    entry.seenAt = now();
    // Being alive is not being used: only the window the owner is working in moves to the front.
    if (input.focused !== false && editor.active) entry.focusedAt = entry.seenAt;
    return {windowId, accepted: true, diagnostics: editor.diagnostics.length};
  }
  function editorState(projectId) {
    prune();
    const attached = [...windows.values()].filter(item => item.roots.some(root => root.projectId === projectId));
    const observed = attached.filter(item => item.editor).sort((a, b) => b.editor.capturedAt.localeCompare(a.editor.capturedAt));
    const diagnostics = [], seen = new Set();
    for (const item of observed) for (const diagnostic of item.editor.diagnostics) {
      if (diagnostic.projectId !== projectId) continue;
      const key = [diagnostic.path, diagnostic.line, diagnostic.character, diagnostic.severity, diagnostic.message].join('\0');
      if (!seen.has(key)) { seen.add(key); diagnostics.push(diagnostic); }
    }
    const focused = observed.find(item => item.editor.active?.projectId === projectId);
    const open = [], openSeen = new Set();
    for (const item of observed) for (const file of item.editor.open) {
      if (file.projectId === projectId && !openSeen.has(file.path)) { openSeen.add(file.path); open.push(file); }
    }
    return {attachedWindows: attached.length, capturedAt: observed[0]?.editor.capturedAt || null,
      active: focused ? focused.editor.active : null, open, diagnostics,
      diagnosticsTruncated: observed.some(item => item.editor.diagnosticsTruncated)};
  }
  // The project the owner most recently worked on in an editor, among the given ones.
  function focusedProject(projectIds) {
    prune();
    const allowed = new Set(projectIds);
    const recent = [...windows.values()].sort((a, b) => b.focusedAt - a.focusedAt || b.seenAt - a.seenAt);
    for (const item of recent) {
      const candidate = item.editor?.active?.projectId || item.selectedProjectId;
      if (candidate && allowed.has(candidate)) return candidate;
    }
    return null;
  }
  return {attach,select,heartbeat,detach,get,list,projectRemoved,context,editorState,focusedProject};
}
