import fs from 'node:fs';

function replace(file, before, after) {
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes(before)) throw new Error(`${file}: expected text not found:\n${before.slice(0, 240)}`);
  text = text.replace(before, after);
  fs.writeFileSync(file, text, 'utf8');
}

replace(
  'config-file-lock.cjs',
  "function staleLock(lock, staleMs, now = Date.now()) {\n  const acquiredAt = Date.parse(lock?.acquiredAt || 0);\n  if (!Number.isFinite(acquiredAt) || now - acquiredAt >= staleMs) return true;\n  return !processAlive(lock?.pid);\n}",
  "function staleLock(lock, staleMs, now = Date.now()) {\n  void staleMs;\n  void now;\n  // A live owner is authoritative. This synchronous lock has no heartbeat that can safely justify age-based takeover.\n  return !processAlive(lock?.pid);\n}"
);

const principalHelper = [
  "function principalInactive(id, detail = 'is no longer active') {",
  "  const error = new Error(`Team member ${id || 'unknown'} ${detail}`);",
  "  error.code = 'principal_inactive';",
  "  return error;",
  "}",
  "",
  "export function currentTeamPrincipal(principal, config) {",
  "  if (principal?.source !== 'team-token') return principal;",
  "  const member = config.team.members.find(item => item.id === principal.id);",
  "  if (!member) {",
  "    if (principal.tokenVersion !== undefined && principal.tokenVersion !== null) {",
  "      throw principalInactive(principal.id, 'no longer exists');",
  "    }",
  "    return principal; // Compatibility for legacy durable records and synthetic policy tests.",
  "  }",
  "  if (member.disabled || !member.salt || !member.tokenHash) throw principalInactive(principal.id);",
  "  if (!TEAM_ROLES.includes(member.role)) throw new Error(`Unknown team role: ${member.role}`);",
  "  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) throw principalInactive(principal.id, 'has expired');",
  "  const workspaceIds = Array.isArray(member.workspaceIds)",
  "    ? [...new Set(member.workspaceIds.filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean))]",
  "    : [];",
  "  if (!workspaceIds.length) throw principalInactive(principal.id, 'has no active workspace scope');",
  "  const tokenVersion = member.tokenVersion || 1;",
  "  if (principal.tokenVersion !== undefined && principal.tokenVersion !== null && Number(principal.tokenVersion) !== tokenVersion) {",
  "    throw principalInactive(principal.id, 'credential was rotated');",
  "  }",
  "  return {",
  "    id: member.id,",
  "    name: member.name,",
  "    role: member.role,",
  "    workspaceIds,",
  "    source: 'team-token',",
  "    tokenVersion",
  "  };",
  "}"
].join('\n');
replace(
  'gateway/team-access.mjs',
  "export function fallbackLocalPrincipal() {\n  return { id: 'local-owner', name: 'Local owner', role: 'owner', workspaceIds: [], source: 'local' };\n}\n",
  "export function fallbackLocalPrincipal() {\n  return { id: 'local-owner', name: 'Local owner', role: 'owner', workspaceIds: [], source: 'local' };\n}\n\n" + principalHelper + "\n"
);
replace(
  'gateway/team-access.mjs',
  "  const effectivePrincipal = principal || fallbackLocalPrincipal();",
  "  const effectivePrincipal = currentTeamPrincipal(principal || fallbackLocalPrincipal(), config);"
);
replace(
  'gateway/team-access.mjs',
  "function dangerousCommand(command) {",
  "function dangerousGitPush(value) {\n  if (!/\\bgit\\s+push\\b/.test(value)) return false;\n  return /(?:^|\\s)-f(?:\\s|$)/.test(value) ||\n    /(?:^|\\s)--force(?:-with-lease)?(?:=\\S+)?(?:\\s|$)/.test(value) ||\n    /(?:^|\\s)\\+[^\\s]+/.test(value);\n}\n\nfunction dangerousCommand(command) {"
);
replace(
  'gateway/team-access.mjs',
  "    /\\bgit\\s+push\\b.*--force(?:-with-lease)?\\b/.test(value);",
  "    dangerousGitPush(value);"
);
replace(
  'gateway/team-access.mjs',
  "  if (name === 'git_raw') {\n    const values = (args?.args || []).map(value => String(value).toLowerCase());\n    const joined = values.join(' ');\n    if ((values[0] === 'reset' && values.includes('--hard')) || values[0] === 'clean' ||\n      (values[0] === 'push' && /(?:^| )--force(?:-with-lease)?(?: |$)/.test(joined))) {\n      throw new Error('High-risk raw Git operations are reserved for the owner token');\n    }\n  }",
  "  if (name === 'git_raw') {\n    const values = (args?.args || []).map(value => String(value).toLowerCase());\n    const command = values.find(value => !value.startsWith('-')) || '';\n    const forcePush = command === 'push' && (\n      values.includes('-f') ||\n      values.some(value => /^--force(?:-with-lease)?(?:=|$)/.test(value)) ||\n      values.some(value => value.startsWith('+') && value.length > 1)\n    );\n    if ((command === 'reset' && values.includes('--hard')) || command === 'clean' || forcePush) {\n      throw new Error('High-risk raw Git operations are reserved for the owner token');\n    }\n  }"
);

replace(
  'gateway/tool-policy.mjs',
  "function explicitCapabilityForTool(name, annotations = {}, args = {}) {",
  "function gitRawCommand(args = {}) {\n  const values = Array.isArray(args?.args)\n    ? args.args.map(value => String(value || '').trim()).filter(Boolean)\n    : [];\n  return values.find(value => !value.startsWith('-'))?.toLowerCase() || '';\n}\n\nfunction explicitCapabilityForTool(name, annotations = {}, args = {}) {"
);
replace(
  'gateway/tool-policy.mjs',
  "  if (tool === 'git_raw') {\n    const first = String(args?.args?.[0] || '').toLowerCase();\n    return ['push', 'pull', 'fetch', 'remote'].includes(first) ? 'publish' : 'git';\n  }",
  "  if (tool === 'git_raw') {\n    const command = gitRawCommand(args);\n    return ['push', 'pull', 'fetch', 'remote'].includes(command) ? 'publish' : 'git';\n  }"
);
replace(
  'gateway/tool-policy.mjs',
  "  explicitCapabilityForTool\n};",
  "  explicitCapabilityForTool,\n  gitRawCommand\n};"
);

replace(
  'gateway/job-queue.mjs',
  "    source: principal?.source || 'unknown',\n    workspaceIds: Array.isArray(principal?.workspaceIds) ? [...principal.workspaceIds] : []\n  };",
  "    source: principal?.source || 'unknown',\n    workspaceIds: Array.isArray(principal?.workspaceIds) ? [...principal.workspaceIds] : [],\n    tokenVersion: Number.isInteger(principal?.tokenVersion) ? principal.tokenVersion : null\n  };"
);
replace(
  'gateway/job-runtime.mjs',
  "          const retryable = !['job_timeout', 'job_cancelled'].includes(error?.code) && !/not allowed|requires the owner role|cannot use/i.test(message);",
  "          const retryable = !['job_timeout', 'job_cancelled', 'principal_inactive'].includes(error?.code) && !/not allowed|requires the owner role|cannot use/i.test(message);"
);

replace(
  'gateway/local-shared.mjs',
  "export function isDangerousCommand(command) {",
  "function dangerousGitPush(value) {\n  if (!/\\bgit\\s+push\\b/.test(value)) return false;\n  return /(?:^|\\s)-f(?:\\s|$)/.test(value) ||\n    /(?:^|\\s)--force(?:-with-lease)?(?:=\\S+)?(?:\\s|$)/.test(value) ||\n    /(?:^|\\s)\\+[^\\s]+/.test(value);\n}\n\nexport function isDangerousCommand(command) {"
);
replace(
  'gateway/local-shared.mjs',
  "    /\\bgit\\s+push\\b.*--force(?:-with-lease)?\\b/.test(normalized);",
  "    dangerousGitPush(normalized);"
);

replace(
  'gateway/server.mjs',
  "  const joined = a.join(' ');\n  return (a[0] === 'reset' && a.includes('--hard')) ||",
  "  const command = a.find(value => !value.startsWith('-')) || '';\n  const joined = a.join(' ');\n  const forcePush = command === 'push' && (\n    a.includes('-f') ||\n    a.some(value => /^--force(?:-with-lease)?(?:=|$)/.test(value)) ||\n    a.some(value => value.startsWith('+') && value.length > 1)\n  );\n  return (command === 'reset' && a.includes('--hard')) ||"
);
replace('gateway/server.mjs', "    a[0] === 'clean' ||", "    command === 'clean' ||");
replace(
  'gateway/server.mjs',
  "    (a[0] === 'push' && (a.includes('--force') || a.includes('-f') || a.includes('--force-with-lease'))) ||",
  "    forcePush ||"
);
replace('gateway/server.mjs', "    (a[0] === 'checkout' && joined.includes(' -- ')) ||", "    (command === 'checkout' && joined.includes(' -- ')) ||");
replace('gateway/server.mjs', "    (a[0] === 'restore' && (a.includes('.') || a.includes(':/' ) || a.includes('--staged')));", "    (command === 'restore' && (a.includes('.') || a.includes(':/' ) || a.includes('--staged')));");

replace(
  'package.json',
  '"description": "Block destructive shell and Git patterns."',
  '"description": "Block recognized destructive shell and Git patterns in balanced mode. fullAccess intentionally bypasses this guard and should be treated as trusted execution."'
);

replace(
  'SECURITY.md',
  '- Team/member credentials cannot use policy-blocked force/destructive operations merely because the underlying OS account could execute them.',
  '- Team/member credentials are denied recognized direct force/destructive Git and shell patterns by policy. Execute access still runs as the DevMate OS identity and is a trusted execution boundary, not a hostile-code sandbox.'
);
replace(
  'SECURITY.md',
  '- Job submission/claim re-evaluates target capability, workspace scope, lease, approval, plugin state and Runner requirements. The queue is not an authorization bypass.',
  '- Job submission/claim re-evaluates current member status, role and workspace scope; current-schema jobs also bind the member credential generation. Lease, approval, plugin state and Runner requirements are rechecked as well. The queue is not an authorization bypass.'
);

console.log('Applied deep audit source hardening.');
