'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('VS Code entry owns the host lifecycle and preserves reverse teardown ordering', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');
  assert.equal(fs.existsSync(path.join(root, 'extension-entry-host.js')), false);

  const source = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(source, /VscodeHostLifecycle/);
  assert.match(source, /lifecycle = new VscodeHostLifecycle\(\{ vscode \}\)/);
  assert.match(source, /await lifecycle\.activate\(context\)/);
  assert.match(source, /new SharedTunnelRuntime\(/);
  assert.match(source, /\.install\(\)/);

  const suspend = source.indexOf('currentRuntime?.suspendSpawn()');
  const deactivate = suspend < 0 ? -1 : source.indexOf('await currentLifecycle?.deactivate()', suspend);
  const dispose = deactivate < 0 ? -1 : source.indexOf('await currentRuntime?.dispose({ stopOwned: true })', deactivate);
  assert.ok(suspend >= 0 && deactivate > suspend, 'Shared spawn layer must stop accepting work before host teardown');
  assert.ok(dispose > deactivate, 'Shared tunnel ownership must remain active through host teardown');
});

test('VS Code HTTP calls use the bounded client', () => {
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(source, /requestRaw: boundedHttpRequestRaw/);
  assert.match(source, /return boundedHttpRequestRaw\(url, options, body, timeoutMs\)/);
  assert.doesNotMatch(source, /res\.on\('data',\s*d=>chunks\.push\(Buffer\.from\(d\)\)\)/);
});

test('VSIX smoke contract includes all shared tunnel and HTTP modules', () => {
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-vsix-worker.mjs'), 'utf8');
  assert.match(smoke, /extension-entry-shared-tunnel\.js/);
  assert.doesNotMatch(smoke, /extension-entry-host\.js/);
  assert.match(smoke, /vscode-host\/bounded-http-client\.js/);
  assert.match(smoke, /vscode-host\/shared-tunnel-record-store\.js/);
  assert.match(smoke, /vscode-host\/shared-tunnel-process\.js/);
  assert.match(smoke, /vscode-host\/shared-tunnel-runtime\.js/);

  const packagedSmoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-vsix-shared-tunnel.mjs'), 'utf8');
  assert.match(packagedSmoke, /requireFromVsix\('\.\/vscode-host\/shared-tunnel-runtime\.js'\)/);
  assert.match(packagedSmoke, /singleProviderSpawnVerified/);
  assert.match(packagedSmoke, /followerOwnershipVerified/);
});

test('Windows and Linux CI both execute the installed shared tunnel smoke', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const invocations = workflow.match(/node scripts\/smoke-vsix-shared-tunnel\.mjs/g) || [];
  assert.equal(invocations.length, 2);
  assert.match(workflow, /Smoke test packaged VSIX shared tunnel/);
  assert.match(workflow, /Linux packaged VSIX shared tunnel smoke test/);
});
