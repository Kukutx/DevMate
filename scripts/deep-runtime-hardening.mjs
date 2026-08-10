#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
}

function write(relative, content) {
  fs.writeFileSync(path.join(root, relative), content.replace(/\r\n/g, '\n'), 'utf8');
}

function replaceOnce(text, from, to, label) {
  const index = text.indexOf(from);
  if (index < 0) throw new Error(`Missing hardening anchor: ${label}`);
  if (text.indexOf(from, index + from.length) >= 0) throw new Error(`Ambiguous hardening anchor: ${label}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function replaceRegexOnce(text, pattern, replacement, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected one match for ${label}, found ${matches.length}`);
  return text.replace(pattern, replacement);
}

function update(relative, transform) {
  const before = read(relative);
  const after = transform(before);
  if (before === after) throw new Error(`No change produced for ${relative}`);
  write(relative, after);
}

function remove(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) throw new Error(`Expected removable file missing: ${relative}`);
  fs.rmSync(target, { force: true });
}

// 1) Collapse VS Code onto native child_process + shared runtime network.
update('extension.js', text => {
  text = replaceOnce(
    text,
    "const childProcess = require('./vscode-host/runtime-io.js');",
    "const { spawn, spawnSync } = require('node:child_process');",
    'extension native child_process'
  );
  text = replaceOnce(
    text,
    "const { requestRaw: boundedHttpRequestRaw } = require('./vscode-host/bounded-http-client.js');\n",
    '',
    'remove duplicate bounded HTTP client'
  );
  text = replaceOnce(
    text,
    "const { RuntimeController } = require('./host/runtime-controller.js');\nconst { resolveNodeRuntime } = require('./host/runtime/node-runtime.js');",
    "const { RuntimeController } = require('./host/runtime-controller.js');\nconst { healthAt, healthMatches } = require('./host/runtime/network.js');\nconst { resolveNodeRuntime } = require('./host/runtime/node-runtime.js');",
    'shared runtime network import'
  );
  text = replaceOnce(
    text,
    "\nfunction spawn(...args){ return childProcess.spawn(...args); }\nfunction spawnSync(...args){ return childProcess.spawnSync(...args); }\n",
    '\n',
    'remove private spawn wrappers'
  );
  text = replaceRegexOnce(
    text,
    /function gatewayPath\(ctx\)\{\n  const bundled = path\.join\(ctx\.extensionPath,'gateway','server\.bundle\.mjs'\);\n  return fs\.existsSync\(bundled\) \? bundled : path\.join\(ctx\.extensionPath,'gateway','server\.mjs'\);\n\}/,
    "function gatewayPath(ctx){ return path.join(ctx.extensionPath,'gateway','server.bundle.mjs'); }",
    'bundle-only Gateway path'
  );
  text = replaceRegexOnce(
    text,
    /function httpRequestRaw\(url, options=\{\}, body=null, timeoutMs=4000\)\{[\s\S]*?function healthMatches\(r, ctx\)\{\n  const cfgData = readConfig\(configPath\(ctx\)\);\n  return !!\(r\.ok && r\.json && r\.json\.name === 'devmate' && r\.json\.version === VERSION && \(!cfgData\?\.instanceId \|\| r\.json\.instanceId === cfgData\.instanceId\)\);\n\}\n/,
    '',
    'remove duplicate health client'
  );
  text = replaceOnce(
    text,
    "  checks.push(`Node: ${process.execPath}`);",
    "  try{\n    const runtime=ensureGatewayNodeRuntime();\n    checks.push(`Gateway Node: ${runtime.nodeVersion} (${runtime.source}) ${runtime.executable}`);\n  }catch(e){\n    checks.push(`Gateway Node: UNAVAILABLE (${e.message || e})`);\n  }",
    'doctor reports selected Gateway runtime'
  );
  text = replaceOnce(
    text,
    "const h=await healthAt(Number(data.server.port||selectedPort)); checks.push(`Gateway health: ${healthMatches(h,ctx) ? 'OK' : `not current/failed (${h.status||h.error||'no response'})`}`);",
    "const h=await healthAt(Number(data.server.port||selectedPort)); checks.push(`Gateway health: ${healthMatches(h,data) ? 'OK' : `not current/failed (${h.status||h.error||'no response'})`}`);",
    'doctor shared health contract'
  );
  text = replaceOnce(
    text,
    "    gatewayController = null;\n    gatewayControllerKey = '';\n    gatewayProcess = null;",
    "    gatewayController = null;\n    gatewayControllerKey = '';\n    gatewayNodeRuntime = null;\n    gatewayNodeRuntimeKey = '';\n    gatewayProcess = null;",
    'reset cached Gateway runtime on deactivate'
  );
  return text;
});

// 2) Require the packaged Gateway bundle as the sole VS Code runtime entry.
update('vscode-host/runtime-context.js', text => replaceOnce(
  text,
  "function gatewayCandidates(context) {\n  return [\n    path.join(context.extensionPath, 'gateway', 'server.bundle.mjs'),\n    path.join(context.extensionPath, 'gateway', 'server.mjs')\n  ];\n}",
  "function gatewayCandidates(context) {\n  return [path.join(context.extensionPath, 'gateway', 'server.bundle.mjs')];\n}",
  'single packaged Gateway candidate'
));

// 3) Make host self-check probe the exact Node runtime contract used by startup.
write('vscode-host/runtime-diagnostics.js', `'use strict';\n\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst { resolveNodeRuntime } = require('../host/runtime/node-runtime.js');\nconst { DiagnosticsStore, redactValue } = require('../host/runtime/diagnostics-store.js');\nconst { gatewayCandidates, runtimeConfigPath, workspaceFolders } = require('./runtime-context.js');\n\nclass VscodeRuntimeDiagnostics {\n  constructor({ vscode, context, runtimeContext, output, resolveNodeRuntimeImpl = resolveNodeRuntime }) {\n    this.vscode = vscode;\n    this.context = context;\n    this.runtimeContext = runtimeContext;\n    this.output = output;\n    this.resolveNodeRuntime = resolveNodeRuntimeImpl;\n    this.gatewayRuntime = null;\n    this.gatewayRuntimeError = '';\n    this.store = new DiagnosticsStore({\n      stateDirectory: runtimeContext.globalStorageUri.fsPath,\n      fileName: 'vscode-host.log'\n    });\n  }\n\n  append(message, level = 'info') {\n    const text = String(message || '');\n    this.store.append(text, level);\n    this.output?.appendLine(\`[\${new Date().toLocaleTimeString()}] \${text}\`);\n  }\n\n  recordFailure(error, context = {}) {\n    const failure = this.store.recordFailure(error, context);\n    this.output?.appendLine(\`[\${new Date().toLocaleTimeString()}] ERROR \${failure.message}\`);\n    return failure;\n  }\n\n  clearFailure() {\n    this.store.clearFailure();\n  }\n\n  selfCheck() {\n    const checks = [];\n    const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: String(detail || '') });\n    const stateDirectory = this.runtimeContext.globalStorageUri.fsPath;\n    const configFile = runtimeConfigPath(this.runtimeContext);\n    const candidates = gatewayCandidates(this.runtimeContext);\n    const gateway = candidates.find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || '';\n\n    add('extension-path', fs.statSync(this.context.extensionPath, { throwIfNoEntry: false })?.isDirectory(), this.context.extensionPath);\n    add('state-directory', fs.statSync(stateDirectory, { throwIfNoEntry: false })?.isDirectory(), stateDirectory);\n    add('gateway-bundle', !!gateway, gateway || candidates.join(' | '));\n    add('gateway-bundle-size', !!gateway && fs.statSync(gateway).size > 100000, gateway ? \`\${fs.statSync(gateway).size} bytes\` : 'missing');\n    add('gateway-launch-mode', true, 'child_process');\n    add('config-file', fs.statSync(configFile, { throwIfNoEntry: false })?.isFile(), configFile);\n    add('workspace', workspaceFolders(this.vscode).length > 0, \`\${workspaceFolders(this.vscode).length} folder(s)\`);\n\n    try {\n      const runtime = this.resolveNodeRuntime();\n      this.gatewayRuntime = {\n        source: runtime.source,\n        executable: runtime.executable,\n        nodeVersion: runtime.nodeVersion,\n        electronVersion: runtime.electronVersion || null\n      };\n      this.gatewayRuntimeError = '';\n      add('gateway-node-runtime', true, \`Node \${runtime.nodeVersion} via \${runtime.source}: \${runtime.executable}\`);\n    } catch (error) {\n      this.gatewayRuntime = null;\n      this.gatewayRuntimeError = String(error.message || error);\n      add('gateway-node-runtime', false, this.gatewayRuntimeError);\n    }\n    add('electron-runtime', !!process.versions.electron, process.versions.electron || 'not reported');\n\n    const informational = new Set(['workspace', 'config-file', 'electron-runtime']);\n    const ok = checks.every(check => check.ok || informational.has(check.id));\n    this.append(\`VS Code host self-check \${ok ? 'passed' : 'failed'}: \${checks.map(c => \`\${c.id}=\${c.ok ? 'ok' : 'fail'}\`).join(', ')}\`,\n      ok ? 'info' : 'error');\n    return { ok, checks, gateway, gatewayRuntime: this.gatewayRuntime, stateDirectory, configFile };\n  }\n\n  snapshot({ startupMode, enabled } = {}) {\n    let config = null;\n    try {\n      config = JSON.parse(fs.readFileSync(runtimeConfigPath(this.runtimeContext), 'utf8').replace(/^\\uFEFF/, ''));\n    } catch {}\n    return {\n      generatedAt: new Date().toISOString(),\n      host: {\n        id: 'vscode',\n        extensionVersion: this.context.extension?.packageJSON?.version || null,\n        vscodeVersion: this.vscode.version || null,\n        enabled,\n        startupMode,\n        launchMode: 'child_process'\n      },\n      environment: {\n        platform: process.platform,\n        arch: process.arch,\n        node: process.versions.node || null,\n        electron: process.versions.electron || null,\n        chrome: process.versions.chrome || null,\n        execPath: process.execPath,\n        gatewayRuntime: this.gatewayRuntime,\n        gatewayRuntimeError: this.gatewayRuntimeError || null\n      },\n      workspace: {\n        folders: workspaceFolders(this.vscode),\n        workspaceFile: this.vscode.workspace.workspaceFile?.fsPath || null\n      },\n      paths: {\n        extensionPath: this.context.extensionPath,\n        stateDirectory: this.runtimeContext.globalStorageUri.fsPath,\n        configFile: runtimeConfigPath(this.runtimeContext),\n        gatewayCandidates: gatewayCandidates(this.runtimeContext),\n        logFile: this.store.logFile\n      },\n      lastFailure: this.store.lastFailure,\n      config: redactValue(config)\n    };\n  }\n\n  report(options = {}) {\n    return [\n      'DevMate VS Code host diagnostics',\n      this.store.report(this.snapshot(options))\n    ].join('\\n');\n  }\n\n  async copy(options = {}) {\n    const report = this.report(options);\n    await this.vscode.env.clipboard.writeText(report);\n    this.append(\`Copied VS Code host diagnostics (\${report.length} characters).\`);\n    return report;\n  }\n}\n\nmodule.exports = {\n  VscodeRuntimeDiagnostics\n};\n`);

// 4) Never attach to a stale DevMate Gateway version merely because instanceId matches.
update('host/runtime/network.js', text => replaceOnce(
  text,
  "function healthMatches(health, config) {\n  return !!(\n    health?.ok &&\n    health.json?.name === 'devmate' &&\n    (!config?.instanceId || health.json.instanceId === config.instanceId)\n  );\n}",
  "function healthMatches(health, config) {\n  const expectedVersion = String(config?.appVersion || '').trim();\n  return !!(\n    health?.ok &&\n    health.json?.name === 'devmate' &&\n    (!config?.instanceId || health.json.instanceId === config.instanceId) &&\n    (!expectedVersion || health.json.version === expectedVersion)\n  );\n}",
  'Gateway version-aware health matching'
));

// 5) Preserve ownership when failed startup cleanup cannot prove the Gateway exited.
update('host/runtime/process-controller.js', text => {
  text = replaceOnce(
    text,
    "    nodeExecutable = process.execPath,\n    spawnImpl = spawn\n  }) {",
    "    nodeExecutable = process.execPath,\n    spawnImpl = spawn,\n    childExitTimeoutMs = CHILD_EXIT_TIMEOUT_MS,\n    childForceExitTimeoutMs = CHILD_FORCE_EXIT_TIMEOUT_MS\n  }) {",
    'RuntimeController termination options'
  );
  text = replaceOnce(
    text,
    "    this.nodeExecutable = nodeExecutable;\n    this.spawnImpl = spawnImpl;",
    "    this.nodeExecutable = nodeExecutable;\n    this.spawnImpl = spawnImpl;\n    this.childExitTimeoutMs = Math.max(100, Number(childExitTimeoutMs) || CHILD_EXIT_TIMEOUT_MS);\n    this.childForceExitTimeoutMs = Math.max(100, Number(childForceExitTimeoutMs) || CHILD_FORCE_EXIT_TIMEOUT_MS);",
    'RuntimeController termination policy state'
  );
  text = replaceOnce(
    text,
    "  activeOwnedChild() {\n    return this.owned && childActive(this.child) ? this.child : null;\n  }",
    "  activeOwnedChild() {\n    return this.owned && childActive(this.child) ? this.child : null;\n  }\n\n  terminateOwnedChild(child) {\n    return terminateChild(child, {\n      timeoutMs: this.childExitTimeoutMs,\n      forceTimeoutMs: this.childForceExitTimeoutMs\n    });\n  }",
    'centralized RuntimeController termination'
  );
  text = text.replace(/await terminateChild\(this\.child\)/g, 'await this.terminateOwnedChild(this.child)');
  text = text.replace(/await terminateChild\(child\)/g, 'await this.terminateOwnedChild(child)');
  text = replaceOnce(
    text,
    "        if (this.child === child) {\n          this.child = null;\n          this.owned = false;\n          if (this.phase === 'running') this.phase = 'idle';\n        }",
    "        if (this.child === child) {\n          this.child = null;\n          this.owned = false;\n          if (this.phase === 'running' || this.phase === 'stopping' || this.phase === 'error') this.phase = 'idle';\n        }",
    'late Gateway exit clears transitional phase'
  );
  text = replaceOnce(
    text,
    "      const terminated = await this.terminateOwnedChild(child);\n      launch.forcedTermination = terminated.forced || !!child.forceTerminated;\n      if (this.child === child && terminated.exited) this.child = null;\n      this.owned = false;\n      launch.endedAt ||= now();\n\n      config = this.ensureConfig();",
    "      const terminated = await this.terminateOwnedChild(child);\n      launch.forcedTermination = terminated.forced || !!child.forceTerminated;\n      if (!terminated.exited) {\n        if (this.child === child && childActive(child)) this.owned = true;\n        this.phase = 'stopping';\n        const detail = startupFailureDetail(launch, child);\n        const error = new Error(`DevMate Gateway startup failed and cleanup could not confirm process exit${detail ? `: ${detail}` : ''}`);\n        error.code = 'DEVMATE_GATEWAY_START_CLEANUP_PENDING';\n        error.cleanupPending = true;\n        error.cleanup = terminated;\n        error.diagnostics = this.diagnosticSnapshot();\n        throw error;\n      }\n      if (this.child === child) this.child = null;\n      this.owned = false;\n      launch.endedAt ||= now();\n\n      config = this.ensureConfig();",
    'failed startup preserves live ownership'
  );
  return text;
});

// 6) Serialize follower recovery against Stop so a tunnel cannot appear after Stop returns.
write('vscode-host/tunnel-runtime.js', `'use strict';\n\nconst ATTACHMENT_POLL_MS = 1000;\n\nlet controller = null;\nlet attachmentTimer = null;\nlet attachmentPort = 0;\nlet attachmentRecoveryPromise = null;\nlet sessionRequested = false;\n\nfunction stopAttachmentWatcher() {\n  if (attachmentTimer) clearInterval(attachmentTimer);\n  attachmentTimer = null;\n  attachmentPort = 0;\n}\n\nfunction recoverAttachment(current, port) {\n  if (attachmentRecoveryPromise) return attachmentRecoveryPromise;\n  let recovery;\n  recovery = Promise.resolve()\n    .then(() => current.start(port))\n    .then(result => {\n      if (controller === current && sessionRequested && result?.owned) stopAttachmentWatcher();\n      return result;\n    })\n    .catch(error => {\n      current.logger?.(\`Tunnel follower recovery failed: \${error.message || error}\`);\n      return null;\n    })\n    .finally(() => {\n      if (attachmentRecoveryPromise === recovery) attachmentRecoveryPromise = null;\n    });\n  attachmentRecoveryPromise = recovery;\n  return recovery;\n}\n\nfunction startAttachmentWatcher(port) {\n  stopAttachmentWatcher();\n  attachmentPort = Number(port) || 0;\n  if (!attachmentPort || !controller) return;\n  attachmentTimer = setInterval(() => {\n    const current = controller;\n    if (!current || attachmentRecoveryPromise || !sessionRequested) return;\n    let status;\n    try {\n      status = current.status(attachmentPort);\n    } catch (error) {\n      current.logger?.(\`Tunnel attachment watch failed: \${error.message || error}\`);\n      return;\n    }\n    if (status.owned) {\n      stopAttachmentWatcher();\n      return;\n    }\n    if (status.running) return;\n    void recoverAttachment(current, attachmentPort);\n  }, ATTACHMENT_POLL_MS);\n  attachmentTimer.unref?.();\n}\n\nfunction setTunnelController(value) {\n  if (!value || typeof value.start !== 'function' || typeof value.stop !== 'function' || typeof value.status !== 'function') {\n    throw new TypeError('A TunnelController-compatible runtime is required');\n  }\n  if (controller !== value) stopAttachmentWatcher();\n  controller = value;\n  return controller;\n}\n\nfunction clearTunnelController(value = null) {\n  if (value && controller !== value) return false;\n  stopAttachmentWatcher();\n  controller = null;\n  sessionRequested = false;\n  return true;\n}\n\nfunction tunnelController() {\n  if (!controller) {\n    const error = new Error('DevMate tunnel runtime is not initialized');\n    error.code = 'DEVMATE_TUNNEL_RUNTIME_UNAVAILABLE';\n    throw error;\n  }\n  return controller;\n}\n\nasync function startTunnel(port) {\n  const current = tunnelController();\n  try {\n    const result = await current.start(port);\n    sessionRequested = true;\n    if (result?.attached) startAttachmentWatcher(port);\n    else stopAttachmentWatcher();\n    return result;\n  } catch (error) {\n    sessionRequested = false;\n    stopAttachmentWatcher();\n    throw error;\n  }\n}\n\nasync function stopTunnel() {\n  const current = tunnelController();\n  sessionRequested = false;\n  stopAttachmentWatcher();\n  const pendingRecovery = attachmentRecoveryPromise;\n  if (pendingRecovery) await pendingRecovery.catch(() => null);\n  return current.stop();\n}\n\nfunction tunnelStatus(port) {\n  return tunnelController().status(port);\n}\n\nfunction tunnelSessionRequested() {\n  return sessionRequested;\n}\n\nmodule.exports = {\n  ATTACHMENT_POLL_MS,\n  clearTunnelController,\n  setTunnelController,\n  startTunnel,\n  stopAttachmentWatcher,\n  stopTunnel,\n  tunnelController,\n  tunnelSessionRequested,\n  tunnelStatus\n};\n`);

// 7) Make fresh-install ngrok account behavior identical in every layer.
update('extension-entry.js', text => replaceRegexOnce(
  text,
  /function usesManagedAccount\(\) \{ return preferenceValue\('ngrokUseManagedAccount', true\) !== false; \}/,
  "function usesManagedAccount() { return preferenceValue('ngrokUseManagedAccount', false) === true; }",
  'ngrok fresh-install account source'
));
update('extension-entry-platform.js', text => replaceOnce(
  text,
  "ngrokUseManagedAccount: strictBoolean(setting('ngrokUseManagedAccount', true), 'devMate.ngrokUseManagedAccount'),",
  "ngrokUseManagedAccount: strictBoolean(setting('ngrokUseManagedAccount', false), 'devMate.ngrokUseManagedAccount'),",
  'platform ngrok managed-account default'
));
update('vscode-host/tunnel-controller.js', text => replaceOnce(
  text,
  "useManagedAccount: settings.ngrokUseManagedAccount !== false",
  "useManagedAccount: settings.ngrokUseManagedAccount === true",
  'provider launch ngrok managed-account opt-in'
));

// 8) Remove the no-longer-useful mutable runtime adapter stack that enabled the original bug.
for (const relative of [
  'vscode-host/runtime-io.js',
  'vscode-host/spawn-layer.js',
  'vscode-host/bounded-http-client.js',
  'tests/private-runtime-io.test.cjs',
  'tests/spawn-layer.test.cjs',
  'tests/bounded-http-client.test.cjs'
]) remove(relative);

// 9) Strengthen repository-level architecture contracts.
update('scripts/check-repository.mjs', text => {
  text = replaceOnce(
    text,
    "  { value: ['Start the tunnel from ', 'VS Code'].join(''), label: 'retired VS Code-owned ingress instruction' }",
    "  { value: ['Start the tunnel from ', 'VS Code'].join(''), label: 'retired VS Code-owned ingress instruction' },\n  { value: ['--ms-enable-electron', 'run-as-node'].join('-'), label: 'unsupported private Electron Node flag' },\n  { value: ['vscode-host', 'runtime-io.js'].join('/'), label: 'retired mutable VS Code runtime adapter' },\n  { value: ['vscode-host', 'spawn-layer.js'].join('/'), label: 'retired VS Code spawn-layer adapter' }",
    'retired runtime contracts'
  );
  return text;
});

// 10) Update source/architecture tests to assert the simplified runtime boundaries.
update('tests/vscode-runtime-controller-contract.test.cjs', text => replaceRegexOnce(
  text,
  /test\('actual VS Code process calls resolve the private active spawn chain at call time',[\s\S]*?\n\}\);\n\ntest\('ngrok setup owns only configuration/,
  `test('actual VS Code process calls use native child_process and the shared runtime network', () => {\n  assert.match(source, /const \\{ spawn, spawnSync \\} = require\\('node:child_process'\\)/);\n  assert.match(source, /const \\{ healthAt, healthMatches \\} = require\\('\\.\\/host\\/runtime\\/network\\.js'\\)/);\n  assert.match(source, /resolveNodeRuntime/);\n  assert.doesNotMatch(source, /runtime-io\\.js|bounded-http-client\\.js|SpawnLayer/);\n  assert.doesNotMatch(source, /ms-enable-electron-run-as-node/);\n  assert.doesNotMatch(source, /version:\\s*9\\b/);\n  assert.doesNotMatch(source, /data\\.version\\s*=\\s*9\\b/);\n});\n\ntest('ngrok setup owns only configuration`,
  'VS Code native runtime contract'
));

update('tests/shared-tunnel-entry-contract.test.cjs', text => {
  text = replaceRegexOnce(
    text,
    /test\('VS Code HTTP calls use the bounded client',[\s\S]*?\n\}\);/,
    `test('VS Code Gateway health uses the shared bounded runtime network', () => {\n  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');\n  const network = fs.readFileSync(path.join(root, 'host', 'runtime', 'network.js'), 'utf8');\n  assert.match(source, /require\\('\\.\\/host\\/runtime\\/network\\.js'\\)/);\n  assert.doesNotMatch(source, /bounded-http-client\\.js|runtime-io\\.js/);\n  assert.match(network, /MAX_HTTP_JSON_BYTES/);\n  assert.match(network, /response-too-large/);\n});`,
    'shared Gateway health client contract'
  );
  text = text.replace("  assert.match(smoke, /vscode-host\\/bounded-http-client\\.js/);\n", '');
  return text;
});

update('tests/vscode-runtime-context.test.cjs', text => replaceOnce(
  text,
  "test('orders packaged Gateway candidates with the bundle first', () => {\n  const extensionPath = temporaryDirectory('devmate-vscode-extension-');\n  const context = { extensionPath };\n  assert.deepEqual(gatewayCandidates(context), [\n    path.join(extensionPath, 'gateway', 'server.bundle.mjs'),\n    path.join(extensionPath, 'gateway', 'server.mjs')\n  ]);\n});",
  "test('uses only the packaged Gateway bundle at runtime', () => {\n  const extensionPath = temporaryDirectory('devmate-vscode-extension-');\n  const context = { extensionPath };\n  assert.deepEqual(gatewayCandidates(context), [path.join(extensionPath, 'gateway', 'server.bundle.mjs')]);\n});",
  'bundle-only runtime-context test'
));

update('tests/vscode-host-lifecycle.test.cjs', text => {
  text = replaceOnce(text, "    vscodeStartupMode: 'manual',", "    autoStart: false,", 'manual lifecycle setting');
  text = replaceOnce(
    text,
    "  assert.equal(check.checks.find(item => item.id === 'gateway-launch-mode')?.detail, 'child_process');",
    "  assert.equal(check.checks.find(item => item.id === 'gateway-launch-mode')?.detail, 'child_process');\n  assert.equal(check.checks.find(item => item.id === 'gateway-node-runtime')?.ok, true);",
    'lifecycle real Node self-check assertion'
  );
  return text;
});

update('tests/node-runtime.test.cjs', text => {
  const insert = `\ntest('VS Code host runtime is probed with environment-only Node mode and falls back cleanly', () => {\n  const code = 'A:\\\\Software Development\\\\Microsoft VS Code\\\\Code.exe';\n  const host = fakeSpawn({ [code]: success('24.18.0', code, '39.2.3') });\n  const selected = resolveNodeRuntime({\n    processExecutable: code,\n    processNodeVersion: '24.18.0',\n    spawnSyncImpl: host\n  });\n  assert.equal(selected.source, 'host');\n  assert.equal(host.calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');\n  assert.equal(host.calls[0].args.some(arg => String(arg).includes('ms-enable-electron')), false);\n\n  const fallback = fakeSpawn({\n    [code]: { status: 9, stdout: '', stderr: 'bad option' },\n    node: success('24.18.0', 'C:\\\\Program Files\\\\nodejs\\\\node.exe')\n  });\n  const fallbackSelected = resolveNodeRuntime({\n    processExecutable: code,\n    processNodeVersion: '24.18.0',\n    spawnSyncImpl: fallback\n  });\n  assert.equal(fallbackSelected.source, 'path');\n  assert.deepEqual(fallback.calls.map(call => call.command), [code, 'node']);\n});\n`;
  const anchor = "\ntest('auto resolution skips an old embedded Node and uses system Node 24', () => {";
  return replaceOnce(text, anchor, insert + anchor, 'VS Code Code.exe runtime regression');
});

update('tests/runtime-controller.test.cjs', text => {
  text = replaceOnce(
    text,
    "const fs = require('node:fs');\nconst net = require('node:net');",
    "const fs = require('node:fs');\nconst net = require('node:net');\nconst { EventEmitter } = require('node:events');\nconst { PassThrough } = require('node:stream');",
    'runtime-controller fake child imports'
  );
  text = replaceOnce(
    text,
    "  RuntimeController,\n  ensureInstanceConfig,",
    "  RuntimeController,\n  ensureInstanceConfig,\n  healthMatches,",
    'runtime-controller healthMatches import'
  );
  text = replaceOnce(
    text,
    "response.end(JSON.stringify({name:'devmate', instanceId:config.instanceId}));",
    "response.end(JSON.stringify({name:'devmate', version:config.appVersion, instanceId:config.instanceId}));",
    'test Gateway health version'
  );
  const versionTest = `\ntest('Gateway health rejects stale DevMate versions even when instance identity matches', () => {\n  const config = { appVersion: '3.3.0', instanceId: 'same-instance' };\n  assert.equal(healthMatches({ ok: true, json: { name: 'devmate', version: '3.2.0', instanceId: 'same-instance' } }, config), false);\n  assert.equal(healthMatches({ ok: true, json: { name: 'devmate', version: '3.3.0', instanceId: 'same-instance' } }, config), true);\n});\n`;
  text = replaceOnce(text, "\ntest('runtime controller publishes a bounded generic host context', () => {", versionTest + "\ntest('runtime controller publishes a bounded generic host context', () => {", 'stale Gateway version regression');

  const cleanupTest = `\nclass StubbornGatewayChild extends EventEmitter {\n  constructor() {\n    super();\n    this.stdout = new PassThrough();\n    this.stderr = new PassThrough();\n    this.pid = 987654;\n    this.exitCode = null;\n    this.signalCode = null;\n    this.killed = false;\n  }\n\n  kill() {\n    this.killed = true;\n    return true;\n  }\n}\n\ntest('failed startup keeps ownership until a stubborn Gateway actually exits', async () => {\n  const root = temporaryDirectory('devmate-stubborn-start-root-');\n  const state = temporaryDirectory('devmate-stubborn-start-state-');\n  const gateway = writeTestGateway(root, { neverListen: true });\n  const child = new StubbornGatewayChild();\n  const controller = new RuntimeController({\n    workspaceRoot: root,\n    stateDirectory: state,\n    gatewayEntry: gateway,\n    preferredPort: await freePort(),\n    spawnImpl: () => child,\n    childExitTimeoutMs: 100,\n    childForceExitTimeoutMs: 100\n  });\n\n  await assert.rejects(\n    controller.start({ timeoutMs: 2000 }),\n    error => error.code === 'DEVMATE_GATEWAY_START_CLEANUP_PENDING' && error.cleanupPending === true\n  );\n  assert.equal(controller.child, child);\n  assert.equal(controller.owned, true);\n  assert.equal(controller.phase, 'stopping');\n\n  child.exitCode = 0;\n  child.emit('exit', 0, 'SIGKILL');\n  child.emit('close', 0, 'SIGKILL');\n  assert.equal(controller.child, null);\n  assert.equal(controller.owned, false);\n  assert.equal(controller.phase, 'idle');\n});\n`;
  text = replaceOnce(text, "\ntest('dispose refuses to orphan an owned process unless stopOwned is requested', async () => {", cleanupTest + "\ntest('dispose refuses to orphan an owned process unless stopOwned is requested', async () => {", 'stubborn Gateway cleanup ownership regression');
  return text;
});

update('tests/ngrok-setup-direction-contract.test.cjs', text => {
  const anchor = "  assert.match(setting.description, /normal ngrok configuration/i);";
  const addition = `${anchor}\n  assert.match(source, /preferenceValue\\('ngrokUseManagedAccount', false\\) === true/);\n  const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');\n  const controller = fs.readFileSync(path.join(root, 'vscode-host', 'tunnel-controller.js'), 'utf8');\n  assert.match(platform, /setting\\('ngrokUseManagedAccount', false\\)/);\n  assert.match(controller, /useManagedAccount: settings\\.ngrokUseManagedAccount === true/);`;
  return replaceOnce(text, anchor, addition, 'ngrok default consistency contract');
});

// 11) Add direct diagnostics and attachment-recovery regressions.
write('tests/vscode-runtime-diagnostics.test.cjs', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst test = require('node:test');\nconst { VscodeRuntimeDiagnostics } = require('../vscode-host/runtime-diagnostics.js');\n\nfunction temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }\n\nfunction harness(resolveNodeRuntimeImpl) {\n  const extensionPath = temp('devmate-runtime-diagnostics-extension-');\n  const stateDirectory = temp('devmate-runtime-diagnostics-state-');\n  const workspaceRoot = temp('devmate-runtime-diagnostics-workspace-');\n  fs.mkdirSync(path.join(extensionPath, 'gateway'), { recursive: true });\n  fs.writeFileSync(path.join(extensionPath, 'gateway', 'server.bundle.mjs'), 'x'.repeat(120000));\n  const context = {\n    extensionPath,\n    extension: { packageJSON: { version: '3.3.0' } },\n    globalStorageUri: { fsPath: stateDirectory }\n  };\n  const vscode = {\n    version: '1.132.0-test',\n    workspace: {\n      workspaceFolders: [{ name: 'workspace', index: 0, uri: { fsPath: workspaceRoot } }],\n      workspaceFile: null\n    },\n    env: { clipboard: { async writeText() {} } }\n  };\n  return new VscodeRuntimeDiagnostics({\n    vscode,\n    context,\n    runtimeContext: context,\n    output: { appendLine() {} },\n    resolveNodeRuntimeImpl\n  });\n}\n\ntest('VS Code self-check fails when the actual Gateway Node runtime probe fails', () => {\n  const diagnostics = harness(() => { throw new Error('no usable Node runtime'); });\n  const result = diagnostics.selfCheck();\n  assert.equal(result.ok, false);\n  const runtime = result.checks.find(item => item.id === 'gateway-node-runtime');\n  assert.equal(runtime.ok, false);\n  assert.match(runtime.detail, /no usable Node runtime/);\n});\n\ntest('VS Code self-check reports the exact selected Gateway runtime', () => {\n  const diagnostics = harness(() => ({\n    source: 'path',\n    executable: 'C:\\\\Program Files\\\\nodejs\\\\node.exe',\n    nodeVersion: '24.18.0',\n    electronVersion: null\n  }));\n  const result = diagnostics.selfCheck();\n  assert.equal(result.ok, true);\n  assert.equal(result.gatewayRuntime.source, 'path');\n  assert.equal(result.gatewayRuntime.nodeVersion, '24.18.0');\n});\n`);

write('tests/tunnel-runtime-recovery.test.cjs', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst test = require('node:test');\nconst {\n  ATTACHMENT_POLL_MS,\n  clearTunnelController,\n  setTunnelController,\n  startTunnel,\n  stopTunnel\n} = require('../vscode-host/tunnel-runtime.js');\n\nfunction waitFor(predicate, timeoutMs = ATTACHMENT_POLL_MS + 1500) {\n  const deadline = Date.now() + timeoutMs;\n  return new Promise((resolve, reject) => {\n    const poll = () => {\n      const value = predicate();\n      if (value) return resolve(value);\n      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for tunnel recovery'));\n      setTimeout(poll, 20);\n    };\n    poll();\n  });\n}\n\ntest('Stop waits for in-flight follower recovery before final provider shutdown', async () => {\n  let starts = 0;\n  let stops = 0;\n  let releaseRecovery = null;\n  const controller = {\n    logger() {},\n    start() {\n      starts += 1;\n      if (starts === 1) return Promise.resolve({ attached: true, owned: false, publicUrl: 'https://shared.example.test' });\n      return new Promise(resolve => {\n        releaseRecovery = () => resolve({ attached: false, owned: true, publicUrl: 'https://recovered.example.test' });\n      });\n    },\n    status() { return { running: false, owned: false, attached: false }; },\n    async stop() { stops += 1; return { stopped: true, reason: '' }; }\n  };\n\n  setTunnelController(controller);\n  try {\n    await startTunnel(8787);\n    await waitFor(() => releaseRecovery);\n    let settled = false;\n    const stopping = stopTunnel().then(result => { settled = true; return result; });\n    await new Promise(resolve => setTimeout(resolve, 50));\n    assert.equal(settled, false, 'Stop must wait for recovery that already owns startup work');\n    releaseRecovery();\n    const result = await stopping;\n    assert.equal(result.stopped, true);\n    assert.equal(stops, 1);\n  } finally {\n    clearTunnelController(controller);\n  }\n});\n`);

// 12) Make the packaged VSIX smoke validate dependency closure and all packaged runtime sources.
update('scripts/smoke-vsix-runtime.mjs', text => {
  const helperAnchor = "function freePort() {\n  return new Promise((resolve, reject) => {\n    const server = http.createServer();\n    server.once('error', reject);\n    server.listen(0, '127.0.0.1', () => {\n      const port = server.address().port;\n      server.close(error => error ? reject(error) : resolve(port));\n    });\n  });\n}\n";
  const helpers = `${helperAnchor}\nfunction localModuleSpecifiers(source) {\n  const found = [];\n  const patterns = [\n    /\\b(?:import|export)\\s+(?:[^'\"\\x60]*?\\s+from\\s+)?['\"]([^'\"]+)['\"]/g,\n    /\\bimport\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)/g,\n    /\\brequire\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)/g\n  ];\n  for (const pattern of patterns) {\n    for (const match of source.matchAll(pattern)) if (match[1]?.startsWith('.')) found.push(match[1]);\n  }\n  return found;\n}\n\nfunction resolveLocalModule(file, specifier) {\n  const resolved = path.resolve(path.dirname(file), specifier);\n  const candidates = path.extname(resolved)\n    ? [resolved]\n    : [resolved, \`\${resolved}.js\`, \`\${resolved}.mjs\`, \`\${resolved}.cjs\`, \`\${resolved}.json\`, path.join(resolved, 'index.js'), path.join(resolved, 'index.mjs'), path.join(resolved, 'index.cjs')];\n  return candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) || '';\n}\n\nfunction assertDependencyClosure(entryFile, extensionPath) {\n  const queue = [entryFile];\n  const visited = new Set();\n  while (queue.length) {\n    const file = queue.pop();\n    if (visited.has(file)) continue;\n    visited.add(file);\n    const source = fs.readFileSync(file, 'utf8');\n    for (const specifier of localModuleSpecifiers(source)) {\n      const resolved = resolveLocalModule(file, specifier);\n      assert.ok(resolved, \`Packaged module missing: \${path.relative(extensionPath, file)} -> \${specifier}\`);\n      if (/\\.(?:js|mjs|cjs)$/i.test(resolved)) queue.push(resolved);\n    }\n  }\n  return visited;\n}\n\nfunction assertNoPrivateElectronNodeFlags(files) {\n  const forbidden = ['--ms-enable-electron', 'run-as-node'].join('-');\n  for (const file of files) {\n    const source = fs.readFileSync(file, 'utf8');\n    assert.equal(source.includes(forbidden), false, \`Unsupported private Electron Node flag packaged in \${file}\`);\n  }\n}\n`;
  text = replaceOnce(text, helperAnchor, helpers, 'VSIX dependency closure helpers');
  text = text.replace("    'vscode-host/bounded-http-client.js',\n", '');
  text = replaceOnce(
    text,
    "  const extensionSource = fs.readFileSync(path.join(extensionPath, 'extension.js'), 'utf8');\n  const runtimeIoSource = fs.readFileSync(path.join(extensionPath, 'vscode-host', 'runtime-io.js'), 'utf8');\n  assert.match(extensionSource, /resolveNodeRuntime/, 'VSIX must resolve a verified Node runtime before launching the Gateway');\n  assert.doesNotMatch(runtimeIoSource, /--ms-enable-electron-run-as-node/, 'VSIX must not inject unsupported Electron Node flags');",
    "  const extensionSource = fs.readFileSync(path.join(extensionPath, 'extension.js'), 'utf8');\n  const entryFile = path.join(extensionPath, manifest.main.replace(/^\\.\\//, ''));\n  const dependencyFiles = assertDependencyClosure(entryFile, extensionPath);\n  assertNoPrivateElectronNodeFlags(dependencyFiles);\n  assert.match(extensionSource, /resolveNodeRuntime/, 'VSIX must resolve a verified Node runtime before launching the Gateway');\n  assert.match(extensionSource, /host\\/runtime\\/network\\.js/, 'VSIX must use the shared Gateway health contract');\n  assert.doesNotMatch(extensionSource, /runtime-io\\.js|bounded-http-client\\.js/, 'VSIX must not package retired private runtime adapters');",
    'VSIX runtime source contract'
  );
  text = replaceOnce(
    text,
    "    providerNativeConnectionRuntimePackaged: true",
    "    providerNativeConnectionRuntimePackaged: true,\n    packagedDependencyClosureVerified: true,\n    privateElectronFlagsAbsent: true",
    'VSIX smoke result flags'
  );
  return text;
});

// 13) Keep docs aligned with the simplified runtime boundary.
update('docs/VSCODE_HOST_RUNTIME.md', text => replaceOnce(
  text,
  "The Gateway runs as a separate Node process through the shared `RuntimeController`. This isolates Gateway failures and long-running work from the VS Code Extension Host and uses the same startup lease, health check, ownership, stop, restart, and instance-lock semantics as other desktop hosts.\n\nThe Gateway bundle is self-contained. The installed VSIX does not depend on a repository-level `node_modules` directory.",
  "The Gateway runs as a separate Node process through the shared `RuntimeController`. Before Start, VS Code probes the same shared Node-runtime resolver used by the desktop host contract and requires a usable Node.js 24+ runtime. Unsupported private Electron CLI flags are not used. This isolates Gateway failures and long-running work from the VS Code Extension Host and uses the same startup lease, version-aware health check, ownership, stop, restart, and instance-lock semantics as other desktop hosts.\n\nThe Gateway bundle is self-contained. The installed VSIX accepts only `gateway/server.bundle.mjs` as its runtime Gateway entry; the raw source server is a build input, not a fallback execution path. The installed VSIX does not depend on a repository-level `node_modules` directory.",
  'VS Code runtime documentation'
));

update('docs/RUNTIME_CONCURRENCY.md', text => replaceOnce(
  text,
  "## Obsidian Node runtime\n\nThe Gateway requires Node.js 24 or newer. Obsidian resolves a verified Gateway runtime in this order:\n\n1. explicitly configured Node executable;\n2. the Obsidian/Electron executable when its embedded Node runtime is current and can run as Node;\n3. `node` from `PATH`.\n\nEach candidate is probed before launch. If no Node 24+ runtime is usable, startup fails with diagnostics rather than falling back to an incompatible renderer/Worker path.",
  "## Desktop Node runtime\n\nThe Gateway requires Node.js 24 or newer. Desktop hosts resolve a verified Gateway runtime before launch. VS Code probes its host runtime and then `node` from `PATH`; Obsidian additionally allows an explicitly configured Node executable. Electron hosts use `ELECTRON_RUN_AS_NODE=1` for the probe and launch and never rely on private Electron command-line flags.\n\nEach candidate is probed before launch. If no Node 24+ runtime is usable, host self-check fails and automatic startup is suppressed instead of attempting a known-broken Gateway launch.",
  'desktop Node runtime documentation'
));

console.log('Deep runtime hardening edits applied successfully.');
