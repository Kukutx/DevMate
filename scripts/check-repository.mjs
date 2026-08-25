#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.js', '.mjs', '.cjs']);
const ignoredDirectories = new Set([
  '.git', '.godot-ci', '.vscode-test', 'build', 'coverage', 'dist', 'node_modules', 'out'
]);
const ignoredFiles = new Set(['gateway/server.bundle.mjs']);

function relative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function discover(directory = root, output = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      discover(full, output);
      continue;
    }
    if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
    if (ignoredFiles.has(relative(full))) continue;
    output.push(full);
  }
  return output;
}

function localModuleSpecifiers(source) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const key = `${match.index}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ specifier, index: match.index || 0 });
    }
  }
  return found;
}

function localModuleExists(file, specifier) {
  const resolved = path.resolve(path.dirname(file), specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [
      resolved,
      `${resolved}.js`, `${resolved}.mjs`, `${resolved}.cjs`, `${resolved}.json`,
      path.join(resolved, 'index.js'), path.join(resolved, 'index.mjs'),
      path.join(resolved, 'index.cjs'), path.join(resolved, 'index.json')
    ];
  return candidates.some(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

const retiredSymbols = [
  { value: ['ensure', 'Personal', 'Config'].join(''), label: 'retired personal-config initializer' }
];
const retiredRuntimeTerms = [
  { value: ['native', 'Ngrok', 'Public', 'Url'].join(''), label: 'retired ngrok tunnel discovery helper' },
  { value: ['/api', '/tunnels'].join(''), label: 'deprecated ngrok Agent tunnels API' },
  { value: ['deployment', 'Mode'].join(''), label: 'retired deployment mode runtime state' },
  { value: ['normalize', 'Bootstrap', 'Deployment'].join(''), label: 'retired deployment bootstrap normalization' },
  { value: ['Public ingress is managed ', 'separately'].join(''), label: 'retired split public-ingress lifecycle' },
  { value: ['Start the tunnel from ', 'VS Code'].join(''), label: 'retired VS Code-owned ingress instruction' },
  { value: ['--ms-enable-electron', 'run-as-node'].join('-'), label: 'unsupported private Electron Node flag' },
  { value: ['vscode-host', 'runtime-io.js'].join('/'), label: 'retired mutable VS Code runtime adapter' },
  { value: ['vscode-host', 'spawn-layer.js'].join('/'), label: 'retired VS Code spawn-layer adapter' },
  { value: '2025-03-26', label: 'retired MCP 2025-03-26 protocol revision' },
  { value: '2025-11-25', label: 'retired MCP 2025-11-25 protocol revision' },
  { value: 'mcp-session-id', label: 'retired sessionful MCP transport state' },
  { value: 'NodeStreamableHTTPServerTransport', label: 'retired MCP v1 server transport' },
  { value: '/oauth/register', label: 'retired OAuth dynamic client registration endpoint' },
  { value: 'x-devmate-token', label: 'retired static DevMate ingress credential header' },
  { value: 'dmt_', label: 'retired Team bearer credential prefix' },
  { value: 'team-token', label: 'retired Team bearer principal source' },
  { value: 'rotateTeamMemberToken', label: 'retired Team bearer token rotation API' }
];

const files = discover();
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    failures.push({ file: relative(file), output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
    continue;
  }

  const source = fs.readFileSync(file, 'utf8');
  const fileName = relative(file);
  if (fileName !== 'scripts/check-repository.mjs') {
    for (const term of retiredSymbols) {
      if (source.includes(term.value)) failures.push({ file: fileName, output: term.label });
    }
    if (!fileName.startsWith('tests/')) {
      for (const term of retiredRuntimeTerms) {
        if (source.includes(term.value)) failures.push({ file: fileName, output: term.label });
      }
      if (fileName !== 'gateway/server-extension-host.mjs' && /\.prototype\.(?:registerTool|connect)\s*=/.test(source)) {
        failures.push({ file: fileName, output: 'MCP server prototype interception must be centralized in gateway/server-extension-host.mjs' });
      }
    }
  }

  for (const entry of localModuleSpecifiers(source)) {
    if (localModuleExists(file, entry.specifier)) continue;
    const line = source.slice(0, entry.index).split(/\r?\n/).length;
    failures.push({ file: fileName, output: `missing local module ${entry.specifier} at line ${line}` });
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`\nRepository source check failed: ${failure.file}\n${failure.output}`);
  console.error(`\n${failures.length} source checks failed across ${files.length} JavaScript files.`);
  process.exit(1);
}

const forbidden = [
  ['gateway/server.mjs', /writeFileSync\(CONFIG_PATH/, 'direct Gateway config write'],
  ['extension.js', /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/, 'directory permission bypass'],
  ['gateway/team-tool-data.mjs', /map\.set\(item\.name/, 'ambiguous workspace scope map'],
  ['shared/auth-config.cjs', /\b(?:signingKey|approvalCode|ownerApprovalCode)\b/, 'OAuth secrets must never be part of the public authentication config schema'],
  ['host/shared-public-mcp-verification.js', /authenticationMode\(config\?\.auth\?\.mode\)\s*!==\s*['"]oauth['"]/, 'public verification must not reject single-owner no-auth']
];
for (const [file, pattern, label] of forbidden) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (pattern.test(source)) failures.push({ file, output: label });
}

const required = [
  ['host/public-mcp.js', /const MCP_PROTOCOL_VERSION = '2026-07-28';/, 'public MCP verifier must be pinned to protocol 2026-07-28'],
  ['scripts/devmate-runner.mjs', /versionNegotiation:\s*\{\s*mode:\s*\{\s*pin:\s*'2026-07-28'\s*\}\s*\}/, 'external Runner MCP client must reject protocol fallback'],
  ['gateway/server.mjs', /createMcpHandler\(\(\) => createServer\(\), \{ legacy: 'reject' \}\)/, 'Gateway MCP server must reject legacy transport eras'],
  ['gateway/server-extension-host.mjs', /prototype\.registerTool = function devmateRegisterTool/, 'Gateway must retain the single MCP tool interception host'],
  ['shared/auth-config.cjs', /AUTHENTICATION_MODES = Object\.freeze\(\['none', 'oauth'\]\)/, 'authentication config must remain mode-only and OAuth-capable'],
  ['shared/auth-config.cjs', /DEFAULT_AUTHENTICATION_MODE = 'none'/, 'single-owner authentication must default to none'],
  ['gateway/request-guard.mjs', /if \(isLocalRequest\(req\) \|\| config\.auth\?\.mode === 'none'\) return fallbackLocalPrincipal\(\)/, 'single-owner no-auth must work on local and public MCP ingress'],
  ['gateway/request-guard.mjs', /if \(config\.auth\?\.mode !== 'oauth'\) return null/, 'unsupported modes must fail closed after none is handled'],
  ['shared/oauth-tokens.cjs', /if \(config\?\.auth\?\.mode !== 'oauth'\) return '';/, 'preflight must only mint an OAuth token when OAuth is enabled'],
  ['scripts/devmate-command.mjs', /team:\s*Object\.freeze\(\{[\s\S]*?'authentication-mode': 'oauth'/, 'Team bootstrap must default to OAuth'],
  ['scripts/devmate-command.mjs', /'control-plane':\s*Object\.freeze\(\{[\s\S]*?'authentication-mode': 'oauth'/, 'Control-plane bootstrap must default to OAuth'],
  ['scripts/devmate-command.mjs', /personal:\s*Object\.freeze\(\{[\s\S]*?'authentication-mode': 'none'/, 'Personal bootstrap must default to no-auth'],
  ['scripts/devmate-command.mjs', /runner:\s*Object\.freeze\(\{[\s\S]*?'authentication-mode': 'none'/, 'Runner bootstrap must default to no-auth']
];
for (const [file, pattern, label] of required) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (!pattern.test(source)) failures.push({ file, output: label });
}

const documentationFiles = [
  'README.md',
  'SECURITY.md',
  'docs/ARCHITECTURE.md',
  'docs/AUTHENTICATION.md',
  'docs/BOOTSTRAP.md',
  'docs/HOST_INTEGRATION.md',
  'docs/STANDALONE.md',
  'docs/TEAM_DEPLOYMENT.md',
  'docs/TUNNELS.md',
  'obsidian-plugin/README.md'
];
const retiredDocumentationPatterns = [
  { pattern: /(?:authenticated\s+)?MCP\s+`initialize`|MCP\s+initialize/i, label: 'retired MCP initialize guidance' },
  { pattern: /preserve the MCP session|MCP session ID\b|MCP-Session-Id|mcp-session-id/i, label: 'retired stateful MCP session guidance' },
  { pattern: /member token is returned|member tokens are printed/i, label: 'retired static member-token guidance' }
];
for (const file of documentationFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const item of retiredDocumentationPatterns) {
    if (item.pattern.test(source)) failures.push({ file, output: item.label });
  }
}

const documentationRequired = [
  ['README.md', /server\/discover[\s\S]*2026-07-28|2026-07-28[\s\S]*server\/discover/, 'README must document MCP 2026 discovery'],
  ['README.md', /Single-owner MCP defaults to no authentication for both local and public ingress; OAuth is for team\/member identity\./, 'README must document single-owner public no-auth'],
  ['SECURITY.md', /Single-owner MCP defaults to no authentication for both local and public ingress; OAuth is required for team\/member identity\./, 'security policy must document single-owner public no-auth'],
  ['docs/AUTHENTICATION.md', /`auth\.mode: "none"` is the default single-owner mode for both local and public MCP access\./, 'authentication policy must define single-owner public no-auth'],
  ['docs/BOOTSTRAP.md', /The Personal and Runner presets default to `none`; Team and Control-plane presets use `oauth` for member identity\./, 'bootstrap docs must encode product auth defaults'],
  ['docs/STANDALONE.md', /Public HTTPS ingress supports the default single-owner `none` mode; use `oauth` for team\/member identity\./, 'standalone docs must support single-owner public no-auth'],
  ['obsidian-plugin/README.md', /Single-owner MCP defaults to no authentication for both local and public ingress; OAuth is for team\/member identity\./, 'Obsidian docs must describe single-owner public no-auth'],
  ['docs/HOST_INTEGRATION.md', /MCP 2026 verification is stateless/, 'host integration must document stateless MCP 2026'],
  ['docs/TEAM_DEPLOYMENT.md', /single-use rotating token families/, 'team docs must document refresh-token rotation'],
  ['docs/TUNNELS.md', /The MCP transport is stateless/, 'tunnel docs must document stateless public verification']
];
for (const [file, pattern, label] of documentationRequired) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (!pattern.test(source)) failures.push({ file, output: label });
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const authenticationDefault = packageJson.contributes?.configuration?.properties?.['devMate.authenticationMode']?.default;
if (authenticationDefault !== 'none') {
  failures.push({ file: 'package.json', output: 'devMate.authenticationMode must default to none for single-owner use' });
}
const currentMcpPackages = {
  '@modelcontextprotocol/client': '2.0.0',
  '@modelcontextprotocol/node': '2.0.0',
  '@modelcontextprotocol/server': '2.0.0'
};
if (packageJson.dependencies?.['@modelcontextprotocol/sdk']) {
  failures.push({ file: 'package.json', output: 'legacy monolithic @modelcontextprotocol/sdk dependency is forbidden' });
}
for (const [name, version] of Object.entries(currentMcpPackages)) {
  if (packageJson.dependencies?.[name] !== version) {
    failures.push({ file: 'package.json', output: `${name} must stay exactly pinned to current MCP v2 release ${version}` });
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`\nRepository contract failed: ${failure.file}\n${failure.output}`);
  process.exit(1);
}
console.log(`Checked ${files.length} JavaScript files, local module targets, current architecture contracts, and ${documentationFiles.length} security-critical documents.`);
