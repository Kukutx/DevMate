import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { assertSafeWorkspaceRoot } from '../platform/sensitive-path-policy.mjs';
import { id, directory, projectScope, mutation, revision, within } from './shared.mjs';

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];
const OWNER_ONLY_PROTECTION = 'Credential-file protection is lifted by the owner on their own computer: in the local workbench (devmate ui), or with devmate project.update. With the full access profile (devmate access full) a connected client may do it.';

/** Everything a model needs to orient itself in a project, gathered in one call. */
export async function projectOverview(service, projectId) {
  const project = service.project(projectId), root = project.root;
  const readText = (file, limit) => {
    try { const result = service.workspace.read(project, { path: file }); return { path: file, text: result.text.slice(0, limit), truncated: result.truncated || result.text.length > limit }; }
    catch (error) { if (['not_found', 'binary_file', 'file_too_large', 'unsafe_path', 'unsafe_file'].includes(error.code)) return null; throw error; }
  };
  let git = null, gitError = null, changes = [];
  // The commands do not wait for one another, and all are awaited to completion: no process may outlive this call.
  // (The third looks for instruction files further down, see below.)
  const [branches, status, nested] = await Promise.allSettled([service.workspace.gitBranches(project), service.workspace.gitStatus(project),
    service.workspace.find(project, { pattern: '**/{AGENTS,CLAUDE,GEMINI}.md', limit: 40 })]);
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
  if (nested.status === 'rejected' && !['tool_missing', 'command_failed'].includes(nested.reason.code)) throw nested.reason;
  const nestedInstructions = nested.status === 'rejected' ? [] : nested.value.items.map(item => item.path).filter(file => file.includes('/')).sort().slice(0, 30);
  return { id: project.id, name: project.name, root, access: project.access, git, ...(gitError ? { gitError } : {}), changes, markers: [...new Set(markers)], scripts, scriptRunner,
    entries: listing.items.map(item => item.name + (item.type === 'directory' ? '/' : '')),
    instructions: INSTRUCTION_FILES.map(file => readText(file, 12000)).filter(Boolean), nestedInstructions,
    editor: { attachedWindows: editor.attachedWindows, error: editor.diagnostics.filter(item => item.severity === 'error').length,
      warning: editor.diagnostics.filter(item => item.severity === 'warning').length } };
}

export function defineProjectOperations(service, add) {
  // With a writable project a client can run commands, and with those reach whatever the owner can reach. So which
  // folders are shared at all is not a client's call: project.create is the owner's own act (ownerDecision), unless
  // the owner chose the full access profile.
  // missing: its folder is not there (moved, renamed or deleted, or on a drive that is not connected). Such a project
  // is still on the list, and every call for it is refused until the folder is back. The folders are looked at for
  // this answer, all at once; one on a share that does not answer in time is given as it was last seen.
  add('project.list', { query: z.string().max(200).optional(), cursor: id.optional(), limit: z.number().int().min(1).max(1000).optional() }, true,
    'List registered projects. One whose folder is not there at the moment is marked missing:true.', async (args, context) => {
      const listed = service.list('project', args, context);
      await service.lookAtFolders(listed.items);
      return { ...listed, items: listed.items.map(project => service.folders.get(project.id)?.missing ? { ...project, missing: true } : project) };
    });
  add('project.create', { root: directory, name: z.string().min(1).max(200).optional(),
    access: z.enum(['read', 'write']).default('write'), protectSecrets: z.boolean().optional(), ...mutation }, false,
    'Share a local directory as a project. This is the owner\'s decision and is made on their own computer (editor, command line, local workbench); a connected client can do it only when the owner chose the full access profile. Credential-like files such as .env, key files and .npmrc stay out of the file tools unless the owner lifts that for the project.', args => {
    if (!path.isAbsolute(args.root)) throw new DomainError('invalid_path', 'Project root must be absolute.');
    const root = fs.realpathSync.native(args.root);
    if (!fs.statSync(root).isDirectory() || root === path.parse(root).root) throw new DomainError('invalid_path', 'Choose a project directory.');
    // The usual case is someone's whole home folder, which holds ~/.devmate.
    if (within(root, service.instanceRoot)) throw new DomainError('private_runtime', 'This folder holds DevMate\'s own directory (' + service.instanceRoot + '), where its credentials and state are kept, so it is not shared as a whole. Share the folders inside it that you work in.');
    if (within(service.instanceRoot, root)) throw new DomainError('private_runtime', 'This folder is inside DevMate\'s own directory (' + service.instanceRoot + ') and is not shared.');
    if (service.store.projectForRoot(root)) throw new DomainError('already_exists', 'Project is already registered.');
    // A credential or control directory can never be a project, whatever its protection setting.
    try { assertSafeWorkspaceRoot(root); } catch (error) { throw new DomainError('protected_workspace_root', error.message); }
    const project = service.store.create('project', { name: args.name || path.basename(root), root, access: args.access, protectSecrets: args.protectSecrets !== false, status: 'ready' });
    service.setDeclined(root, false);
    return project;
  }, { ownerDecision: 'Folders are shared by the owner on their own computer: by opening the folder in an editor that has DevMate, or with the command: devmate project add <folder>. To let a connected client share folders, the owner switches on full access there: devmate access full' });
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
    'Update project name, access or credential-file protection. Reducing access first closes the running work of the project. Widening access or lifting the protection is done by the owner on their own computer, or by a connected client when the owner chose the full access profile.', async (args, context) => {
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
    // The copy an agent worked in stands beside the instance directory, on a branch of the repository. The copy does
    // not outlive the project here, and neither does the branch where the repository is there to be told. Where the
    // folder was moved, the branch stays in it (the words that send an owner here say so).
    // Nothing of this project is asked about any more: a task that waited for the owner's word goes with it, and with
    // it its place among the tasks that may wait.
    service.store.transaction(() => service.agents.abandonHeld(agent => agent.projectId === args.id, 'cancelled',
      { code: 'project_removed', message: 'The project was taken out of sharing before the owner allowed this task.' }));
    // A copy that could not be removed (a program still has its folder) is named with the answer, with what is left
    // of it in the repository and how that goes: its record goes with the project, and nothing here would speak of
    // it again. (A record that names a folder which is no copy of this runtime's is passed over: that folder is not
    // DevMate's to have removed.)
    const left = [];
    for (const agent of service.store.list('agent', { projectId: args.id, limit: 10000 })) {
      if (agent.isolated && !agent.isolated.settled) await service.workspace.discardProposal(service.project(args.id), agent.isolated, { leaving: true })
        .catch(error => { if (error?.code !== 'invalid_input') left.push({ root: agent.isolated.root, branch: agent.isolated.branch }); });
    }
    return closing(args.id, () => {
      const removed = service.store.remove('project', args.id);
      service.windows.projectRemoved(args.id);
      // Taken out stays out: no editor default and no connected client brings the folder back.
      service.setDeclined(root, true);
      return left.length ? { ...removed, copiesLeft: left, note: left.length + ' copy(ies) an agent worked in could not be removed, most likely because a program still uses the folder: ' +
        left.map(copy => copy.root + ' (branch ' + copy.branch + ')').join('; ') + '. Nothing of DevMate uses them any more. When nothing else does either, delete such a folder and run "git worktree prune" and "git branch -D <its branch>" in the repository of the project.' } : removed;
    });
  }, { destructive: true });
}
