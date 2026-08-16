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
const ignoredFiles = new Set([
  'gateway/server.bundle.mjs'
]);

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
    failures.push({
      file: relative(file),
      output: `${result.stdout || ''}${result.stderr || ''}`.trim()
    });
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
      if (
        fileName !== 'gateway/server-extension-host.mjs' &&
        /\.prototype\.(?:registerTool|connect)\s*=/.test(source)
      ) {
        failures.push({ file: fileName, output: 'MCP server prototype interception must be centralized in gateway/server-extension-host.mjs' });
      }
    }
  }

  for (const entry of localModuleSpecifiers(source)) {
    if (localModuleExists(file, entry.specifier)) continue;
    const line = source.slice(0, entry.index).split(/\r?\n/).length;
    failures.push({
      file: fileName,
      output: `missing local module ${entry.specifier} at line ${line}`
    });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\nRepository source check failed: ${failure.file}\n${failure.output}`);
  }
  console.error(`\n${failures.length} source checks failed across ${files.length} JavaScript files.`);
  process.exit(1);
}

const forbidden = [
  ['gateway/server.mjs', /writeFileSync\(CONFIG_PATH/, 'direct Gateway config write'],
  ['extension.js', /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/, 'directory permission bypass'],
  ['gateway/team-tool-data.mjs', /map\.set\(item\.name/, 'ambiguous workspace scope map'],
  ['shared/auth-config.cjs', /\b(?:signingKey|approvalCode|ownerApprovalCode)\b/, 'OAuth secrets must never be part of the public authentication config schema']
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
  ['shared/auth-config.cjs', /AUTHENTICATION_MODES = Object\.freeze\(\['none', 'oauth'\]\)/, 'authentication config must remain mode-only and OAuth-capable']
];
for (const [file, pattern, label] of required) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (!pattern.test(source)) failures.push({ file, output: label });
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
console.log(`Checked ${files.length} JavaScript files, local module targets, and current architecture contracts.`);
