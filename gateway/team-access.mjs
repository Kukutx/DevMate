import crypto from 'node:crypto';
import instanceConfig from '../shared/instance-config.cjs';
import { uniqueCredentialId } from './credential-id.mjs';
import {
  ownerOnlyTool,
  requiredCapabilityForTool,
  toolWorkspaceId
} from './tool-policy.mjs';
import { defaultedBoolean, defaultedEnum } from './strict-config.mjs';

export { requiredCapabilityForTool, toolWorkspaceId } from './tool-policy.mjs';

export const TEAM_ROLES = Object.freeze([...instanceConfig.TEAM_ROLES]);
export const TUNNEL_PROVIDERS = Object.freeze([...instanceConfig.CONNECTION_PROVIDERS]);
export const normalizeInstanceConfig = instanceConfig.normalizeInstanceConfig;

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

function stringList(value, label) {
  const source = value === undefined ? [] : value;
  if (!Array.isArray(source)) throw new TypeError(`${label} must be an array`);
  return [...new Set(source.map(item => {
    if (typeof item !== 'string') throw new TypeError(`${label} must contain only strings`);
    return item.trim();
  }).filter(Boolean))];
}

function scopedWorkspaceIds(value, label = 'workspaceIds') {
  const ids = stringList(value, label);
  if (!ids.length) throw new Error(`${label} must contain at least one explicit workspace ID`);
  return ids;
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
  normalizeInstanceConfig(config);
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
  normalizeInstanceConfig(config);
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
  normalizeInstanceConfig(config);
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
  normalizeInstanceConfig(config);
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
  normalizeInstanceConfig(config);
  const raw = String(token || '').trim();
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

export function fallbackLocalPrincipal() {
  return { id: 'local-owner', name: 'Local owner', role: 'owner', workspaceIds: [], source: 'local' };
}

function principalInactive(id, detail = 'is no longer active') {
  const error = new Error(`Team member ${id || 'unknown'} ${detail}`);
  error.code = 'principal_inactive';
  return error;
}

export function currentTeamPrincipal(principal, config) {
  if (principal?.source !== 'team-token') return principal;
  const member = config.team.members.find(item => item.id === principal.id);
  if (!member) {
    if (principal.tokenVersion !== undefined && principal.tokenVersion !== null) {
      throw principalInactive(principal.id, 'no longer exists');
    }
    return principal; // Compatibility for legacy durable records and synthetic policy tests.
  }
  if (member.disabled || !member.salt || !member.tokenHash) throw principalInactive(principal.id);
  if (!TEAM_ROLES.includes(member.role)) throw new Error(`Unknown team role: ${member.role}`);
  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) throw principalInactive(principal.id, 'has expired');
  const workspaceIds = Array.isArray(member.workspaceIds)
    ? [...new Set(member.workspaceIds.filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean))]
    : [];
  if (!workspaceIds.length) throw principalInactive(principal.id, 'has no active workspace scope');
  const tokenVersion = member.tokenVersion || 1;
  if (principal.tokenVersion !== undefined && principal.tokenVersion !== null && Number(principal.tokenVersion) !== tokenVersion) {
    throw principalInactive(principal.id, 'credential was rotated');
  }
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds,
    source: 'team-token',
    tokenVersion
  };
}

function dangerousGitPush(value) {
  if (!/\bgit\s+push\b/.test(value)) return false;
  return /(?:^|\s)-f(?:\s|$)/.test(value) ||
    /(?:^|\s)--force(?:-with-lease)?(?:=\S+)?(?:\s|$)/.test(value) ||
    /(?:^|\s)\+[^\s]+/.test(value);
}

function dangerousCommand(command) {
  const value = String(command || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(value) ||
    /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(value) ||
    /\brmdir\b.*\s\/s\b/.test(value) || /\bdel\b.*\s\/s\b/.test(value) ||
    /\bformat\b\s+[a-z]:/.test(value) || /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(value) ||
    /\bgit\s+reset\b.*--hard\b/.test(value) || /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(value) ||
    dangerousGitPush(value);
}

function structuredGitOperandUnsafe(value, { forceRefspec = false } = {}) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;
  return text.startsWith('-') || (forceRefspec && text.startsWith('+'));
}

function assertStructuredGitOperands(name, args = {}) {
  const pushOrPull = name === 'git_push' || name === 'git_pull' || (name === 'git_save' && args?.push);
  if (pushOrPull) {
    if (structuredGitOperandUnsafe(args?.remote, { forceRefspec: true }) || structuredGitOperandUnsafe(args?.branch, { forceRefspec: true })) {
      throw new Error('Structured Git remote/branch fields cannot smuggle options or force refspecs');
    }
  }
  if (name === 'git_branch' && structuredGitOperandUnsafe(args?.name)) {
    throw new Error('Structured Git branch names cannot be option-like');
  }
  if (name === 'git_checkout' && structuredGitOperandUnsafe(args?.branch)) {
    throw new Error('Structured Git checkout targets cannot be option-like');
  }
}

function assertStructuredProjectScript(name, args = {}) {
  if (name !== 'run_project_script' || args?.script === undefined) return;
  const script = String(args.script);
  if (!/^[A-Za-z0-9_.@][A-Za-z0-9_.:@/-]{0,199}$/.test(script)) {
    throw new Error('Project script name must be a single option-safe package script identifier');
  }
}

function assertStructuredToolInputs(name, args = {}) {
  assertStructuredGitOperands(name, args);
  assertStructuredProjectScript(name, args);
}

function assertTeamOperationSafety(name, args, principal) {
  if (principal?.source !== 'team-token') return;
  if ((name === 'run_command' || name === 'start_process') && dangerousCommand(args?.command)) {
    throw new Error(`Team token ${principal.id} cannot run a high-risk command through ${name}`);
  }
  if (name === 'git_push' && (args?.force || args?.forceWithLease)) {
    throw new Error('Force push requires the owner role');
  }
  if (name === 'git_branch' && args?.action === 'delete' && args?.force) {
    throw new Error('Forced branch deletion requires the owner role');
  }
  if (name === 'git_raw') {
    const values = (args?.args || []).map(value => String(value).toLowerCase());
    const command = values.find(value => !value.startsWith('-')) || '';
    const forcePush = command === 'push' && (
      values.includes('-f') ||
      values.some(value => /^--force(?:-with-lease)?(?:=|$)/.test(value)) ||
      values.some(value => value.startsWith('+') && value.length > 1)
    );
    if ((command === 'reset' && values.includes('--hard')) || command === 'clean' || forcePush) {
      throw new Error('High-risk raw Git operations require the owner role');
    }
  }
}

export function authorizeToolCall({ name, annotations, args, config, principal }) {
  normalizeInstanceConfig(config);
  const effectivePrincipal = currentTeamPrincipal(principal || fallbackLocalPrincipal(), config);
  const capability = requiredCapabilityForTool(name, annotations, args);
  assertStructuredToolInputs(name, args);
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
  assertStructuredGitOperands,
  assertStructuredProjectScript,
  assertStructuredToolInputs,
  dangerousCommand,
  hashSecret,
  parseTeamToken,
  requiredCapabilityForTool,
  scopedWorkspaceIds,
  structuredGitOperandUnsafe,
  timingSafeEqualText,
  toolWorkspaceId,
  uniqueMemberId
};