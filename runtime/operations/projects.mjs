import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { assertSafeWorkspaceRoot } from '../platform/sensitive-path-policy.mjs';
import { id, directory, projectScope, mutation, revision, within } from './shared.mjs';

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];
const OWNER_ONLY_PROTECTION = 'Credential-file protection is lifted by the owner on their own computer: in the local workbench (devmate ui), or with devmate project.update.';

/** Everything a model needs to orient itself in a project, gathered in one call. */
export async function projectOverview(service, projectId) {
  const project = service.project(projectId), root = project.root;
  const readText = (file, limit) => {
    try { const result = service.workspace.read(project, { path: file }); return { path: file, text: result.text.slice(0, limit), truncated: result.truncated || result.text.length > limit }; }
    catch (error) { if (['not_found', 'binary_file', 'file_too_large', 'unsafe_path', 'unsafe_file'].includes(error.code)) return null; throw error; }
  };
  let git = null, gitError = null, changes = [];
  // Both commands are awaited to completion: no Git process may outlive this call.
  const [branches, status] = await Promise.allSettled([service.workspace.gitBranches(project), service.workspace.gitStatus(project)]);
  const failed = [branches, status].find(outcome => outcome.status === 'rejected')?.reason;
  if (!failed) {
    git = { branch: branches.value.current, changedFiles: status.value.items.length };
    changes = status.value.items.slice(0, 40);
  } else if (!['command_failed', 'tool_missing', 'tool_outdated'].includes(failed.code)) throw failed;
  // "Not a repository" is an answer. A repository Git cannot read, a Git that is too old, or no Git at all, is a problem worth naming.
  else if (failed.code !== 'command_failed' || service.workspace.isRepository(project)) gitError = failed.message.slice(0, 400);
  const names = new Set(fs.readdirSync(root));
  const markers = Object.entries({ 'package.json': 'Node.js', 'pyproject.toml': 'Python', 'requirements.txt': 'Python', 'Cargo.toml': 'Rust', 'go.mod': 'Go',
    'pom.xml': 'Java (Maven)', 'build.gradle': 'Java/Kotlin (Gradle)', 'build.gradle.kts': 'Java/Kotlin (Gradle)', 'project.godot': 'Godot',
    'CMakeLists.txt': 'CMake', 'Makefile': 'Make', 'Dockerfile': 'Docker', 'tsconfig.json': 'TypeScript' })
    .filter(([file]) => names.has(file)).map(([, label]) => label);
  if ([...names].some(name => /\.(sln|csproj)$/i.test(name))) markers.push('.NET');
  let scripts = {};
  const manifest = names.has('package.json') ? readText('package.json', 400000) : null;
  if (manifest) { try { scripts = Object.fromEntries(Object.entries(JSON.parse(manifest.text).scripts || {}).slice(0, 60).map(([name, value]) => [name, String(value).slice(0, 300)])); } catch {} }
  const scriptRunner = names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lockb') || names.has('bun.lock') ? 'bun' : 'npm';
  const listing = service.workspace.files(project, { limit: 200 });
  const editor = service.windows.editorState(projectId);
  // Parts of a larger repository often carry their own rules. They are named here, not read:
  // they apply when working inside that folder.
  let nestedInstructions = [];
  try {
    const found = await service.workspace.find(project, { pattern: '**/{AGENTS,CLAUDE,GEMINI}.md', limit: 40 });
    nestedInstructions = found.items.map(item => item.path).filter(file => file.includes('/')).sort().slice(0, 30);
  } catch (error) { if (!['tool_missing', 'command_failed'].includes(error.code)) throw error; }
  return { id: project.id, name: project.name, root, access: project.access, git, ...(gitError ? { gitError } : {}), changes, markers: [...new Set(markers)], scripts, scriptRunner,
    entries: listing.items.map(item => item.name + (item.type === 'directory' ? '/' : '')),
    instructions: INSTRUCTION_FILES.map(file => readText(file, 12000)).filter(Boolean), nestedInstructions,
    editor: { attachedWindows: editor.attachedWindows, error: editor.diagnostics.filter(item => item.severity === 'error').length,
      warning: editor.diagnostics.filter(item => item.severity === 'warning').length } };
}

export function defineProjectOperations(service, add) {
  // With a writable project a client can run commands, and with those reach whatever the owner can reach. So which
  // folders are shared at all is never a client's call: project.create is the owner's own act (ownerDecision).
  add('project.list', { query: z.string().max(200).optional(), cursor: id.optional(), limit: z.number().int().min(1).max(1000).optional() }, true,
    'List registered projects.', (args, context) => service.list('project', args, context));
  add('project.create', { root: directory, name: z.string().min(1).max(200).optional(),
    access: z.enum(['read', 'write']).default('write'), protectSecrets: z.boolean().optional(), ...mutation }, false,
    'Share a local directory as a project. This is the owner\'s decision and is made on their own computer (editor, command line, local workbench); a connected client cannot do it. Credential-like files such as .env, key files and .npmrc stay out of the file tools unless the owner lifts that for the project.', args => {
    if (!path.isAbsolute(args.root)) throw new DomainError('invalid_path', 'Project root must be absolute.');
    const root = fs.realpathSync.native(args.root);
    if (!fs.statSync(root).isDirectory() || root === path.parse(root).root) throw new DomainError('invalid_path', 'Choose a project directory.');
    if (within(root, service.instanceRoot) || within(service.instanceRoot, root)) throw new DomainError('private_runtime', 'Project roots must be separate from the DevMate control directory.');
    if (service.store.projectForRoot(root)) throw new DomainError('already_exists', 'Project is already registered.');
    // A credential or control directory can never be a project, whatever its protection setting.
    try { assertSafeWorkspaceRoot(root); } catch (error) { throw new DomainError('protected_workspace_root', error.message); }
    const project = service.store.create('project', { name: args.name || path.basename(root), root, access: args.access, protectSecrets: args.protectSecrets !== false, status: 'ready' });
    service.setDeclined(root, false);
    return project;
  }, { ownerDecision: 'Folders are shared by the owner on their own computer: by opening the folder in an editor that has DevMate, or with the command: devmate project add <folder>' });
  add('project.overview', { ...projectScope }, true,
    'Orient yourself in a project in one call: Git branch and pending changes, the project\'s agent instructions (AGENTS.md and similar), its run/test scripts, top-level layout and editor diagnostics count. Call this first when starting work on a project.',
    args => projectOverview(service, args.projectId), { present: result => [
      result.name + ' — ' + result.root + ' (' + result.access + ')',
      result.git ? 'Git: branch ' + (result.git.branch || '(detached)') + ', ' + result.git.changedFiles + ' changed file(s)' +
        (result.changes.length ? '\n' + result.changes.map(item => '  ' + item.status + ' ' + item.path + (item.protected ? '  [protected: do not commit]' : '')).join('\n') : '')
        : 'Git: ' + (result.gitError || 'not a repository'),
      'Stack: ' + (result.markers.join(', ') || 'no known manifest at the root'),
      Object.keys(result.scripts).length ? 'Scripts (' + result.scriptRunner + ' run <name>):\n' + Object.entries(result.scripts).map(([name, command]) => '  ' + name + ': ' + command).join('\n') : null,
      'Top level: ' + result.entries.join('  '),
      result.editor.attachedWindows ? 'Editor: ' + result.editor.error + ' error(s), ' + result.editor.warning + ' warning(s) reported' : 'Editor: no window attached',
      result.nestedInstructions.length ? 'Folders with their own instruction file (read it before working there): ' + result.nestedInstructions.join(', ') : null,
      ...result.instructions.map(item => '--- ' + item.path + (item.truncated ? ' (truncated; read the file for the rest)' : '') + ' ---\n' + item.text)
    ].filter(Boolean).join('\n') });
  // Closing what runs in a project before its access is reduced or it is removed.
  const closing = async (projectId, change) => {
    service.projectTransitions.add(projectId);
    try {
      await service.jobs.closeProject(projectId);
      await service.processes.closeProject(projectId);
      await service.capabilities.closeProject(projectId);
      await service.hosts.closeProject(projectId);
      return change();
    } finally { await service.reopenProject(projectId); }
  };
  add('project.update', { id, name: z.string().min(1).max(200).optional(), access: z.enum(['read', 'write']).optional(),
    protectSecrets: z.boolean().optional(), ...revision, ...mutation }, false,
    'Update project name, access or credential-file protection. Reducing access first closes the running work of the project. Widening access or lifting the protection is done by the owner on their own computer.', async (args, context) => {
      if (service.projectTransitions.has(args.id)) throw new DomainError('project_busy', 'Project resources are closing.');
      const current = service.store.get('project', args.id);
      if (args.expectedRevision !== undefined && current.revision !== args.expectedRevision) throw new DomainError('conflict', 'The project changed; refresh before editing.');
      const patch = Object.fromEntries(['name', 'access', 'protectSecrets'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      if (!service.ownerDecides(context)) {
        if (args.access === 'write' && current.access !== 'write') throw new DomainError('forbidden', 'The owner made this project read only. They widen it from their editor (DevMate: Change Folder Sharing), the local workbench (devmate ui) or the command line.');
        if (args.protectSecrets === false && current.protectSecrets !== false) throw new DomainError('forbidden', OWNER_ONLY_PROTECTION);
      }
      if (args.access !== 'read' || current.access === 'read') return service.store.update('project', args.id, patch, args.expectedRevision);
      if (service.agents.connectedInProject(args.id)) throw new DomainError('project_busy', 'Stop connected agents before reducing project access.');
      return closing(args.id, () => service.store.update('project', args.id, patch, args.expectedRevision));
    });
  add('project.remove', { id, ...mutation }, false, 'Remove project registration after its owned execution resources stop; project files remain on disk.', async args => {
    if (service.projectTransitions.has(args.id)) throw new DomainError('project_busy', 'Project resources are closing.');
    service.store.get('project', args.id);
    if (service.agents.connectedInProject(args.id)) throw new DomainError('project_busy', 'Stop connected agents first.');
    const { root } = service.store.get('project', args.id);
    return closing(args.id, () => {
      const removed = service.store.remove('project', args.id);
      service.windows.projectRemoved(args.id);
      // Taken out stays out: no editor default and no connected client brings the folder back.
      service.setDeclined(root, true);
      return removed;
    });
  }, { destructive: true });
}
