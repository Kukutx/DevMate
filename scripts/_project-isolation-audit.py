from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing replacement target: {label}")
    p.write_text(s.replace(old, new, 1))


p = Path("gateway/conversation-workspaces.mjs")
s = p.read_text()
s = s.replace("export const CONVERSATION_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;\n", "")
s = s.replace(
    "    updatedAt: timestamp,\n    expiresAt: new Date(now + CONVERSATION_BINDING_TTL_MS).toISOString()",
    "    updatedAt: timestamp"
)
s = s.replace("  const expires = Date.parse(value.expiresAt || '');\n  if (!Number.isFinite(expires)) return null;\n", "")
s = s.replace(
    "    updatedAt: value.updatedAt || null,\n    expiresAt: new Date(expires).toISOString()",
    "    updatedAt: value.updatedAt || null"
)
s = s.replace(
    "    if (!binding || Date.parse(binding.expiresAt) <= now) continue;",
    "    if (!binding) continue;"
)
s = s.replace("    binding.expiresAt = new Date(now + CONVERSATION_BINDING_TTL_MS).toISOString();\n", "")
s = s.replace(
    "    source: binding.source,\n    expiresAt: binding.expiresAt",
    "    source: binding.source"
)
p.write_text(s)

replace_once(
    "gateway/team-capabilities.mjs",
    """  bindConversationWorkspaceToWorkspace,
  conversationWorkspace
} from './conversation-workspaces.mjs';""",
    """  bindConversationWorkspaceToWorkspace,
  conversationWorkspace,
  conversationWorkspaceBinding
} from './conversation-workspaces.mjs';""",
    "team-capabilities conversation binding import",
)
replace_once(
    "gateway/team-capabilities.mjs",
    "function prepareConversationWorkspace(name, args, current) {",
    """function refreshConversationBinding(scope, current) {
  const stored = conversationWorkspaceBinding(current, scope);
  if (!stored) return current;
  const updatedAt = Date.parse(stored.updatedAt || stored.createdAt || '');
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 24 * 60 * 60 * 1000) return current;
  mutateConfig(config => {
    normalizeInstanceConfig(config);
    conversationWorkspaceBinding(config, scope, { touch: true });
    return config;
  }, { retries: 4 });
  return normalizeInstanceConfig(readConfig());
}

function prepareConversationWorkspace(name, args, current) {""",
    "team-capabilities binding refresh helper",
)
replace_once(
    "gateway/team-capabilities.mjs",
    """  if (!binding) throw new Error('No workspace configured');

  if (authorizationArgs.workspaceId) {""",
    """  if (!binding) throw new Error('No workspace configured');
  current = refreshConversationBinding(scope, current);
  binding = conversationWorkspace(current, scope);
  if (!binding) throw new Error('No workspace configured');

  if (authorizationArgs.workspaceId) {""",
    "team-capabilities binding refresh use",
)

replace_once(
    "gateway/team-collaboration-tools.mjs",
    """import {
  bindConversationWorkspaceToPath,
  bindConversationWorkspaceToWorkspace,
  clearConversationWorkspaceBinding,
  publicConversationWorkspaceBinding
} from './conversation-workspaces.mjs';""",
    """import {
  assertConversationWorkspaceMatch,
  bindConversationWorkspaceToPath,
  bindConversationWorkspaceToWorkspace,
  clearConversationWorkspaceBinding,
  conversationWorkspace,
  publicConversationWorkspaceBinding
} from './conversation-workspaces.mjs';""",
    "team-collaboration imports",
)
replace_once(
    "gateway/team-collaboration-tools.mjs",
    "function bindWorkspace(input) {",
    """function defaultConversationWorkspace(config) {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  return workspaces.find(item => item?.id === config?.activeWorkspaceId && !item.reference && item.mode !== 'readonly')
    || workspaces.find(item => item && !item.reference && item.mode !== 'readonly')
    || workspaces[0]
    || null;
}

function selectedConversationProject(requested = '') {
  const scope = requestConversationScope();
  let config = normalizeInstanceConfig(readConfig());
  if (!scope) return { config, scope: null, workspace: null };

  let workspace = conversationWorkspace(config, scope);
  if (!workspace) {
    const fallback = defaultConversationWorkspace(config);
    if (!fallback) throw new Error('No workspace configured');
    mutateConfig(current => {
      normalizeInstanceConfig(current);
      if (!conversationWorkspace(current, scope)) {
        bindConversationWorkspaceToWorkspace(current, scope, fallback, { source: 'default' });
      }
      return current;
    }, { retries: 4 });
    config = normalizeInstanceConfig(readConfig());
    workspace = conversationWorkspace(config, scope);
  }

  if (!workspace) throw new Error('No workspace configured');
  if (requested) {
    const candidate = resolveWorkspace(config, requested);
    assertConversationWorkspaceMatch(config, scope, candidate);
  }
  return { config, scope, workspace };
}

function bindWorkspace(input) {""",
    "team-collaboration selected project helper",
)
p = Path("gateway/team-collaboration-tools.mjs")
s = p.read_text()
s = s.replace("        source: binding.source,\n        expiresAt: binding.expiresAt", "        source: binding.source", 1)
s = s.replace("      workspaceId: z.string().min(1),\n      title:", "      workspaceId: z.string().min(1).optional(),\n      title:", 1)
s = s.replace(
    """    const config = normalizeInstanceConfig(readConfig());
    const principal = principalNow();
    const workspace = resolveWorkspace(config, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, 'start a session for');""",
    """    const selected = selectedConversationProject(input.workspaceId);
    const config = selected.config;
    const principal = principalNow();
    const workspace = selected.scope ? selected.workspace : resolveWorkspace(config, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, 'start a session for');""",
    1
)
old = """  }, async ({ id, workspaceId, all = false }) => {
    const principal = principalNow();
    const config = normalizeInstanceConfig(readConfig());
    if (id) {
      const item = workSession(id);
      if (!item) return toolText({ session: null });
      assertVisibleWorkspace(principal, item.workspaceId);"""
new = """  }, async ({ id, workspaceId, all = false }) => {
    const principal = principalNow();
    const selected = selectedConversationProject(workspaceId);
    const config = selected.config;
    if (id) {
      const item = workSession(id);
      if (!item) return toolText({ session: null });
      if (selected.scope && item.workspaceId !== selected.workspace.id) {
        throw new Error(`Work session ${id} belongs to a different project workspace`);
      }
      assertVisibleWorkspace(principal, item.workspaceId);"""
if old not in s:
    raise SystemExit("missing replacement target: work session status header")
s = s.replace(old, new, 1)
s = s.replace(
    "    const resolvedWorkspaceId = workspaceId ? resolveWorkspace(config, workspaceId).id : undefined;",
    "    const resolvedWorkspaceId = selected.scope ? selected.workspace.id : (workspaceId ? resolveWorkspace(config, workspaceId).id : undefined);",
    1
)
s = s.replace(
    """  }, async ({ id, force = false, releaseLease = true }) => {
    const principal = principalNow();
    const result = finishWorkSession({ id, principal, force, releaseLease });""",
    """  }, async ({ id, force = false, releaseLease = true }) => {
    const principal = principalNow();
    const selected = selectedConversationProject();
    const item = workSession(id);
    if (selected.scope && item && item.workspaceId !== selected.workspace.id) {
      throw new Error(`Work session ${id} belongs to a different project workspace`);
    }
    const result = finishWorkSession({ id, principal, force, releaseLease });""",
    1
)
s = s.replace(
    """  }, async ({ workSessionId, dryRun = false, force = false, limit = 1000 }) => {
    const principal = principalNow();
    return toolText(await rollbackWorkSession({ workSessionId, principal, dryRun, force, limit }));""",
    """  }, async ({ workSessionId, dryRun = false, force = false, limit = 1000 }) => {
    const principal = principalNow();
    const selected = selectedConversationProject();
    const item = workSession(workSessionId);
    if (selected.scope && item && item.workspaceId !== selected.workspace.id) {
      throw new Error(`Work session ${workSessionId} belongs to a different project workspace`);
    }
    return toolText(await rollbackWorkSession({ workSessionId, principal, dryRun, force, limit }));""",
    1
)
s = s.replace(
    """    const config = normalizeInstanceConfig(readConfig());
    const principal = principalNow();
    const preview = getPreview(input.previewId);
    assertVisibleWorkspace(principal, preview.workspaceId, 'publish');""",
    """    const selected = selectedConversationProject();
    const config = selected.config;
    const principal = principalNow();
    const preview = getPreview(input.previewId);
    if (selected.scope && preview.workspaceId !== selected.workspace.id) {
      throw new Error(`Preview ${input.previewId} belongs to a different project workspace`);
    }
    assertVisibleWorkspace(principal, preview.workspaceId, 'publish');""",
    1
)
s = s.replace(
    """  }, async filters => {
    const principal = principalNow();
    let items = listPreviewShares(filters);""",
    """  }, async filters => {
    const principal = principalNow();
    const selected = selectedConversationProject(filters.workspaceId);
    const effectiveFilters = selected.scope ? { ...filters, workspaceId: selected.workspace.id } : filters;
    let items = listPreviewShares(effectiveFilters);""",
    1
)
s = s.replace(
    """  }, async ({ id }) => {
    const principal = principalNow();
    const item = listPreviewShares().find(value => value.id === id);
    if (item) assertVisibleWorkspace(principal, item.workspaceId, 'revoke a share for');""",
    """  }, async ({ id }) => {
    const principal = principalNow();
    const selected = selectedConversationProject();
    const item = listPreviewShares().find(value => value.id === id);
    if (selected.scope && item && item.workspaceId !== selected.workspace.id) {
      throw new Error(`Published preview ${id} belongs to a different project workspace`);
    }
    if (item) assertVisibleWorkspace(principal, item.workspaceId, 'revoke a share for');""",
    1
)
s = s.replace(
    """  }, async ({ workspaceId }) => {
    const principal = principalNow();
    const config = normalizeInstanceConfig(readConfig());
    const resolvedWorkspaceId = workspaceId ? resolveWorkspace(config, workspaceId).id : undefined;""",
    """  }, async ({ workspaceId }) => {
    const principal = principalNow();
    const selected = selectedConversationProject(workspaceId);
    const config = selected.config;
    const resolvedWorkspaceId = selected.scope ? selected.workspace.id : (workspaceId ? resolveWorkspace(config, workspaceId).id : undefined);""",
    1
)
p.write_text(s)

replace_once(
    "gateway/job-tools.mjs",
    """import { audit, readConfig, toolText, writeConfig } from './local-shared.mjs';
import { conversationWorkspace } from './conversation-workspaces.mjs';""",
    """import { audit, mutateConfig, readConfig, toolText, writeConfig } from './local-shared.mjs';
import {
  assertConversationWorkspaceMatch,
  bindConversationWorkspaceToWorkspace,
  conversationWorkspace
} from './conversation-workspaces.mjs';
import { requestConversationScope } from './request-context.mjs';""",
    "job imports",
)
replace_once(
    "gateway/job-tools.mjs",
    "import { principalNow } from './team-tool-data.mjs';",
    "import { principalNow } from './team-tool-data.mjs';\nimport { resolveWorkspace } from './workspace-resolver.mjs';",
    "job resolver import",
)
p = Path("gateway/job-tools.mjs")
s = p.read_text()
start = s.index("function currentProjectWorkspaceId()")
end = s.index("function ensureVisible(", start)
helper = """function defaultConversationWorkspace(config) {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  return workspaces.find(item => item?.id === config?.activeWorkspaceId && !item.reference && item.mode !== 'readonly')
    || workspaces.find(item => item && !item.reference && item.mode !== 'readonly')
    || workspaces[0]
    || null;
}

function selectedConversationProject(requested = '') {
  const scope = requestConversationScope();
  if (!scope) return { scope: null, workspace: null };

  let config = normalizeInstanceConfig(readConfig());
  let workspace = conversationWorkspace(config, scope);
  if (!workspace) {
    const fallback = defaultConversationWorkspace(config);
    if (!fallback) throw new Error('No workspace configured');
    mutateConfig(current => {
      normalizeInstanceConfig(current);
      if (!conversationWorkspace(current, scope)) {
        bindConversationWorkspaceToWorkspace(current, scope, fallback, { source: 'default' });
      }
      return current;
    }, { retries: 4 });
    config = normalizeInstanceConfig(readConfig());
    workspace = conversationWorkspace(config, scope);
  }

  if (!workspace) throw new Error('No workspace configured');
  if (requested) {
    const candidate = resolveWorkspace(config, requested);
    assertConversationWorkspaceMatch(config, scope, candidate);
  }
  return { scope, workspace };
}

function selectedJobWorkspaceId(requested = '') {
  const selected = selectedConversationProject(requested);
  return selected.scope ? selected.workspace.id : String(requested || '').trim() || null;
}

function ensureCurrentProjectJob(job, requested = '') {
  const selected = selectedConversationProject(requested);
  if (selected.scope && job.workspaceId && job.workspaceId !== selected.workspace.id) {
    throw new Error(`Job ${job.id} belongs to a different project workspace`);
  }
  return job;
}

"""
s = s[:start] + helper + s[end:]
s = s.replace(
    "    const args = withWorkspace(rawArgs, workspaceId || currentProjectWorkspaceId());",
    """    const scope = requestConversationScope();
    const args = scope
      ? { ...rawArgs, workspaceId: selectedJobWorkspaceId(workspaceId || rawArgs.workspaceId) }
      : withWorkspace(rawArgs, workspaceId);""",
    1
)
s = s.replace(
    """  }, async ({ status, workspaceId, limit = 100 }) => toolText({
    jobs: listJobs({ principal: principalNow(), status, workspaceId: workspaceId || currentProjectWorkspaceId(), limit })
  }));""",
    """  }, async ({ status, workspaceId, limit = 100 }) => {
    const effectiveWorkspaceId = requestConversationScope() ? selectedJobWorkspaceId(workspaceId) : workspaceId;
    return toolText({ jobs: listJobs({ principal: principalNow(), status, workspaceId: effectiveWorkspaceId, limit }) });
  });""",
    1
)
s = s.replace(
    """  }, async ({ id, includeArguments = false, includeResult = true }) => {
    const principal = principalNow();
    return toolText({ job: ensureCurrentProjectJob(ensureVisible(getJob(id, { includeArguments, includeResult }), principal)) });""",
    """  }, async ({ id, workspaceId, includeArguments = false, includeResult = true }) => {
    const principal = principalNow();
    return toolText({ job: ensureCurrentProjectJob(ensureVisible(getJob(id, { includeArguments, includeResult }), principal), workspaceId) });""",
    1
)
s = s.replace(
    """  }, async ({ id }) => {
    const principal = principalNow();
    const job = ensureCurrentProjectJob(ensureVisible(getJob(id), principal));""",
    """  }, async ({ id, workspaceId }) => {
    const principal = principalNow();
    const job = ensureCurrentProjectJob(ensureVisible(getJob(id), principal), workspaceId);""",
    1
)
s = s.replace(
    """  }, async ({ id, force = false }) => {
    const principal = principalNow();
    ensureCurrentProjectJob(ensureVisible(getJob(id), principal));""",
    """  }, async ({ id, workspaceId, force = false }) => {
    const principal = principalNow();
    ensureCurrentProjectJob(ensureVisible(getJob(id), principal), workspaceId);""",
    1
)
s = s.replace(
    """  }, async ({ id }) => {
    const principal = principalNow();
    const existing = ensureCurrentProjectJob(ensureVisible(getJob(id, { includeArguments: true }), principal));""",
    """  }, async ({ id, workspaceId }) => {
    const principal = principalNow();
    const existing = ensureCurrentProjectJob(ensureVisible(getJob(id, { includeArguments: true }), principal), workspaceId);""",
    1
)
p.write_text(s)

p = Path("tests/conversation-workspace-isolation.test.mjs")
s = p.read_text()
s = s.replace(
    "import { bindConversationWorkspaceToPath } from '../gateway/conversation-workspaces.mjs';",
    "import { bindConversationWorkspaceToPath, conversationWorkspaceBinding, pruneConversationWorkspaceBindings } from '../gateway/conversation-workspaces.mjs';",
)
s += """

test('project selection does not expire just because a conversation is old', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-stable-project-'));
  const config = { activeWorkspaceId: 'app', workspaces: [{ id: 'app', name: 'App', root, mode: 'workspace-write', reference: false }] };
  bindConversationWorkspaceToPath(config, scopeA, root, { allowExternalWrite: true, now: 0 });
  pruneConversationWorkspaceBindings(config, 365 * 24 * 60 * 60 * 1000);
  assert.equal(conversationWorkspaceBinding(config, scopeA)?.workspaceId, 'app');
});

test('project resource fences do not restore conversation ownership locks', () => {
  const capabilitySource = fs.readFileSync(new URL('../gateway/team-capabilities.mjs', import.meta.url), 'utf8');
  const collaborationSource = fs.readFileSync(new URL('../gateway/team-collaboration-tools.mjs', import.meta.url), 'utf8');
  const jobSource = fs.readFileSync(new URL('../gateway/job-tools.mjs', import.meta.url), 'utf8');
  const combined = capabilitySource + collaborationSource + jobSource;
  assert.doesNotMatch(combined, /conversation_resource_conflict|work_session_conversation_conflict|conversation_workspace_durable_job_unsafe|belongs to another ChatGPT conversation|must deliberately bind/);
  assert.match(collaborationSource, /different project workspace/);
  assert.match(jobSource, /different project workspace/);
});
"""
p.write_text(s)

p = Path("CHANGELOG.md")
s = p.read_text()
if "## 3.6.5" not in s:
    s = s.replace(
        "# Changelog\n",
        "# Changelog\n\n## 3.6.5\n- Kept each ChatGPT conversation on its selected project across long gaps and reconnects without expiring the project choice.\n- Applied the same project boundary to sessions, leases, previews, and jobs while keeping same-project records shareable across conversations.\n",
        1,
    )
p.write_text(s)
