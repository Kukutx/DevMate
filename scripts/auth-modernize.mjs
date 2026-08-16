#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function edit(relative, transform) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change produced for ${relative}`);
  fs.writeFileSync(file, after, 'utf8');
}

function once(text, search, replacement, label) {
  const index = text.indexOf(search);
  if (index < 0) throw new Error(`Missing ${label}`);
  if (text.indexOf(search, index + search.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return `${text.slice(0,index)}${replacement}${text.slice(index+search.length)}`;
}

edit('gateway/team-access.mjs', source => {
  let next = source;
  next = once(next,
`    lastUsedAt: member.lastUsedAt || null,
    tokenVersion: member.tokenVersion || 1
  };`,
`    lastUsedAt: member.lastUsedAt || null,
    authVersion: member.authVersion || 1
  };`, 'member public auth version');
  next = once(next,
`    salt,
    tokenHash: hashSecret(secret, salt),
    tokenVersion: 1,`,
`    loginSalt: salt,
    loginHash: hashSecret(secret, salt),
    authVersion: 1,`, 'member credential fields');
  next = once(next,
    '  return { member: memberPublic(member), token: `dmt_${id}_${secret}` };',
    '  return { member: memberPublic(member), loginCode: `dmc_${id}_${secret}` };',
    'member creation result');
  next = once(next, 'export function rotateTeamMemberToken(config, id) {', 'export function rotateTeamMemberLoginCode(config, id) {', 'member rotation function');
  next = once(next,
`  member.salt = salt;
  member.tokenHash = hashSecret(secret, salt);
  member.tokenVersion = (member.tokenVersion || 1) + 1;`,
`  member.loginSalt = salt;
  member.loginHash = hashSecret(secret, salt);
  member.authVersion = (member.authVersion || 1) + 1;`, 'member rotation fields');
  next = once(next,
    '  return { member: memberPublic(member), token: `dmt_${member.id}_${secret}` };',
    '  return { member: memberPublic(member), loginCode: `dmc_${member.id}_${secret}` };',
    'member rotation result');
  next = once(next, 'function parseTeamToken(token) {\n  const match = String(token || \'\').match(/^dmt_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{43})$/);\n  return match ? { id: match[1], secret: match[2] } : null;\n}',
`function parseMemberLoginCode(code) {
  const match = String(code || '').match(/^dmc_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}`, 'member login parser');
  const verifyPattern = /export function verifyAccessToken\(token, config, \{ updateLastUsed = false \} = \{\}\) \{[\s\S]*?\n\}\n\nexport function fallbackLocalPrincipal/;
  if (!verifyPattern.test(next)) throw new Error('Missing team access verifier');
  next = next.replace(verifyPattern, `export function verifyMemberLoginCode(code, config, { updateLastUsed = false } = {}) {
  normalizeInstanceConfig(config);
  const parsed = parseMemberLoginCode(String(code || '').trim());
  if (!parsed) return null;
  const member = config.team.members.find(item => item.id === parsed.id);
  if (!member || member.disabled || !member.loginSalt || !member.loginHash) return null;
  if (!TEAM_ROLES.includes(member.role)) throw new Error(\`Unknown team role: \${member.role}\`);
  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) return null;
  const workspaceIds = Array.isArray(member.workspaceIds) ? member.workspaceIds.filter(id => typeof id === 'string' && id.trim()) : [];
  if (!workspaceIds.length) return null;
  const candidate = hashSecret(parsed.secret, member.loginSalt);
  if (!timingSafeEqualText(candidate, member.loginHash)) return null;
  if (updateLastUsed) member.lastUsedAt = new Date().toISOString();
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: [...new Set(workspaceIds.map(id => id.trim()))],
    source: 'oauth-member',
    authVersion: member.authVersion || 1
  };
}

export function fallbackLocalPrincipal`);
  const currentPattern = /export function currentTeamPrincipal\(principal, config\) \{[\s\S]*?\n\}\n\nfunction dangerousGitPush/;
  if (!currentPattern.test(next)) throw new Error('Missing current team principal resolver');
  next = next.replace(currentPattern, `export function currentTeamPrincipal(principal, config) {
  const source = principal?.source;
  if (!['local', 'oauth-owner', 'oauth-member'].includes(source)) {
    throw principalInactive(principal?.id, 'uses an unsupported authentication source');
  }
  if (source !== 'oauth-member') return principal;
  const member = config.team.members.find(item => item.id === principal.id);
  if (!member) throw principalInactive(principal.id, 'no longer exists');
  if (member.disabled || !member.loginSalt || !member.loginHash) throw principalInactive(principal.id);
  if (!TEAM_ROLES.includes(member.role)) throw new Error(\`Unknown team role: \${member.role}\`);
  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) throw principalInactive(principal.id, 'has expired');
  const workspaceIds = Array.isArray(member.workspaceIds)
    ? [...new Set(member.workspaceIds.filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean))]
    : [];
  if (!workspaceIds.length) throw principalInactive(principal.id, 'has no active workspace scope');
  const authVersion = member.authVersion || 1;
  if (!Number.isSafeInteger(principal.authVersion) || principal.authVersion !== authVersion) {
    throw principalInactive(principal.id, 'authorization was rotated');
  }
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds,
    source: 'oauth-member',
    authVersion
  };
}

export function principalFromOAuthClaims(claims, config) {
  normalizeInstanceConfig(config);
  if (!claims || typeof claims !== 'object') return null;
  if (claims.sub === 'owner') {
    return { id: 'oauth-owner', name: 'OAuth owner', role: 'owner', workspaceIds: [], source: 'oauth-owner' };
  }
  const match = String(claims.sub || '').match(/^member:([a-z0-9_-]{1,120})$/);
  if (!match) return null;
  try {
    return currentTeamPrincipal({ id: match[1], source: 'oauth-member', authVersion: Number(claims.av) }, config);
  } catch {
    return null;
  }
}

function dangerousGitPush`);
  next = next.replaceAll("principal?.source !== 'team-token'", "principal?.source !== 'oauth-member'");
  next = next.replaceAll("effectivePrincipal.source === 'team-token'", "effectivePrincipal.source === 'oauth-member'");
  next = next.replaceAll('Team token ${principal.id}', 'Remote member ${principal.id}');
  next = next.replace('  parseTeamToken,', '  parseMemberLoginCode,');
  if (/dmt_|team-token|tokenVersion|tokenHash|member\.salt\b|parseTeamToken|verifyAccessToken|rotateTeamMemberToken/.test(next)) {
    throw new Error('Retired team-token vocabulary remains in team-access.mjs');
  }
  return next;
});

edit('gateway/team-management-tools.mjs', source => {
  let next = source
    .replaceAll('rotateTeamMemberToken', 'rotateTeamMemberLoginCode')
    .replaceAll('token versions', 'authorization versions')
    .replaceAll('return its token once', 'return its OAuth login code once')
    .replaceAll('The token is shown once. Store it in an approved secret manager and do not commit it.', 'The OAuth login code is shown once. Store it in an approved secret manager and do not commit it.')
    .replaceAll('Rotate DevMate team token', 'Rotate DevMate member login code')
    .replaceAll('Invalidate the old member token and return a new token once.', 'Invalidate the old OAuth member login code, revoke existing member authorization, and return a new login code once.')
    .replaceAll('The replacement token is shown once. Update the team secret and revoke old copies.', 'The replacement OAuth login code is shown once. Update the member secret and remove old copies.')
    .replaceAll('roles, and session IDs', 'roles, and authenticated client identities');
  return next;
});

edit('scripts/standalone-runtime.mjs', source => source.replaceAll('rotateTeamMemberToken', 'rotateTeamMemberLoginCode'));

edit('shared/config-store.cjs', source => once(source, 'const SUPPORTED_CONFIG_VERSION = 11;', 'const SUPPORTED_CONFIG_VERSION = 12;', 'config schema version'));

edit('shared/instance-config.cjs', source => {
  let next = source;
  next = once(next,
`  // Personal desktop use is intentionally direct. Older bearer-token config is
  // discarded here; OAuth is the only optional public-app authentication mode.
  config.auth = normalizeAuthentication(config);`,
`  // Local loopback access is OS-trusted. Remote MCP access uses OAuth only;
  // authentication secrets live outside the instance configuration.
  config.auth = normalizeAuthentication(config);`, 'authentication policy comment');
  return next;
});

console.log('Applied unified OAuth member identity refactor.');
