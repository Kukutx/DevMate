import fs from 'node:fs';

function replaceOnce(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing replacement anchor in ${file}: ${before.slice(0, 120)}`);
  if (source.indexOf(before, index + before.length) >= 0) throw new Error(`Ambiguous replacement anchor in ${file}`);
  fs.writeFileSync(file, `${source.slice(0, index)}${after}${source.slice(index + before.length)}`, 'utf8');
}

replaceOnce(
  'vscode-host/ngrok-agent-api.js',
`function discoverNgrokPublicUrl(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000
} = {}) {
  if (!apiBase) return Promise.resolve('');
  const endpointUrl = \`${'${String(apiBase).replace(/\\/$/, \'\')}'}/endpoints\`;
`,
`function discoverNgrokPublicUrl(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  expectedUrl = ''
} = {}) {
  if (!apiBase) return Promise.resolve('');
  const endpointUrl = \`${'${String(apiBase).replace(/\\/$/, \'\')}'}/endpoints\`;
  const expected = String(expectedUrl || '').trim();
`
);

replaceOnce(
  'vscode-host/ngrok-agent-api.js',
`            const match = (payload?.endpoints || []).find(item =>
              upstreamMatchesPort(item?.upstream?.url, port) && String(item?.url || '').startsWith('https://')
            );
`,
`            const match = (payload?.endpoints || []).find(item => {
              const url = String(item?.url || '').trim();
              return upstreamMatchesPort(item?.upstream?.url, port) &&
                url.startsWith('https://') &&
                (!expected || url === expected);
            });
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`    this.child = null;
    this.childReady = false;
    this.port = 0;
`,
`    this.child = null;
    this.childReady = false;
    this.borrowedProvider = false;
    this.port = 0;
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`    this.restartCount = 0;
    this.childReady = false;
    this.ownershipFailureCount = 0;
`,
`    this.restartCount = 0;
    this.childReady = false;
    this.borrowedProvider = false;
    this.ownershipFailureCount = 0;
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`  async providerReadyUrl(launch, match, child, timeoutMs) {
`,
`  async reusableLocalNgrokUrl(match, launch) {
    if (launch.provider !== 'ngrok' || !launch.agentApiBase) return '';
    return discoverNgrokPublicUrl(match.port, {
      apiBase: launch.agentApiBase,
      request: this.httpRequest,
      timeoutMs: 750,
      expectedUrl: launch.publicUrl || ''
    });
  }

  adoptExistingNgrok(match, ownerId, publicUrl) {
    const url = normalizePublicUrl(publicUrl);
    this.ownerId = ownerId;
    this.port = match.port;
    this.child = null;
    this.childReady = false;
    this.borrowedProvider = true;
    this.store.write(ownerId, {
      hostId: this.hostId,
      childPid: null,
      port: match.port,
      provider: match.provider,
      configurationKey: match.configurationKey,
      status: 'ready',
      publicUrl: url,
      readyAt: nowIso()
    });
    this.startHeartbeat();
    this.logger(`Reusing existing local ngrok endpoint ${'${url}'} for Gateway port ${'${match.port}'}; DevMate will detach rather than terminate that pre-existing ngrok process on Stop.`);
    return this.store.read();
  }

  async providerReadyUrl(launch, match, child, timeoutMs) {
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`    if (!preserveOwner) {
      this.ownerId = \`${'${this.hostId}'}-tunnel-${'${process.pid}'}-${'${Date.now().toString(36)}'}-${'${crypto.randomBytes(5).toString(\'hex\')}'}\`;
      this.restartCount = 0;
      this.ownershipFailureCount = 0;
    }
`,
`    if (!preserveOwner) {
      this.ownerId = \`${'${this.hostId}'}-tunnel-${'${process.pid}'}-${'${Date.now().toString(36)}'}-${'${crypto.randomBytes(5).toString(\'hex\')}'}\`;
      this.restartCount = 0;
      this.borrowedProvider = false;
      this.ownershipFailureCount = 0;
    }
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`        if (!launch.agentApiBase && !launch.publicUrl) {
          const error = new Error('ngrok local Agent API is disabled; configure a stable ngrok URL or enable agent web_addr');
          error.code = 'DEVMATE_NGROK_AGENT_API_DISABLED';
          throw error;
        }
      }

      child = this.childProcess.spawn(launch.command, launch.args, launch.options);
`,
`        if (!launch.agentApiBase && !launch.publicUrl) {
          const error = new Error('ngrok local Agent API is disabled; configure a stable ngrok URL or enable agent web_addr');
          error.code = 'DEVMATE_NGROK_AGENT_API_DISABLED';
          throw error;
        }
        const reusableUrl = await this.reusableLocalNgrokUrl(match, launch);
        if (reusableUrl) return this.adoptExistingNgrok(match, ownerId, reusableUrl);
      }

      child = this.childProcess.spawn(launch.command, launch.args, launch.options);
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`      if (child && childActive(child) && !cleanup.exited) {
        error.cleanupPending = true;
        error.cleanupReason = cleanup.error || 'process-exit-timeout';
        this.logger(\`Tunnel startup cleanup did not confirm provider exit: ${'${error.cleanupReason}'}\`);
        throw error;
      }
      if (this.child === child) this.child = null;
      this.resetOwnership(ownerId);
      throw error;
`,
`      if (child && childActive(child) && !cleanup.exited) {
        error.cleanupPending = true;
        error.cleanupReason = cleanup.error || 'process-exit-timeout';
        this.logger(\`Tunnel startup cleanup did not confirm provider exit: ${'${error.cleanupReason}'}\`);
        throw error;
      }
      if (launch.provider === 'ngrok' && error?.code === 'DEVMATE_NGROK_ENDPOINT_CONFLICT') {
        const reusableUrl = await this.reusableLocalNgrokUrl(match, launch).catch(() => '');
        if (reusableUrl) {
          if (this.child === child) this.child = null;
          return this.adoptExistingNgrok(match, ownerId, reusableUrl);
        }
      }
      if (this.child === child) this.child = null;
      this.resetOwnership(ownerId);
      throw error;
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`  async start(port) {
`,
`  resultForRecord(record) {
    const local = !!record && record.ownerId === this.ownerId;
    const borrowed = local && this.borrowedProvider;
    return {
      attached: !!record && (!local || borrowed),
      owned: !!record && local && !borrowed,
      publicUrl: record?.publicUrl || '',
      record
    };
  }

  async start(port) {
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`      if (ready) return { attached: ready.ownerId !== this.ownerId, owned: ready.ownerId === this.ownerId, publicUrl: ready.publicUrl, record: ready };
`,
`      if (ready) return this.resultForRecord(ready);
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`        return { attached: true, owned: false, publicUrl: acquired.publicUrl, record: acquired };
`,
`        return this.resultForRecord(acquired);
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`        return { attached: true, owned: false, publicUrl: ready.publicUrl, record: ready };
`,
`        return this.resultForRecord(ready);
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`      const record = await this.spawnProvider(match);
      return { attached: false, owned: true, publicUrl: record.publicUrl, record };
`,
`      const record = await this.spawnProvider(match);
      return this.resultForRecord(record);
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`    return {
      running: !!record,
      owned: !!record && record.ownerId === this.ownerId,
      attached: !!record && record.ownerId !== this.ownerId,
      publicUrl: record?.publicUrl || '',
`,
`    const result = this.resultForRecord(record);
    return {
      running: !!record,
      owned: result.owned,
      attached: result.attached,
      publicUrl: record?.publicUrl || '',
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`    this.stopping = true;
    try {
      const result = await this.terminateLocalChild();
`,
`    if (this.borrowedProvider) {
      this.stopping = true;
      try {
        const publicUrl = record.publicUrl;
        this.resetOwnership(this.ownerId);
        return { stopped: true, detached: true, reason: 'detached-existing-provider', publicUrl };
      } finally {
        this.stopping = false;
      }
    }
    this.stopping = true;
    try {
      const result = await this.terminateLocalChild();
`
);

replaceOnce(
  'vscode-host/tunnel-controller.js',
`    } else if (childActive(this.child) || (this.ownerId && this.store.read()?.ownerId === this.ownerId)) {
`,
`    } else if (childActive(this.child) || (!this.borrowedProvider && this.ownerId && this.store.read()?.ownerId === this.ownerId)) {
`
);

replaceOnce(
  'vscode-host/context-mirror.js',
`const { currentWorkspaceRoot, runtimeConfigPath } = require('./runtime-context.js');

class VscodeContextMirror {
`,
`const { currentWorkspaceRoot, runtimeConfigPath } = require('./runtime-context.js');

function contextSignature(value) {
  if (!value || typeof value !== 'object') return '';
  return JSON.stringify({
    workspaceRoot: value.workspaceRoot || '',
    activeEditor: value.activeEditor || null,
    visibleEditors: Array.isArray(value.visibleEditors) ? value.visibleEditors : [],
    diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : []
  });
}

class VscodeContextMirror {
`
);

replaceOnce(
  'vscode-host/context-mirror.js',
`    const capturedAt = vscodeContext.capturedAt || null;
    if (current.hostContexts?.vscode?.capturedAt === capturedAt) return false;
`,
`    const capturedAt = vscodeContext.capturedAt || null;
    if (contextSignature(current.hostContexts?.vscode) === contextSignature(vscodeContext)) return false;
`
);

replaceOnce(
  'vscode-host/context-mirror.js',
`    try {
      if (this.mirrorOnce()) this.diagnostics?.append('Mirrored VS Code editor context into shared host context.');
`,
`    try {
      this.mirrorOnce();
`
);

replaceOnce(
  'vscode-host/context-mirror.js',
`module.exports = {
  VscodeContextMirror
};
`,
`module.exports = {
  VscodeContextMirror,
  contextSignature
};
`
);

fs.writeFileSync('tests/ngrok-existing-endpoint-reuse.test.cjs', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst { EventEmitter } = require('node:events');\nconst test = require('node:test');\nconst { TunnelController } = require('../vscode-host/tunnel-controller.js');\n\nfunction fakeRequest(payload) {\n  return (_url, _options, callback) => {\n    const request = new EventEmitter();\n    request.setTimeout = () => {};\n    request.destroy = () => {};\n    request.end = () => {\n      const response = new EventEmitter();\n      response.statusCode = 200;\n      response.destroy = () => {};\n      callback(response);\n      queueMicrotask(() => {\n        response.emit('data', Buffer.from(JSON.stringify(payload)));\n        response.emit('end');\n      });\n    };\n    return request;\n  };\n}\n\nfunction fakeChildProcess(onSpawn) {\n  return {\n    spawn(command, args) {\n      onSpawn(command, args);\n      throw new Error('unexpected provider spawn');\n    },\n    spawnSync(_command, args) {\n      if (args[0] === 'version') return { status: 0, stdout: 'ngrok version 3.40.0\\n', stderr: '' };\n      return { status: 1, stdout: '', stderr: '' };\n    }\n  };\n}\n\nfunction settings(overrides = {}) {\n  return { provider: 'ngrok', ngrokCommandPath: 'ngrok', ngrokUseManagedAccount: false, autoRestart: false, maxRestarts: 0, ...overrides };\n}\n\ntest('reuses an existing local ngrok endpoint for the same Gateway port without spawning or pooling', async () => {\n  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-reuse-'));\n  let spawns = 0;\n  const controller = new TunnelController({\n    stateDirectory,\n    settings,\n    childProcess: fakeChildProcess(() => { spawns += 1; }),\n    httpRequest: fakeRequest({ endpoints: [{ name: 'existing', url: 'https://ready.ngrok.app', upstream: { url: 'http://127.0.0.1:8788' }, pooling_enabled: false }] })\n  });\n  try {\n    const started = await controller.start(8788);\n    assert.equal(spawns, 0);\n    assert.equal(started.publicUrl, 'https://ready.ngrok.app');\n    assert.equal(started.attached, true);\n    assert.equal(started.owned, false);\n    const status = controller.status(8788);\n    assert.equal(status.attached, true);\n    assert.equal(status.owned, false);\n    const stopped = await controller.stop();\n    assert.equal(stopped.detached, true);\n    assert.equal(stopped.reason, 'detached-existing-provider');\n  } finally {\n    await controller.dispose({ stopOwned: true }).catch(() => {});\n    fs.rmSync(stateDirectory, { recursive: true, force: true });\n  }\n});\n\ntest('does not reuse a local ngrok endpoint when a different stable URL was requested', async () => {\n  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-reuse-url-'));\n  let spawns = 0;\n  const controller = new TunnelController({\n    stateDirectory,\n    settings: () => settings({ ngrokUrl: 'https://expected.ngrok.app' }),\n    childProcess: fakeChildProcess(() => { spawns += 1; }),\n    httpRequest: fakeRequest({ endpoints: [{ name: 'other', url: 'https://other.ngrok.app', upstream: { url: 'http://127.0.0.1:8788' } }] })\n  });\n  try {\n    await assert.rejects(() => controller.start(8788), /unexpected provider spawn/);\n    assert.equal(spawns, 1);\n  } finally {\n    await controller.dispose({ stopOwned: true }).catch(() => {});\n    fs.rmSync(stateDirectory, { recursive: true, force: true });\n  }\n});\n`, 'utf8');

fs.writeFileSync('tests/context-mirror-dedup.test.cjs', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst test = require('node:test');\nconst { contextSignature } = require('../vscode-host/context-mirror.js');\n\ntest('VS Code context mirroring ignores timestamp-only churn', () => {\n  const base = { workspaceRoot: 'C:/repo', activeEditor: { path: 'a.js' }, visibleEditors: [{ path: 'a.js' }], diagnostics: [] };\n  assert.equal(contextSignature({ ...base, capturedAt: '2026-01-01T00:00:00Z' }), contextSignature({ ...base, capturedAt: '2026-01-01T00:00:01Z', updatedAt: 'later' }));\n  assert.notEqual(contextSignature(base), contextSignature({ ...base, activeEditor: { path: 'b.js' } }));\n});\n\ntest('context mirror does not log successful mirrors into the same Output surface it observes', () => {\n  const source = fs.readFileSync(path.resolve(__dirname, '..', 'vscode-host', 'context-mirror.js'), 'utf8');\n  assert.doesNotMatch(source, /Mirrored VS Code editor context into shared host context/);\n});\n`, 'utf8');

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const entry = `## 3.3.3\n\n- Reuse a pre-existing local ngrok endpoint when it already forwards to the current DevMate Gateway port, instead of starting a duplicate endpoint and hitting ERR_NGROK_334.\n- Never auto-enable ngrok pooling: a different local/remote endpoint or mismatched stable URL still fails closed rather than load-balancing MCP traffic to an unintended target.\n- Treat reused ngrok processes as attached rather than owned so DevMate Stop detaches without terminating a provider it did not start.\n- Remove the VS Code context-mirror feedback loop by deduplicating semantic editor state and eliminating success logs that changed the observed Output surface.\n\n`;
if (!changelog.includes('## 3.3.3')) fs.writeFileSync('CHANGELOG.md', changelog.replace('# Changelog\n\n', `# Changelog\n\n${entry}`), 'utf8');
