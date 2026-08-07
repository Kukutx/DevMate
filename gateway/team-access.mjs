import crypto from 'node:crypto';
import { uniqueCredentialId } from './credential-id.mjs';
import {
  ownerOnlyTool,
  requiredCapabilityForTool,
  toolWorkspaceId
} from './tool-policy.mjs';
import {
  defaultedArray,
  defaultedBoolean,
  defaultedEnum,
  defaultedInteger
} from './strict-config.mjs';

export { requiredCapabilityForTool, toolWorkspaceId } from './tool-policy.mjs';

export const TEAM_ROLES = Object.freeze(['observer', 'reviewer', 'developer', 'maintainer', 'owner']);
export const DEPLOYMENT_MODES = Object.freeze(['personal', 'team', 'production']);
export const TUNNEL_PROVIDERS = Object.freeze(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);

const ROLE_CAPABILITIES = Object.freeze({
  observer: new Set(['read']),
  reviewer: new Set(['read', 'validate']),
  developer: new Set(['read', 'validate', 'write', 'execute', 'git']),
  maintainer: new Set(['read', 'validate', 'write', 'execute', 'git', 'publish', 'admin']),
  owner: new Set(['*'])
});

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('expiresAt must be a valid ISO date-time');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('expiresAt must be a valid ISO date-time');
  return new Date(time).toISOString();
}

function objectField(config, key) {
  if (config[key] === undefined) config[key] = {};
  if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) {
    throw new TypeError(`${key} must be an object`);
  }
  return config[key];
}

function stringList(value, label) {
  const items = defaultedArray(value, [], label);
  return [...new Set(items.map(item => {
    if (typeof item !== 'string') throw new TypeError(`${label} must contain only strings`);
    return item.trim();
  }).filter(Boolean))];
}

function scopedWorkspaceIds(value, label = 'workspaceIds') {
  const ids = stringList(value, label);
  if (!ids.length) throw new Error(`${label} must contain at least one explicit workspace ID`);
  return ids;
}

export function normalizeDeploymentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');

  const deployment = objectField(config, 'deployment');
  const mode = defaultedEnum(deployment.mode, DEPLOYMENT_MODES, 'personal', 'deployment mode');
  const provider = defaultedEnum(deployment.tunnelProvider, TUNNEL_PROVIDERS, 'ngrok', 'tunnel provider');
  if (mode === 'production' && provider === 'cloudflare-quick') {
    throw new Error('Cloudflare Quick Tunnels are development-only and cannot be used in production mode');
  }
  deployment.mode = mode;
  deployment.tunnelProvider = provider;
  if (deployment.publicUrl === undefined) deployment.publicUrl = '';
  else if (typeof deployment.publicUrl !== 'string') throw new TypeError('deployment.publicUrl must be a string');
  else deployment.publicUrl = deployment.publicUrl.trim();

  const team = objectField(config, 'team');
  team.enabled = mode !== 'personal';
  team.members = defaultedArray(team.members, [], 'team.members');
  team.requireWorkspaceLeaseForWrites = defaultedBoolean(
    team.requireWorkspaceLeaseForWrites,
    mode !== 'personal',
    'team.requireWorkspaceLeaseForWrites'
  );
  team.defaultMemberRole = defaultedEnum(team.defaultMemberRole, TEAM_ROLES, 'developer', 'team role');
  team.maxMembers = defaultedInteger(team.maxMembers, 100, 1, 500, 'team.maxMembers');

  const runtime = objectField(config, 'runtime');
  runtime.maxConcurrentJobs = defaultedInteger(runtime.maxConcurrentJobs, 2, 1, 8, 'runtime.maxConcurrentJobs');

  const jobs = objectField(config, 'jobs');
  jobs.allowJobGitSave = defaultedBoolean(jobs.allowJobGitSave, true, 'jobs.allowJobGitSave');
  jobs.embeddedRunnerEnabled = defaultedBoolean(jobs.embeddedRunnerEnabled, true, 'jobs.embeddedRunnerEnabled');

  const production = objectField(config, 'production');
  production.maxRequestBytes = defaultedInteger(production.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024, 'production.maxRequestBytes');
  production.requestsPerMinute = defaultedInteger(production.requestsPerMinute, mode === 'production' ? 120 : 600, 10, 10000, 'production.requestsPerMinute');
  production.maxConcurrentRequests = defaultedInteger(production.maxConcurrentRequests, mode === 'production' ? 24 : 64, 1, 256, 'production.maxConcurrentRequests');
  production.maxConcurrentPerPrincipal = defaultedInteger(production.maxConcurrentPerPrincipal, mode === 'production' ? 4 : 16, 1, 64, 'production.maxConcurrentPerPrincipal');
  production.requestTimeoutMs = defaultedInteger(production.requestTimeoutMs, 15 * 60 * 1000, 1000, 60 * 60 * 1000, 'production.requestTimeoutMs');
  production.allowedHosts = stringList(production.allowedHosts, 'production.allowedHosts').map(value => value.toLowerCase());
  return config;
}

export function roleCapabilities(role) {
  if (typeof role !== 'string' || !TEAM_ROLES.includes(role)) throw new Error(`Unknown team role: ${String(role)}`);
  return ROLE_CAPABILITIES[role];
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
    workspaceIds: Array.isArray(member.workspaceIds) ? [...member.workspaceIds] : [],
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
  const seed = requested || `member-${crypto.randomBytes(3).toString('hex')}`;
  return uniqueCredentialId(
    (config.team?.members || []).map(member => member.id),
    seed,
    { fallback: 'member' }
  );
}

export function createTeamMember(config, input = {}) {
  normalizeDeploymentConfig(config);
  if (config.team.members.length >= config.team.maxMembers) throw new Error(`Team member limit reached (${config.team.maxMembers})`);
  const role = defaultedEnum(input.role, TEAM_ROLES, config.team.defaultMemberRole, 'team role');
  const id = uniqueMemberId(config, input.id || input.name);
  const workspaceIds = scopedWorkspaceIds(input.workspaceIds);
  const secret = base64url(crypto.randomBytes(32));
  const salt = base64url(crypto.randomBytes(16));
  const timestamp = new Date().toISOString();
  const member = {
    id,
    name: String(input.name || id).trim().slice(0, 200) || id,
    role,
    workspaceIds,
    salt,
    tokenHash: hashSecret(secret, salt),
    tokenVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
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
  return { member: memberPublic(member), token: `dmt_${member.id}_${secret}` };
}

export function updateTeamMember(config, id, patch = {}) {
  normalizeDeploymentConfig(config);
  const member = config.team.members.find(item => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  if (patch.name !== undefined) member.name = String(patch.name || '').trim().slice(0, 200) || member.id;
  if (patch.role !== undefined) member.role = defaultedEnum(patch.role, TEAM_ROLES, config.team.defaultMemberRole, 'team role');
  if (patch.workspaceIds !== undefined) member.workspaceIds = scopedWorkspaceIds(patch.workspaceIds);
  if (patch.expiresAt !== undefined) member.expiresAt = parseExpiry(patch.expiresAt);
  if (patch.disabled !== undefined) member.disabled = defaultedBoolean(patch.disabled, false, 'disabled');
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
  if (!TEAM_ROLES.includes(member.role)) throw new Error(`Unknown team role: ${member.role}`);
  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) return null;
  const workspaceIds = Array.isArray(member.workspaceIds) ? member.workspaceIds.filter(id => typeof id === 'string' && id.trim()) : [];
  if (!workspaceIds.length) return null;
  const candidate = hashSecret(parsed.secret, member.salt);
  if (!timingSafeEqualText(candidate, member.tokenHash)) return null;
  if (updateLastUsed) member.lastUsedAt = new Date().toISOString();
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: [...new Set(workspaceIds.map(id => id.trim()))],
    source: 'team-token',
    tokenVersion: member.tokenVersion || 1
  };
}

export function extractRequestToken(req) {
  const authorization = String(req?.headers?.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || req?.headers?.['x-devmate-token'] || '';
}

export function fallbackLocalPrincipal() {
  return { id: 'local-owner', name: 'Local owner', role: 'owner', workspaceIds: [], source: 'local' };
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
  if (ownerOnlyTool(name) && effectivePrincipal.role !== 'owner') {
    throw new Error(`Tool ${name} requires the owner role`);
  }
  if (!roleAllows(effectivePrincipal.role, capability)) {
    throw new Error(`Role ${effectivePrincipal.role} cannot use ${name}; required capability: ${capability}`);
  }
  const workspaceId = toolWorkspaceId(name, args, config);
  if (workspaceId && effectivePrincipal.source === 'team-token' && !effectivePrincipal.workspaceIds.includes(workspaceId)) {
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
  scopedWorkspaceIds,
  timingSafeEqualText,
  toolWorkspaceId,
  uniqueMemberId
};
