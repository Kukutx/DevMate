import crypto from 'node:crypto';
import {
  ownerOnlyTool,
  requiredCapabilityForTool,
  toolWorkspaceId
} from './tool-policy.mjs';

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

function enumValue(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new Error(`Unknown ${label}: ${value}`);
  return value;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function booleanValue(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

export function normalizeDeploymentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  config.deployment ||= {};
  if (typeof config.deployment !== 'object' || Array.isArray(config.deployment)) throw new TypeError('deployment must be an object');
  const mode = enumValue(config.deployment.mode, DEPLOYMENT_MODES, 'personal', 'deployment mode');
  const provider = enumValue(config.deployment.tunnelProvider, TUNNEL_PROVIDERS, 'ngrok', 'tunnel provider');
  if (mode === 'production' && provider === 'cloudflare-quick') {
    throw new Error('Cloudflare Quick Tunnels are development-only and cannot be used in production mode');
  }
  config.deployment.mode = mode;
  config.deployment.tunnelProvider = provider;
  config.deployment.publicUrl = String(config.deployment.publicUrl || '').trim();

  config.team ||= {};
  if (typeof config.team !== 'object' || Array.isArray(config.team)) throw new TypeError('team must be an object');
  config.team.enabled = mode !== 'personal';
  if (config.team.members === undefined) config.team.members = [];
  if (!Array.isArray(config.team.members)) throw new TypeError('team.members must be an array');
  config.team.requireWorkspaceLeaseForWrites = booleanValue(
    config.team.requireWorkspaceLeaseForWrites,
    mode !== 'personal',
    'team.requireWorkspaceLeaseForWrites'
  );
  config.team.defaultMemberRole = enumValue(config.team.defaultMemberRole, TEAM_ROLES, 'developer', 'team role');
  config.team.maxMembers = boundedInteger(config.team.maxMembers, 100, 1, 500, 'team.maxMembers');

  config.runtime ||= {};
  if (typeof config.runtime !== 'object' || Array.isArray(config.runtime)) throw new TypeError('runtime must be an object');
  config.runtime.maxConcurrentJobs = boundedInteger(config.runtime.maxConcurrentJobs, 2, 1, 8, 'runtime.maxConcurrentJobs');

  config.jobs ||= {};
  if (typeof config.jobs !== 'object' || Array.isArray(config.jobs)) throw new TypeError('jobs must be an object');
  config.jobs.allowJobGitSave = booleanValue(config.jobs.allowJobGitSave, true, 'jobs.allowJobGitSave');
  config.jobs.embeddedRunnerEnabled = booleanValue(config.jobs.embeddedRunnerEnabled, true, 'jobs.embeddedRunnerEnabled');

  config.production ||= {};
  if (typeof config.production !== 'object' || Array.isArray(config.production)) throw new TypeError('production must be an object');
  config.production.maxRequestBytes = boundedInteger(config.production.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024, 'production.maxRequestBytes');
  config.production.requestsPerMinute = boundedInteger(config.production.requestsPerMinute, mode === 'production' ? 120 : 600, 10, 10000, 'production.requestsPerMinute');
  config.production.maxConcurrentRequests = boundedInteger(config.production.maxConcurrentRequests, mode === 'production' ? 24 : 64, 1, 256, 'production.maxConcurrentRequests');
  config.production.maxConcurrentPerPrincipal = boundedInteger(config.production.maxConcurrentPerPrincipal, mode === 'production' ? 4 : 16, 1, 64, 'production.maxConcurrentPerPrincipal');
  config.production.requestTimeoutMs = boundedInteger(config.production.requestTimeoutMs, 15 * 60 * 1000, 1000, 60 * 60 * 1000, 'production.requestTimeoutMs');
  if (config.production.allowedHosts === undefined) config.production.allowedHosts = [];
  if (!Array.isArray(config.production.allowedHosts)) throw new TypeError('production.allowedHosts must be an array');
  config.production.allowedHosts = [...new Set(config.production.allowedHosts.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  return config;
}

export function roleCapabilities(role) {
  if (!TEAM_ROLES.includes(role)) throw new Error(`Unknown team role: ${role}`);
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
  const role = enumValue(input.role, TEAM_ROLES, config.team.defaultMemberRole, 'team role');
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
  if (patch.role !== undefined) member.role = enumValue(patch.role, TEAM_ROLES, null, 'team role');
  if (patch.workspaceIds !== undefined) {
    if (!Array.isArray(patch.workspaceIds)) throw new Error('workspaceIds must be an array');
    member.workspaceIds = [...new Set(patch.workspaceIds.map(value => String(value || '').trim()).filter(Boolean))];
  }
  if (patch.expiresAt !== undefined) member.expiresAt = parseExpiry(patch.expiresAt);
  if (patch.disabled !== undefined) {
    if (typeof patch.disabled !== 'boolean') throw new Error('disabled must be a boolean');
    member.disabled = patch.disabled;
  }
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
  const candidate = hashSecret(parsed.secret, member.salt);
  if (!timingSafeEqualText(candidate, member.tokenHash)) return null;
  if (updateLastUsed) member.lastUsedAt = new Date().toISOString();
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: Array.isArray(member.workspaceIds) ? [...member.workspaceIds] : [],
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
  if (workspaceId && effectivePrincipal.workspaceIds?.length && !effectivePrincipal.workspaceIds.includes(workspaceId)) {
    throw new Error(`Principal ${effectivePrincipal.id} is not allowed to access workspace ${workspaceId}`);
  }
  return { principal: effectivePrincipal, capability, workspaceId };
}

export const __test = {
  ROLE_CAPABILITIES,
  boundedInteger,
  dangerousCommand,
  enumValue,
  hashSecret,
  parseTeamToken,
  requiredCapabilityForTool,
  timingSafeEqualText,
  toolWorkspaceId
};
