import crypto from 'node:crypto';

export const TEAM_ROLES = Object.freeze(['observer', 'reviewer', 'developer', 'maintainer', 'owner']);

const ROLE_CAPABILITIES = Object.freeze({
  observer: new Set(['read']),
  reviewer: new Set(['read', 'validate']),
  developer: new Set(['read', 'validate', 'write', 'execute', 'git']),
  maintainer: new Set(['read', 'validate', 'write', 'execute', 'git', 'publish', 'admin']),
  owner: new Set(['*'])
});

const ADMIN_TOOLS = new Set([
  'team_configure', 'team_member_list', 'team_member_create', 'team_member_update', 'team_member_rotate', 'team_member_revoke', 'team_activity_status',
  'read_audit_log', 'list_backups', 'task_status', 'task_report', 'start_task', 'finish_task', 'rollback_task', 'local_capabilities_status', 'list_trusted_roots',
  'plugin_enable', 'plugin_disable', 'plugin_configure', 'configure_local_capabilities', 'published_preview_list',
  'add_trusted_root', 'remove_trusted_root',
  'job_runtime_configure', 'deployment_drain_start', 'deployment_drain_cancel',
  'runner_control_configure', 'runner_credential_list', 'runner_credential_create', 'runner_credential_update', 'runner_credential_rotate', 'runner_credential_revoke'
]);
const OWNER_ONLY_TOOLS = new Set([
  'team_configure', 'team_member_list', 'team_member_create', 'team_member_update', 'team_member_rotate', 'team_member_revoke',
  'runner_control_configure', 'runner_credential_list', 'runner_credential_create', 'runner_credential_update', 'runner_credential_rotate', 'runner_credential_revoke'
]);
const PUBLISH_TOOLS = new Set(['git_push', 'git_pull', 'deployment_publish', 'deployment_rotate_credentials', 'published_preview_share', 'published_preview_revoke']);
const VALIDATE_TOOLS = new Set([
  'run_smart_checks', 'job_submit', 'job_retry',
  'browser_qa_run', 'browser_qa_run_saved', 'web_preview_start', 'web_preview_stop',
  'godot_doctor', 'godot_validate', 'godot_export_web', 'godot_acceptance_test',
  'godot_acceptance_run_saved', 'godot_acceptance_suite'
]);
const EXECUTE_TOOLS = new Set([
  'run_command', 'start_process', 'send_process_input', 'stop_process', 'godot_run'
]);
const WRITE_TOOLS = new Set([
  'write_file', 'create_file', 'apply_patch',
  'delete_file', 'move_file', 'restore_backup', 'godot_qa_bridge_install', 'job_cancel'
]);

const NON_WORKSPACE_TOOLS = new Set([
  'gateway_status', 'gateway_self_test', 'maintenance_status', 'connection_diagnostics', 'devmate_status_panel', 'devmate_team_panel', 'list_workspaces',
  'plugin_catalog', 'plugin_diagnostics', 'plugin_enable', 'plugin_disable', 'plugin_configure', 'devmate_plugins_panel',
  'team_status', 'team_member_list', 'team_member_create', 'team_member_update', 'team_member_rotate', 'team_member_revoke',
  'team_activity_status', 'team_configure', 'deployment_status', 'deployment_readiness', 'deployment_policy_template',
  'workspace_lease_status', 'published_preview_share', 'published_preview_list', 'published_preview_revoke',
  'job_target_catalog', 'job_runtime_configure', 'job_submit', 'job_list', 'job_status', 'job_artifacts', 'job_cancel', 'job_retry', 'runner_status',
  'deployment_drain_status', 'deployment_drain_start', 'deployment_drain_cancel',
  'runner_control_status', 'runner_control_configure', 'runner_credential_list', 'runner_credential_create', 'runner_credential_update', 'runner_credential_rotate', 'runner_credential_revoke'
]);

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cleanId(value, fallback = 'member') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function parseExpiry(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('expiresAt must be a valid ISO date-time');
  return new Date(time).toISOString();
}

export function normalizeDeploymentConfig(config) {
  config.deployment ||= {};
  const mode = ['personal', 'team', 'production'].includes(config.deployment.mode) ? config.deployment.mode : 'personal';
  config.deployment.mode = mode;
  config.deployment.tunnelProvider ||= 'ngrok';
  config.deployment.publicUrl ||= '';

  config.team ||= {};
  config.team.enabled = mode !== 'personal';
  if (!Array.isArray(config.team.members)) config.team.members = [];
  config.team.requireWorkspaceLeaseForWrites = config.team.requireWorkspaceLeaseForWrites ?? (mode !== 'personal');
  config.team.defaultMemberRole = TEAM_ROLES.includes(config.team.defaultMemberRole) ? config.team.defaultMemberRole : 'developer';
  config.team.maxMembers = Number.isFinite(Number(config.team.maxMembers))
    ? Math.min(500, Math.max(1, Math.trunc(Number(config.team.maxMembers))))
    : 100;

  config.runtime ||= {};
  config.runtime.maxConcurrentJobs = clampInt(config.runtime.maxConcurrentJobs, 2, 1, 8);
  config.jobs ||= {};
  config.jobs.allowJobGitSave = config.jobs.allowJobGitSave !== false;
  config.jobs.embeddedRunnerEnabled = config.jobs.embeddedRunnerEnabled !== false;

  config.production ||= {};
  config.production.maxRequestBytes = clampInt(config.production.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024);
  config.production.requestsPerMinute = clampInt(config.production.requestsPerMinute, mode === 'production' ? 120 : 600, 10, 10000);
  config.production.maxConcurrentRequests = clampInt(config.production.maxConcurrentRequests, mode === 'production' ? 24 : 64, 1, 256);
  config.production.maxConcurrentPerPrincipal = clampInt(config.production.maxConcurrentPerPrincipal, mode === 'production' ? 4 : 16, 1, 64);
  config.production.requestTimeoutMs = clampInt(config.production.requestTimeoutMs, 15 * 60 * 1000, 1000, 60 * 60 * 1000);
  if (!Array.isArray(config.production.allowedHosts)) config.production.allowedHosts = [];
  config.production.allowedHosts = [...new Set(config.production.allowedHosts.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  return config;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function roleCapabilities(role) {
  const normalized = TEAM_ROLES.includes(role) ? role : 'observer';
  return ROLE_CAPABILITIES[normalized];
}

export function roleAllows(role, capability) {
  const capabilities = roleCapabilities(role);
  return capabilities.has('*') || capabilities.has(capability);
}

export function memberPublic(member) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: Array.isArray(member.workspaceIds) ? member.workspaceIds : [],
    createdAt: member.createdAt || null,
    updatedAt: member.updatedAt || null,
    expiresAt: member.expiresAt || null,
    disabled: !!member.disabled,
    lastUsedAt: member.lastUsedAt || null,
    tokenVersion: member.tokenVersion || 1
  };
}

function hashSecret(secret, salt) {
  return base64url(crypto.scryptSync(String(secret), Buffer.from(salt, 'base64url'), 32));
}

function uniqueMemberId(config, requested = '') {
  const base = cleanId(requested || `member-${crypto.randomBytes(3).toString('hex')}`);
  const used = new Set((config.team?.members || []).map(member => member.id));
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  return id;
}

export function createTeamMember(config, input = {}) {
  normalizeDeploymentConfig(config);
  if (config.team.members.length >= config.team.maxMembers) throw new Error(`Team member limit reached (${config.team.maxMembers})`);
  const role = TEAM_ROLES.includes(input.role) ? input.role : config.team.defaultMemberRole;
  const id = uniqueMemberId(config, input.id || input.name);
  const secret = base64url(crypto.randomBytes(32));
  const salt = base64url(crypto.randomBytes(16));
  const now = new Date().toISOString();
  const member = {
    id,
    name: String(input.name || id).trim().slice(0, 200) || id,
    role,
    workspaceIds: [...new Set((input.workspaceIds || []).map(value => String(value || '').trim()).filter(Boolean))],
    salt,
    tokenHash: hashSecret(secret, salt),
    tokenVersion: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: parseExpiry(input.expiresAt),
    disabled: false,
    lastUsedAt: null
  };
  config.team.members.push(member);
  return { member: memberPublic(member), token: `dmt_${id}_${secret}` };
}

export function rotateTeamMemberToken(config, id) {
  normalizeDeploymentConfig(config);
  const member = config.team.members.find(item => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  const secret = base64url(crypto.randomBytes(32));
  const salt = base64url(crypto.randomBytes(16));
  member.salt = salt;
  member.tokenHash = hashSecret(secret, salt);
  member.tokenVersion = (member.tokenVersion || 1) + 1;
  member.updatedAt = new Date().toISOString();
  member.disabled = false;
  return { member: memberPublic(member), token: `dmt_${member.id}_${secret}` };
}

export function updateTeamMember(config, id, patch = {}) {
  normalizeDeploymentConfig(config);
  const member = config.team.members.find(item => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  if (patch.name !== undefined) member.name = String(patch.name || '').trim().slice(0, 200) || member.id;
  if (patch.role !== undefined) {
    if (!TEAM_ROLES.includes(patch.role)) throw new Error(`Unknown team role: ${patch.role}`);
    member.role = patch.role;
  }
  if (patch.workspaceIds !== undefined) {
    if (!Array.isArray(patch.workspaceIds)) throw new Error('workspaceIds must be an array');
    member.workspaceIds = [...new Set(patch.workspaceIds.map(value => String(value || '').trim()).filter(Boolean))];
  }
  if (patch.expiresAt !== undefined) member.expiresAt = parseExpiry(patch.expiresAt);
  if (patch.disabled !== undefined) member.disabled = !!patch.disabled;
  member.updatedAt = new Date().toISOString();
  return memberPublic(member);
}

export function revokeTeamMember(config, id) {
  normalizeDeploymentConfig(config);
  const member = config.team.members.find(item => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  member.disabled = true;
  member.updatedAt = new Date().toISOString();
  return memberPublic(member);
}

function parseTeamToken(token) {
  const match = String(token || '').match(/^dmt_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}

export function verifyAccessToken(token, config, { updateLastUsed = false } = {}) {
  normalizeDeploymentConfig(config);
  const raw = String(token || '').trim();
  if (config.auth?.token && timingSafeEqualText(raw, config.auth.token)) {
    return {
      id: 'personal-owner',
      name: 'Personal owner',
      role: 'owner',
      workspaceIds: [],
      source: 'personal-token',
      tokenVersion: 1
    };
  }
  if (!config.team.enabled) return null;
  const parsed = parseTeamToken(raw);
  if (!parsed) return null;
  const member = config.team.members.find(item => item.id === parsed.id);
  if (!member || member.disabled || !member.salt || !member.tokenHash) return null;
  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) return null;
  const candidate = hashSecret(parsed.secret, member.salt);
  if (!timingSafeEqualText(candidate, member.tokenHash)) return null;
  if (updateLastUsed) member.lastUsedAt = new Date().toISOString();
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: Array.isArray(member.workspaceIds) ? member.workspaceIds : [],
    source: 'team-token',
    tokenVersion: member.tokenVersion || 1
  };
}

export function extractRequestToken(req, url) {
  const authorization = String(req?.headers?.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || req?.headers?.['x-devmate-token'] || url?.searchParams?.get('token') || '';
}

export function fallbackLocalPrincipal() {
  return { id: 'local-owner', name: 'Local owner', role: 'owner', workspaceIds: [], source: 'local' };
}

export function requiredCapabilityForTool(name, annotations = {}, args = {}) {
  if (OWNER_ONLY_TOOLS.has(name) || ADMIN_TOOLS.has(name)) return 'admin';
  if (name === 'git_save' && args?.push) return 'publish';
  if (name === 'git_raw') {
    const first = String(args?.args?.[0] || '').toLowerCase();
    return ['push', 'pull', 'fetch', 'remote'].includes(first) ? 'publish' : 'git';
  }
  if (PUBLISH_TOOLS.has(name)) return 'publish';
  if (name.startsWith('git_')) return 'git';
  if (VALIDATE_TOOLS.has(name) || name.startsWith('automation_')) return 'validate';
  if (EXECUTE_TOOLS.has(name)) return 'execute';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true) return 'write';
  return 'read';
}

export function toolWorkspaceId(name, args, config) {
  if (NON_WORKSPACE_TOOLS.has(name) || name.startsWith('team_') || name.startsWith('deployment_') || name.startsWith('runner_')) return null;
  const explicit = String(args?.workspaceId || '').trim();
  if (explicit) return config.workspaces?.find(item => item.id === explicit || item.name === explicit)?.id || explicit;
  return config.activeWorkspaceId || null;
}

function dangerousCommand(command) {
  const value = String(command || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(value) ||
    /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(value) ||
    /\brmdir\b.*\s\/s\b/.test(value) || /\bdel\b.*\s\/s\b/.test(value) ||
    /\bformat\b\s+[a-z]:/.test(value) || /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(value) ||
    /\bgit\s+reset\b.*--hard\b/.test(value) || /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(value) ||
    /\bgit\s+push\b.*--force(?:-with-lease)?\b/.test(value);
}

function assertTeamOperationSafety(name, args, principal) {
  if (principal?.source !== 'team-token') return;
  if ((name === 'run_command' || name === 'start_process') && dangerousCommand(args?.command)) {
    throw new Error(`Team token ${principal.id} cannot run a high-risk command through ${name}`);
  }
  if (name === 'git_push' && (args?.force || args?.forceWithLease)) {
    throw new Error('Force push is reserved for the local/personal owner token');
  }
  if (name === 'git_branch' && args?.action === 'delete' && args?.force) {
    throw new Error('Forced branch deletion is reserved for the local/personal owner token');
  }
  if (name === 'git_raw') {
    const values = (args?.args || []).map(value => String(value).toLowerCase());
    const joined = values.join(' ');
    if ((values[0] === 'reset' && values.includes('--hard')) || values[0] === 'clean' ||
      (values[0] === 'push' && /(?:^| )--force(?:-with-lease)?(?: |$)/.test(joined))) {
      throw new Error('High-risk raw Git operations are reserved for the local/personal owner token');
    }
  }
}

export function authorizeToolCall({ name, annotations, args, config, principal }) {
  normalizeDeploymentConfig(config);
  const effectivePrincipal = principal || fallbackLocalPrincipal();
  const capability = requiredCapabilityForTool(name, annotations, args);
  assertTeamOperationSafety(name, args, effectivePrincipal);
  if (OWNER_ONLY_TOOLS.has(name) && effectivePrincipal.role !== 'owner') {
    throw new Error(`Tool ${name} requires the owner role`);
  }
  if (!roleAllows(effectivePrincipal.role, capability)) {
    throw new Error(`Role ${effectivePrincipal.role} cannot use ${name}; required capability: ${capability}`);
  }
  const workspaceId = toolWorkspaceId(name, args, config);
  if (workspaceId && effectivePrincipal.workspaceIds?.length && !effectivePrincipal.workspaceIds.includes(workspaceId)) {
    throw new Error(`Principal ${effectivePrincipal.id} is not allowed to access workspace ${workspaceId}`);
  }
  return { principal: effectivePrincipal, capability, workspaceId };
}

export const __test = {
  ROLE_CAPABILITIES,
  dangerousCommand,
  hashSecret,
  parseTeamToken,
  requiredCapabilityForTool,
  timingSafeEqualText,
  toolWorkspaceId
};
