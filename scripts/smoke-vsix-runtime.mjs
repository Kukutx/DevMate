import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vsix = path.join(root, `devmate-${packageJson.version}.vsix`);
assert.ok(fs.existsSync(vsix), `VSIX not found: ${vsix}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vsix-smoke-'));
const extractRoot = path.join(tempRoot, 'extract');
fs.mkdirSync(extractRoot, { recursive: true });

function extractArchive() {
  try {
    execFileSync('tar', ['-xf', vsix, '-C', extractRoot], { stdio: 'pipe' });
    return;
  } catch {}
  const script = process.platform === 'win32'
    ? `Expand-Archive -LiteralPath '${vsix.replace(/'/g, "''")}' -DestinationPath '${extractRoot.replace(/'/g, "''")}' -Force`
    : null;
  if (!script) throw new Error('Unable to extract packaged VSIX');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
}

function localModuleSpecifiers(source) {
  const values = [];
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      if (match[1]?.startsWith('.')) values.push(match[1]);
    }
  }
  return values;
}

function resolveLocalModule(file, specifier) {
  const target = path.resolve(path.dirname(file), specifier);
  for (const candidate of [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`, path.join(target, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walkLocalModules(entryFiles) {
  const visited = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of localModuleSpecifiers(source)) {
      const resolved = resolveLocalModule(file, specifier);
      assert.ok(resolved, `Packaged module missing: ${path.relative(extractRoot, file)} -> ${specifier}`);
      if (/\.(?:js|mjs|cjs)$/i.test(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

function assertNoPrivateElectronNodeFlags(files) {
  const forbidden = ['--ms-enable-electron', 'run-as-node'].join('-');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes(forbidden), false, `Unsupported private Electron Node flag packaged in ${file}`);
  }
}

try {
  extractArchive();
  const extensionPath = path.join(extractRoot, 'extension');
  const packageFile = path.join(extensionPath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(manifest.name, 'devmate');
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');
  const authenticationMode = manifest.contributes?.configuration?.properties?.['devMate.authenticationMode'];
  assert.equal(authenticationMode?.default, 'none', 'Packaged VSIX must default desktop MCP authentication to single-owner no-auth');
  assert.deepEqual(authenticationMode?.enum, ['none', 'oauth'], 'Packaged VSIX must retain explicit loopback no-auth and OAuth options');

  const requiredFiles = [
    'extension.js',
    'extension-entry-shared-tunnel.js',
    'vscode-host/lifecycle.js',
    'vscode-host/runtime-diagnostics.js',
    'vscode-host/shared-tunnel-record-store.js',
    'vscode-host/tunnel-controller.js',
    'vscode-host/tunnel-runtime.js',
    'host/public-mcp.js',
    'host/runtime-controller.js',
    'host/runtime/node-runtime.js',
    'shared/auth-config.cjs',
    'shared/lifecycle-intent.cjs',
    'shared/oauth-secrets.cjs',
    'shared/oauth-tokens.cjs',
    'shared/config-store.cjs',
    'shared/connection-stability.cjs',
    'shared/public-ingress-verification.cjs',
    'host/runtime/diagnostics-store.js',
    'host/runtime/instance-lock-cleanup.js',
    'host/runtime/network.js',
    'host/runtime/operation-coordinator.js',
    'host/runtime/process-controller.js',
    'host/runtime/startup-lease.js',
    'host/runtime/startup-progress.js',
    'gateway/server.bundle.mjs',
    'gateway/server.mjs',
    'gateway/local-shared.mjs',
    'gateway/plugins/builtins.mjs',
    'gateway/plugins/plugin-host.mjs',
    'gateway/plugins/godot.mjs',
    'gateway/plugins/godot-bootstrap.mjs',
    'gateway/plugins/godot-qa-bridge.mjs',
    'gateway/plugins/godot-release-gate.mjs',
    'gateway/plugins/godot-production.mjs',
    'gateway/plugins/godot-performance.mjs',
    'gateway/plugins/godot-tests.mjs',
    'gateway/plugins/godot-native-qa.mjs',
    'gateway/plugins/godot-project.mjs',
    'gateway/plugins/godot-path-policy.mjs',
    'gateway/plugins/godot-baseline.mjs',
    'gateway/plugins/browser-qa.mjs',
    'gateway/plugins/browser-runner.mjs',
    'gateway/plugins/browser-state.mjs',
    'gateway/plugins/automation-manifest.mjs',
    'gateway/plugins/preview-manager.mjs',
    'gateway/plugins/published-preview.mjs',
    'gateway/plugins/published-preview-store.mjs',
    'gateway/plugins/plugin-config.mjs',
    'gateway/plugins/plugin-runtime.mjs',
    'gateway/plugins/plugin-sdk.mjs',
    'gateway/plugins/plugin-services.mjs',
    'gateway/agent-collaboration.mjs',
    'gateway/agent-codex-runtime.mjs',
    'gateway/agent-snapshot.mjs',
    'gateway/agent-supervisor-child.mjs',
    'gateway/agent-supervisor.mjs',
    'gateway/approval-execution-boundary.mjs',
    'gateway/approvals.mjs',
    'gateway/audit-health.mjs',
    'gateway/audit-log-coordinator.mjs',
    'gateway/authorization.mjs',
    'gateway/backup-access-guard.mjs',
    'gateway/command-process.mjs',
    'gateway/command-shell-git-environment.mjs',
    'gateway/connection-config.mjs',
    'gateway/durable-state.mjs',
    'gateway/file-access-hardening.mjs',
    'gateway/file-mutation-safety.mjs',
    'gateway/file-transactions.mjs',
    'gateway/fixed-window-rate-limit.mjs',
    'gateway/git-access-guard.mjs',
    'gateway/git-result-contract.mjs',
    'gateway/http-host-policy.mjs',
    'gateway/http-observability.mjs',
    'gateway/http-server-bootstrap.mjs',
    'gateway/job-artifacts.mjs',
    'gateway/job-runtime.mjs',
    'gateway/job-store.mjs',
    'gateway/job-tools.mjs',
    'gateway/local-capabilities.mjs',
    'gateway/local-control-guard.mjs',
    'gateway/maintenance.mjs',
    'gateway/oauth-auth.mjs',
    'gateway/oauth-host-policy.mjs',
    'gateway/oauth-origin-policy.mjs',
    'gateway/observability.mjs',
    'gateway/persistent-processes.mjs',
    'gateway/request-auth.mjs',
    'gateway/request-concurrency.mjs',
    'gateway/request-guard.mjs',
    'gateway/runner-access.mjs',
    'gateway/runner-control-plane.mjs',
    'gateway/server-extension-host.mjs',
    'gateway/sensitive-path-policy.mjs',
    'gateway/startup-maintenance.mjs',
    'gateway/team-access.mjs',
    'gateway/team-tools.mjs',
    'gateway/tool-policy.mjs',
    'gateway/work-session.mjs',
    'gateway/workspace-leases.mjs',
    'gateway/workspace-resolver.mjs'
  ];
  const entryFiles = [];
  for (const relative of requiredFiles) {
    const file = path.join(extensionPath, relative);
    assert.ok(fs.existsSync(file), `Packaged VSIX missing runtime file: ${relative}`);
    entryFiles.push(file);
  }
  const reachable = walkLocalModules(entryFiles);
  assertNoPrivateElectronNodeFlags(reachable);
  console.log(JSON.stringify({ ok: true, packagedFiles: requiredFiles.length, reachableModules: reachable.size }));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
