import { z } from 'zod';
import path from 'node:path';
import { offerTool } from '../platform/tools.mjs';
import { id, directory, projectPath, projectScope, within } from './shared.mjs';

// Editor windows: which folders each window has open and what its user is looking at.
// The window operations are for editor hosts on this computer; the editor operations
// are what a connected model reads.
export function defineEditorOperations(service, add) {
  const windowId = z.string().uuid();
  const local = { localOnly: true };
  // register is the owner's explicit answer for a folder that is not a project yet.
  // chosen marks the owner's own act (as opposed to the editor's default), which alone shares a folder that was taken out.
  const folder = z.object({ root: directory, name: z.string().min(1).max(200), register: z.enum(['read', 'write']).optional(), chosen: z.boolean().optional() }).strict();
  add('window.attach', { windowId, title: z.string().min(1).max(200).optional(),
    trusted: z.boolean().default(true), roots: z.array(folder).max(32),
    selectedRoot: directory.optional(),
    // The editor's own copy of a tool DevMate needs (ripgrep), used when PATH has none.
    tools: z.object({ rg: directory.optional() }).strict().optional() }, false,
  'Attach one editor window to its folders. Folders that are already projects are bound; a new folder becomes a project only when register says so.', ({ tools, ...args }) => {
    // A program inside something shared (or inside DevMate's own directory) could be replaced by whoever can write there.
    const shared = file => within(service.instanceRoot, file) || service.store.list('project', { limit: 10000 }).some(project => within(project.root, file));
    for (const [name, file] of Object.entries(tools || {})) if (!shared(path.resolve(file))) offerTool(name, file, service.instanceRoot);
    return service.windows.attach(args);
  }, local);
  add('window.select', { windowId, projectId: id }, false,
    'Select a project belonging to this specific editor window.', args => service.windows.select(args), local);
  add('window.heartbeat', { windowId }, false,
    'Refresh a single editor window lifetime.', args => service.windows.heartbeat(args), local);
  add('window.detach', { windowId }, false,
    'Detach one editor window without stopping other windows or the shared runtime.', args => service.windows.detach(args), local);
  add('window.list', {}, true,
    'List live, independently bound local editor windows.', (_args, context) => ({ items:
      service.windows.list().filter(item => !context.windowId || item.windowId === context.windowId)
        // What an editor has open but does not share is nobody's business but the owner's at this computer.
        .map(item => context.surface === 'local' ? item : { ...item, roots: item.roots.filter(root => root.projectId) }) }));
  add('window.context', { windowId, context: z.record(z.string(), z.unknown()) }, false,
    'Publish this editor window\'s active file, selection, open files and language diagnostics.', args => service.windows.context(args), local);

  const counts = diagnostics => Object.fromEntries(['error', 'warning', 'info', 'hint'].map(severity => [severity, diagnostics.filter(item => item.severity === severity).length]));
  const noEditor = 'No editor is attached to this project. Editor context comes from a VS Code window or an Obsidian vault that has the project open with DevMate running, and diagnostics from VS Code; without one, run the project\'s own checks with shell_run.';
  add('editor.context', { ...projectScope }, true,
    'See what the user has in front of them in their editor for this project: the active file, the selected text, open files and how many errors and warnings the language tooling reports.', args => {
      service.project(args.projectId);
      const state = service.windows.editorState(args.projectId);
      return { attachedWindows: state.attachedWindows, capturedAt: state.capturedAt, active: state.active,
        open: state.open.map(file => file.path + (file.dirty ? ' (unsaved)' : '')), diagnosticCounts: counts(state.diagnostics) };
    }, { present: result => !result.attachedWindows ? noEditor : [
      result.active ? 'Active file: ' + result.active.path + (result.active.languageId ? ' (' + result.active.languageId + ')' : '') + (result.active.dirty ? ', unsaved changes' : '') +
        '\nSelection: ' + result.active.selection.startLine + ':' + result.active.selection.startCharacter + ' to ' + result.active.selection.endLine + ':' + result.active.selection.endCharacter +
        (result.active.selectedText ? '\n--- selected text' + (result.active.selectionTruncated ? ' (truncated)' : '') + ' ---\n' + result.active.selectedText + '\n---' : ' (nothing selected)')
        : 'No file of this project is focused in the editor.',
      'Open files: ' + (result.open.join(', ') || 'none'),
      'Diagnostics: ' + Object.entries(result.diagnosticCounts).map(([severity, total]) => total + ' ' + severity).join(', ') + '. Use editor_diagnostics for the list.'
    ].join('\n') });
  add('editor.diagnostics', { ...projectScope, path: projectPath.optional(), severity: z.enum(['error', 'warning', 'info', 'hint']).optional(),
    limit: z.number().int().min(1).max(500).optional() }, true,
    'List the errors and warnings the user\'s editor currently reports for this project (compiler, type checker, linter), without running a build. severity is the least severe level to include (default warning).', args => {
      service.project(args.projectId);
      const state = service.windows.editorState(args.projectId), order = ['error', 'warning', 'info', 'hint'];
      const level = order.indexOf(args.severity || 'warning'), prefix = args.path ? args.path.replace(/\\/g, '/').replace(/\/$/, '') : null;
      const matching = state.diagnostics.filter(item => order.indexOf(item.severity) <= level &&
        (!prefix || item.path === prefix || item.path.startsWith(prefix + '/')));
      const limit = args.limit || 100;
      return { attachedWindows: state.attachedWindows, capturedAt: state.capturedAt, total: matching.length, counts: counts(matching),
        items: matching.slice(0, limit).map(({ projectId, ...item }) => item), truncated: matching.length > limit || state.diagnosticsTruncated };
    }, { present: result => !result.attachedWindows ? noEditor : result.items.length
      ? result.items.map(item => item.path + ':' + item.line + ':' + item.character + ' ' + item.severity +
        (item.source ? ' [' + item.source + (item.code ? ' ' + item.code : '') + ']' : '') + ' ' + item.message).join('\n') + (result.truncated ? '\n[more diagnostics exist; narrow by path or severity]' : '')
      : 'The editor reports no diagnostics at this level.' });
}
