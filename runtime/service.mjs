import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store, DomainError } from './store.mjs';
import { AgentCoordinator } from './coordination.mjs';
import { createWorkspaceService } from './workspace.mjs';
import { createCapabilities } from './capabilities.mjs';
import { createAuth } from './auth.mjs';
import { createHostRegistry } from './hosts.mjs';
import { InputRequests } from './requests.mjs';
import { createJobRunner } from './jobs.mjs';
import { createWindowRegistry } from './windows.mjs';
import { recallTools } from './platform/tools.mjs';
import { checkProviderSettings, normalizeConfig, publicMcpUrl } from './config.mjs';
import { createProcessManager } from './processes.mjs';
import { verifyPublicMcp } from './connection-verify.mjs';
import { createSecretStore } from './secrets.mjs';
import { CLIENT_COMMAND_ENV } from './client.mjs';
import { defineOperations } from './operations/index.mjs';
import { projectOverview } from './operations/projects.mjs';
import { doctor } from './operations/doctor.mjs';
import { snapshot } from './operations/snapshot.mjs';
import { hash, now, projectScope } from './operations/shared.mjs';

// The service is the one registry every caller goes through: MCP, the CLI, the editor
// hosts and the workbench. It owns identity and project authorization, idempotency and
// the lifetime of everything the runtime runs. What the operations are is defined in
// ./operations; how each is authorized is decided here.
const ownerOperations = new Set(['project.create', 'project.update', 'project.remove', 'runtime.stop', 'capability.configure',
  'window.attach', 'window.detach', 'window.select', 'window.heartbeat', 'window.list']);
// These operations dispatch to another operation, which performs its own authorization.
const dispatching = new Set(['capability.call', 'operations.call']);
const storedKinds = ['agent', 'workflow', 'task', 'job', 'approval', 'input', 'reference', 'artifact'];
const MAINTENANCE_INTERVAL_MS = 6 * 3600000;
const LOCAL_OWNER = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const rootKey = root => process.platform === 'win32' ? root.toLowerCase() : root;
// What a project command inherits: the owner's environment without DevMate's own
// connection credentials and without the variables an editor host injects for itself.
function commandEnvironment(config, env = process.env) {
  const withheld = new Set(['TUNNEL_TOKEN', 'CONTROL_PLANE_API_KEY', 'CLOUDFLARE_TUNNEL_TOKEN', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE',
    config.connection?.tokenEnv, config.connection?.runtimeKeyEnv].filter(Boolean).map(name => name.toUpperCase()));
  // The marker tells the devmate command line that a connected client started it: it then acts with that
  // client's authority, not as the owner at this computer (CLIENT_COMMAND_ENV in runtime/client.mjs).
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => {
    const upper = name.toUpperCase();
    return !withheld.has(upper) && !upper.startsWith('VSCODE_') && !upper.startsWith('DEVMATE_AGENT_');
  })), [CLIENT_COMMAND_ENV]: '1' };
}
function readable(error) {
  return error.issues.slice(0, 6).map(issue => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; ');
}
// Restorable file versions are kept for the retention period, and never more than this in total:
// beyond it the versions that were used longest ago go first.
const HISTORY_MAX_BYTES = 2 * 1024 ** 3;
function pruneHistory(directory, retentionMs, maxBytes = HISTORY_MAX_BYTES) {
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const kept = [];
  for (const name of names) {
    const file = path.join(directory, name), stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    if (Date.now() - stat.mtimeMs > retentionMs) fs.rmSync(file, { force: true });
    else kept.push({ file, bytes: stat.size, usedAt: stat.mtimeMs });
  }
  let total = kept.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of kept.sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= maxBytes) break;
    fs.rmSync(item.file, { force: true });
    total -= item.bytes;
  }
}
export const __test = { pruneHistory };

export class DevMateService {
  constructor({ instanceRoot, endpoint, adapterFactory, providerSettings, connection, onStop, store, config = {}, capabilitiesFactory = createCapabilities, authOptions = {}, verifier = verifyPublicMcp }) {
    this.verifier = verifier;
    this.identity = null;
    this.verification = null;
    this.store = store || new Store(instanceRoot);
    this.instanceRoot = fs.realpathSync.native(instanceRoot);
    this.config = normalizeConfig(config);
    this.execution = new AbortController();
    this.activeCalls = new Set();
    this.projectTransitions = new Set();
    this.closing = false;
    this.workspace = createWorkspaceService({ store: this.store });
    this.processes = createProcessManager({ instanceRoot: this.instanceRoot, store: this.store, env: commandEnvironment(this.config) });
    this.secrets = createSecretStore(this.instanceRoot);
    try { this.maintain(); } catch (error) { this.store.recordNotificationFailure(error); }
    this.maintenanceTimer = setInterval(() => { try { this.maintain(); } catch (error) { this.store.recordNotificationFailure(error); } }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
    this.accessProfile = this.store.setting('access.profile') === 'full' ? 'full' : 'guarded';
    this.agents = new AgentCoordinator({ store: this.store, endpoint, adapterFactory, providerSettings: providerSettings || this.config.providers,
      // Full access is the owner's: what an agent asks is granted without a person only when the owner started the
      // agent and the task it is working on is the owner's too.
      grantsApprovals: (agent, principal) => this.fullAccess() && agent.caller === 'owner' && principal === 'owner' });
    // What the owner changed about the coding agents while the runtime ran lies on top of the configuration.
    if (!providerSettings) for (const name of Object.keys(this.store.setting('providers.live') || {})) {
      try { this.applyProviderSettings(name); } catch (error) { this.store.recordNotificationFailure(error); }
    }
    this.inputs = new InputRequests(this.store);
    this.connection = connection;
    this.onStop = onStop;
    this.operations = new Map();
    this.inflight = new Map();
    this.registerOperations();
    this.windows = createWindowRegistry({store:this.store,isDeclined:root => this.isDeclined(root),registerProject:(root,name,access) =>
      this.operations.get('project.create').run({root,name,access},LOCAL_OWNER)});
    recallTools(this.instanceRoot);
    this.providerDiscovery = null;
    this.ready = Promise.resolve().then(async () => {
      // Before any new work: what an earlier runtime of this instance left running when it died.
      await this.processes.reapLeftovers().catch(error => this.store.recordNotificationFailure(error));
      this.auth = createAuth({ ...authOptions, store: this.store, instanceRoot: this.instanceRoot, config: this.config.auth });
      for (const operation of this.auth.operations) {
        if (['auth.member.update','auth.member.remove'].includes(operation.name)) {
          const originalRun = operation.run;
          this.operations.set(operation.name, { ...operation, run: async args => {
            const result = await originalRun(args);
            // Losing access ends what that identity still has running.
            await this.jobs.cancelForCaller(args.id);
            await this.processes.stopForCaller(args.id);
            await this.agents.stopForCaller(args.id);
            return result;
          } });
        } else this.operations.set(operation.name, operation);
      }
      this.hosts = createHostRegistry({ service: this, instanceRoot: this.instanceRoot });
      for (const operation of this.hosts.operations) this.operations.set(operation.name, operation);
      this.capabilities = await capabilitiesFactory({ service: this, instanceRoot: this.instanceRoot,
        externalServers: this.config.externalServers, engineSettings: this.config.engineSettings, hostRegistry: this.hosts,
        onInputRequest: request => this.inputs.request(request), inputCapabilities: { elicitation: { form: {} } } });
      this.jobs = createJobRunner({ store: this.store, execute: async (job, { signal }) => {
        this.authorizeQueuedJob(job);
        if (job.kind === 'command') return this.processes.complete(this.project(job.projectId, { write: true }), job.input.args, { signal });
        try { return await this.capabilities.call(job.input.args, { signal, callerRole: job.input.caller.role, callerId: job.input.caller.id }); }
        catch (error) {
          // The capability registry owns its client/process lifetime separately from this request.
          error.executionSettled = true;
          if (['forbidden', 'read_only', 'scope_mismatch', 'unknown_capability', 'invalid_input', 'missing_credential', 'not_found'].includes(error.code) || error.name === 'ZodError') error.notStarted = true;
          throw error;
        }
      } });
      return this;
    });
    this.ready.catch(() => {});
  }

  authorizeQueuedJob(job) {
    const caller = job.input?.caller;
    if (caller?.id === 'owner' && caller.role === 'owner') return;
    let member;
    try { member = this.store.get('auth-member', caller?.id); } catch {}
    if (!member || member.disabled || member.authVersion !== caller?.authVersion ||
        member.role !== 'write' || caller.role !== member.role || !member.projectIds?.includes(job.projectId)) {
      const error = new DomainError('authorization_revoked', 'The queued request no longer has valid project authorization.');
      error.notStarted = true;
      throw error;
    }
  }

  // Which coding agents are installed, with their versions. Looked up once every half minute at most.
  discoverProviders() {
    const nowMs = Date.now();
    if (!this.providerDiscovery || this.providerDiscovery.expiresAt <= nowMs) this.providerDiscovery = { expiresAt: nowMs + 30_000, value: this.agents.providers() };
    return this.providerDiscovery.value;
  }

  // options: destructive / openWorld / idempotent tool hints, projectOf(args) for
  // items that are not stored entities, and present(result) for model-facing text.
  register(name, shape, readOnly, description, run, options = {}) {
    if (this.operations.has(name)) throw new Error('Duplicate operation: ' + name);
    // Authorization needs to know which project an item belongs to. An operation that
    // takes an id must say how to find it; forgetting must fail here, not at run time.
    const kind = name.split('.')[0] === 'agents' ? 'agent' : name.split('.')[0];
    if (shape.id && !options.projectOf && kind !== 'project' && !storedKinds.includes(kind)) throw new Error('Operation ' + name + ' takes an id but declares no project scope.');
    this.operations.set(name, { name, schema: z.object(shape).strict(), readOnly, description, run,
      needsProject: shape.projectId === projectScope.projectId, ...options });
  }

  // Callers may name a project by its id, its registered root directory or its unique name.
  // A member only ever resolves among its own grants, so a name or path reveals nothing about other projects.
  resolveProjectReference(value, context) {
    if (typeof value !== 'string' || value.startsWith('project-')) return value;
    const granted = project => context.role === 'owner' || context.projectIds?.includes(project.id);
    if (path.isAbsolute(value)) {
      // Only the owner at this computer has a path looked up on disk. For anyone else it is compared, as written,
      // with the roots of the projects: a path a caller supplies must never make this process open a network share.
      // Spelled the way a root is stored (separators, no trailing one): that needs no look at the disk.
      let root = path.resolve(value);
      if (context.surface === 'local' && context.role === 'owner') { try { root = fs.realpathSync.native(value); } catch {} }
      const project = this.store.projectForRoot(root);
      if (project && granted(project)) return project.id;
      if (context.role !== 'owner') return value;
      throw new DomainError('project_not_registered', 'This directory is not a shared project. ' + this.howToShare(context));
    }
    const matches = this.store.list('project', { limit: 10000 }).filter(project => project.name === value && granted(project));
    if (matches.length > 1) throw new DomainError('ambiguous_project', 'Several projects share this name; use the project id.');
    return matches.length ? matches[0].id : value;
  }

  operationProject(name, operation, args) {
    if (operation.projectOf) return operation.projectOf(args);
    let projectId = args.projectId;
    if (args.workflowId) projectId = this.store.get('workflow', args.workflowId).projectId;
    if (args.id) {
      const namespace = name.split('.')[0];
      const kind = namespace === 'agents' ? 'agent' : namespace;
      if (kind === 'project') projectId = args.id;
      else if (storedKinds.includes(kind)) projectId = this.store.get(kind, args.id).projectId;
    }
    return projectId;
  }

  // What is shared, and how far, is the owner's decision, and it is made at this computer: in an editor, on the
  // command line, in the local workbench. A connected client can narrow what is shared; it cannot widen it. That
  // includes a workbench embedded in a chat app: what such a client is, only the client itself says.
  // The one exception is the owner's own, and is also made at this computer: the full access profile hands these
  // decisions to whoever connects as the owner, for people who drive everything from a chat client.
  ownerDecides(context) { return context?.role === 'owner' && (context.surface === 'local' || this.fullAccess()); }
  fullAccess() { return this.accessProfile === 'full'; }
  // The local control interface. With full access the owner's connected client may also read what tells it why
  // something does not work (fullAccessRead: the doctor, metrics, credential names). Changing anything there stays
  // at this computer in either profile: a remote caller could cut its own route.
  reachesLocal(operation, context) {
    return context.role === 'owner' && (context.surface === 'local' || (operation.fullAccessRead === true && this.fullAccess()));
  }
  setAccessProfile(profile) {
    this.store.setting('access.profile', profile);
    this.accessProfile = profile;
    // Whatever already waits for a permission is covered by the new choice as well.
    if (profile === 'full') this.agents.grantWaiting();
    return { profile };
  }
  // Folders the owner took out of sharing. They come back only by the owner's own choice, and not through a
  // folder above or below them either: an editor's default never shares what would bring one back.
  isDeclined(root) {
    const key = rootKey(root), inside = (outer, inner) => { const relative = path.relative(outer, inner); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
    return (this.store.setting('sharing.declined') || []).some(item => inside(item, key) || inside(key, item));
  }
  setDeclined(root, declined) {
    const all = new Set(this.store.setting('sharing.declined') || []), key = rootKey(root);
    if (all.has(key) === declined) return;
    if (declined) all.add(key); else all.delete(key);
    this.store.setting('sharing.declined', [...all].slice(-2000));
  }

  // The project a call means when it names none: the window's own, the caller's only one,
  // or the one whose editor window was used most recently.
  defaultProject(context, operation) {
    if (context.projectId) return context.projectId;
    // An editor window never borrows the project of another window.
    if (context.windowId) throw new DomainError('window_unselected', 'Share and select a folder of this editor window first.');
    const available = this.store.list('project', { limit: 10000, ...(context.role !== 'owner' ? { projectIds: context.projectIds || [] } : {}) });
    if (available.length === 1) return available[0].id;
    // Reading may follow the editor: "what is this file" means the project in front of the user. A change may not:
    // the same call would land in another project the moment the user clicks into a different window.
    const focused = operation?.readOnly ? this.windows.focusedProject(available.map(project => project.id)) : null;
    if (focused) return focused;
    throw new DomainError('project_required', available.length
      ? 'Several projects are available; say which one with projectId. ' + available.slice(0, 20).map(project => project.id + ' = ' + project.name).join('; ')
      : 'No folder is shared yet. ' + this.howToShare(context));
  }
  // What to do about a folder that is not shared, said to the caller who can do it.
  howToShare(context) {
    return context.surface !== 'local' && this.ownerDecides(context)
      ? 'Share it with operations_call {operation:"project.create", input:{root:"<absolute folder>"}}.'
      : 'Folders are shared by the owner on their own computer: in an editor that has DevMate, or with: devmate project add <folder>';
  }

  // What ends a wait: the runtime stopping, or the caller giving up on its request.
  // Giving up never ends the work itself; a started command or agent turn stays reachable.
  waitSignal(context) {
    return context?.signal ? AbortSignal.any([this.execution.signal, context.signal]) : this.execution.signal;
  }

  // The end of every project transition, also a failed one: a project that still
  // exists accepts work again instead of staying closed because a step threw.
  async reopenProject(projectId) {
    try {
      if (this.store.db.prepare("SELECT 1 FROM entities WHERE id=? AND kind='project'").get(projectId)) {
        await this.jobs.reopenProject(projectId);
        await this.capabilities.reopenProject(projectId);
      }
    } catch (error) { this.store.recordNotificationFailure(error); }
    finally { this.projectTransitions.delete(projectId); }
  }

  // caller: who the project is being opened for. With full access nothing is withheld from the owner, whatever the
  // project's own setting says; every other account keeps the protection.
  project(projectId, { write = false, caller } = {}) {
    const project = this.store.get('project', projectId);
    if (write && this.projectTransitions.has(projectId)) throw new DomainError('project_busy', 'Project execution resources are closing.');
    if (write && project.access !== 'write') throw new DomainError('read_only', 'Project is read-only.');
    return { ...project, ...(this.fullAccess() && caller?.role === 'owner' ? { protectSecrets: false } : {}), controlRoot: this.instanceRoot };
  }

  list(kind, input, context) {
    if (!context?.id || !['owner','write','read'].includes(context.role)) throw new DomainError('unauthorized', 'A verified caller identity is required.');
    if (input.projectId) this.project(input.projectId);
    if (input.workflowId) {
      const workflow = this.store.get('workflow', input.workflowId);
      if (input.projectId && input.projectId !== workflow.projectId) throw new DomainError('scope_mismatch', 'Workflow belongs to another project.');
    }
    if (context.role !== 'owner' && !Array.isArray(context.projectIds)) throw new DomainError('forbidden', 'Project grants are required.');
    const limit = input.limit || 200;
    const windowScope = context.projectId;
    const items = this.store.list(kind, {
      ...input, ...(windowScope && kind !== 'project' ? {projectId:windowScope} : {}),
      afterId: input.cursor, limit: limit + 1,
      ...(windowScope && kind === 'project' ? {projectIds:[windowScope]} :
        context.role !== 'owner' ? {projectIds:context.projectIds} : {})
    });
    const nextCursor = items.length > limit ? items[limit - 1].id : undefined;
    return { items: items.slice(0, limit).map(item => ['task','artifact'].includes(kind)
      ? { ...item, uri: 'devmate://' + kind + '/' + item.id } : item), ...(nextCursor ? { nextCursor } : {}) };
  }

  visibleOperations(context) {
    if (!context?.id || !['owner','write','read'].includes(context.role)) throw new DomainError('unauthorized', 'A verified caller identity is required.');
    return [...this.operations.values()].filter(operation =>
      (!operation.localOnly || this.reachesLocal(operation, context)) &&
      (!(operation.humanOnly || operation.ownerDecision) || context.surface === 'local' || this.ownerDecides(context)) &&
      (context.role === 'owner' || !ownerOperations.has(operation.name)) &&
      (context.role !== 'read' || operation.readOnly || dispatching.has(operation.name)));
  }

  async invoke(operation, args, context) {
    const work = Promise.resolve().then(() => operation.run(args, context));
    this.activeCalls.add(work);
    try { return await work; } finally { this.activeCalls.delete(work); }
  }

  async call(name, input = {}, context) {
    if (!context?.id || !['owner','write','read'].includes(context.role)) throw new DomainError('unauthorized', 'A verified caller identity is required.');
    await this.ready;
    if (this.closing && !['runtime.stop', 'host.record.get', 'host.record.put', 'host.record.list'].includes(name)) throw new DomainError('runtime_stopping', 'Runtime is stopping.');
    const operation = this.operations.get(name);
    if (!operation) throw new DomainError('unknown_operation', 'Unknown DevMate operation: ' + name);
    if (context.role === 'read' && !operation.readOnly && !dispatching.has(name)) throw new DomainError('forbidden', 'This caller has read-only access.');
    let args;
    try { args = operation.schema.parse(input); }
    catch (error) { throw error.name === 'ZodError' ? new DomainError('invalid_input', 'Invalid input for ' + name + ': ' + readable(error)) : error; }
    if (args.projectId !== undefined) args.projectId = this.resolveProjectReference(args.projectId, context);
    else if (operation.needsProject) args.projectId = (args.workflowId ? this.store.get('workflow', args.workflowId).projectId : args.agentId ? this.store.get('agent', args.agentId).projectId : null) || this.defaultProject(context, operation);
    if (!['owner', 'write', 'read'].includes(context.role)) throw new DomainError('unauthorized', 'A verified caller identity is required.');
    if (operation.localOnly && !this.reachesLocal(operation, context)) throw new DomainError('forbidden', 'This operation is available only through the local control interface: the owner does it at their own computer.');
    // A decision that is the person's own (answering what an agent asks) is taken at this computer. Anywhere else
    // the caller may be the very model that started the agent, and nothing a client says about itself proves otherwise.
    if (operation.humanOnly && context.surface !== 'local' && !this.ownerDecides(context)) throw new DomainError('forbidden', 'This decision is the user\'s own. They answer it on their computer: in the DevMate workbench (devmate ui) or in their editor. (With the full access profile, devmate access full, permissions are granted automatically and the owner\'s client may answer.)');
    if (operation.ownerDecision && !this.ownerDecides(context)) throw new DomainError('forbidden', operation.ownerDecision);
    if (context.role !== 'owner') {
      if (!Array.isArray(context.projectIds)) throw new DomainError('forbidden', 'No project grants are assigned.');
      if (ownerOperations.has(name)) throw new DomainError('forbidden', 'Owner access required.');
      if (args.projectId && !context.projectIds.includes(args.projectId)) throw new DomainError('forbidden', 'Project is outside the caller grants.');
      const projectId = this.operationProject(name, operation, args);
      if (projectId && !context.projectIds.includes(projectId)) throw new DomainError('forbidden', 'Item is outside the caller grants.');
    }
    const executionProject = this.operationProject(name, operation, args);
    if (!operation.readOnly && name !== 'host.record.put' && executionProject && this.projectTransitions.has(executionProject)) throw new DomainError('project_busy', 'Project execution resources are closing.');
    if (context.projectId && executionProject && executionProject !== context.projectId) throw new DomainError('scope_mismatch', 'Project is outside this caller scope.');
    if (context.windowId && !context.projectId && executionProject && !name.startsWith('window.')) throw new DomainError('window_unselected', 'Share and select a folder of this editor window first.');
    if (operation.readOnly || !args.operationId) return this.invoke(operation, args, context);
    const operationKey = (context.id || 'owner') + ':' + args.operationId;
    const fingerprint = hash(JSON.stringify({ name, args }));
    const existing = this.store.operation(operationKey);
    if (existing) {
      if (existing.operation !== name || existing.fingerprint !== fingerprint) throw new DomainError('operation_conflict', 'Operation ID was already used with different arguments.');
      if (this.inflight.has(operationKey)) return this.inflight.get(operationKey);
      if (existing.result.pending) throw new DomainError('outcome_unknown', 'This operation was interrupted. Inspect its result before creating a new operation.');
      if (existing.result.error) throw new DomainError(existing.result.error.code, existing.result.error.message);
      return existing.result.value;
    }
    this.store.saveOperation(operationKey, name, fingerprint, { pending: true });
    const work = this.invoke(operation, args, context).then(result => {
      this.store.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify({ value: result }), operationKey);
      return result;
    }, error => {
      // A failure is not a result to replay: forget the receipt so the same request can be tried again.
      this.store.db.prepare('DELETE FROM operations WHERE id=?').run(operationKey);
      throw error;
    }).finally(() => this.inflight.delete(operationKey));
    this.inflight.set(operationKey, work);
    return work;
  }

  registerOperations() {
    defineOperations(this, this.register.bind(this));
  }

  projectOverview(projectId) { return projectOverview(this, projectId); }
  doctor() { return doctor(this); }
  snapshot(input, context) { return snapshot(this, input, context); }

  // Bound what accumulates: old journal entries, idempotency receipts and file versions.
  maintain() {
    const retentionMs = this.config.retentionDays * 86400000;
    pruneHistory(path.join(this.instanceRoot, 'history'), retentionMs);
    // A job whose process was never confirmed to have ended still holds its project; its record is not history yet.
    return this.store.prune({ olderThanMs: retentionMs, keep: this.jobs?.retained() || [] });
  }

  // Asking how the connection is doing never fails the question that needed to know.
  async connectionState() {
    if (!this.connection) return { kind: 'local', status: 'ready' };
    try { return await this.connection.status(); }
    catch (error) { return { kind: this.config.connection.kind, phase: 'unknown', error: { code: error.code || 'status_failed', message: error.message } }; }
  }

  // How one coding agent is run: its configuration, then what was changed while the runtime ran.
  applyProviderSettings(name, live = (this.store.setting('providers.live') || {})[name] || {}) {
    let checked;
    try { checked = checkProviderSettings(name, { ...(this.config.providers[name] || {}), ...live }); }
    catch (error) { throw error.name === 'ZodError' ? new DomainError('invalid_input', 'Invalid settings for ' + name + ': ' + readable(error)) : error; }
    this.agents.providerSettings = { ...this.agents.providerSettings, [name]: checked };
    return checked;
  }
  // A null value takes a change back. Sessions that are already connected keep what they were started with.
  configureProvider(name, patch) {
    const all = { ...(this.store.setting('providers.live') || {}) }, live = { ...(all[name] || {}) };
    for (const [key, value] of Object.entries(patch)) { if (value === null) delete live[key]; else live[key] = value; }
    const settings = this.applyProviderSettings(name, live);
    if (Object.keys(live).length) all[name] = live; else delete all[name];
    this.store.setting('providers.live', all);
    this.providerDiscovery = null;
    return { provider: name, settings, changed: live };
  }

  // The public MCP address right now: the configured one, or the one a quick tunnel currently holds.
  publicUrl() { return publicMcpUrl(this.config) || this.connection?.publicUrl?.() || null; }

  async verifyConnection() {
    const kind = this.config.connection.kind, url = this.publicUrl(), checkedAt = now();
    if (!url) {
      this.verification = { kind, checkedAt, verified: false, reachable: false, reason: kind === 'openai-tunnel'
        ? 'An OpenAI tunnel has no public URL to probe. Confirm it by calling a DevMate tool from ChatGPT.'
        : kind === 'cloudflare-quick' ? 'The quick tunnel has not been given its address yet.' : 'No public connection is configured.' };
      return this.verification;
    }
    // With sign-in enabled the runtime signs itself in with a token that lives only for this check.
    let accessToken;
    if (this.config.auth.mode === 'oauth') {
      try { accessToken = this.auth.issueVerificationToken({ ttlSeconds: 60 }).accessToken; } catch {}
    }
    const result = await this.verifier({ url, authMode: this.config.auth.mode, expectedGeneration: this.identity?.generation, ...(accessToken ? { accessToken } : {}),
      ...(kind === 'cloudflare-quick' ? { newAddress: true } : {}) });
    const changed = this.verification?.verified !== result.verified || this.verification?.reachable !== result.reachable;
    this.verification = { kind, url, checkedAt, ...result };
    // The route is checked again and again; only a change is news.
    if (changed && !this.closing) this.store.event('connection.verified', null, { verified: result.verified, reachable: result.reachable });
    return this.verification;
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    await this.ready.catch(() => {});
    clearInterval(this.maintenanceTimer);
    this.execution.abort(new DomainError('runtime_stopping', 'Runtime is stopping.'));
    this.inputs.close();
    const results = await Promise.allSettled([this.agents.close(), this.jobs?.close(), this.capabilities?.close(), this.hosts?.close(), this.auth?.close()]);
    // Jobs run through the process manager, so it closes after they have settled.
    results.push(...await Promise.allSettled([this.processes.close()]));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned execution resources have not all stopped.');
    await Promise.allSettled([...this.activeCalls, ...this.inflight.values()]);
    this.store.close();
    this.closed = true;
  }
}
