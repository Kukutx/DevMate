import fs from 'node:fs';

function replaceRegion(file, startMarker, endMarker, replacement) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker in ${file}: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing end marker in ${file}: ${endMarker}`);
  fs.writeFileSync(file, `${source.slice(0, start)}${replacement}${source.slice(end)}`, 'utf8');
}

function replaceOnce(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing replacement anchor in ${file}: ${before.slice(0, 120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous replacement anchor in ${file}`);
  fs.writeFileSync(file, `${source.slice(0, first)}${after}${source.slice(first + before.length)}`, 'utf8');
}

const runtimeFile = 'vscode-host/tunnel-runtime.js';
replaceOnce(
  runtimeFile,
  "const ATTACHMENT_POLL_MS = 1000;\n\nlet controller = null;\nlet attachmentTimer = null;\nlet attachmentPort = 0;\nlet attachmentRecoveryPromise = null;\nlet sessionRequested = false;",
  "const ATTACHMENT_POLL_MS = 1000;\nconst NGROK_CONFLICT_RETRY_DELAYS_MS = Object.freeze([250, 750, 1500, 3000, 5000]);\n\nlet controller = null;\nlet attachmentTimer = null;\nlet attachmentPort = 0;\nlet attachmentRecoveryPromise = null;\nlet startOperation = null;\nlet sessionRequested = false;"
);

replaceRegion(
  runtimeFile,
  'async function startTunnel(port) {',
  'async function stopTunnel() {',
`function retryableNgrokConflict(error) {
  return error?.code === 'DEVMATE_NGROK_ENDPOINT_CONFLICT';
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startTunnelAttempt(current, port) {
  let attempt = 0;
  while (true) {
    try {
      return await current.start(port);
    } catch (error) {
      const delayMs = NGROK_CONFLICT_RETRY_DELAYS_MS[attempt];
      if (!retryableNgrokConflict(error) || delayMs == null) throw error;
      attempt += 1;
      current.logger?.(
        'ngrok reported a transient endpoint conflict; waiting ' + delayMs +
        'ms and reconciling the local Agent before retry ' + attempt +
        '/' + NGROK_CONFLICT_RETRY_DELAYS_MS.length + '.'
      );
      await wait(delayMs);
    }
  }
}

async function startTunnel(port) {
  const current = tunnelController();
  const requestedPort = Number(port) || 0;
  if (startOperation) {
    if (startOperation.controller === current && startOperation.port === requestedPort) {
      return startOperation.promise;
    }
    await startOperation.promise.catch(() => null);
  }

  let operation;
  operation = (async () => {
    try {
      const result = await startTunnelAttempt(current, requestedPort);
      sessionRequested = true;
      if (result?.attached) startAttachmentWatcher(requestedPort);
      else stopAttachmentWatcher();
      return result;
    } catch (error) {
      sessionRequested = false;
      stopAttachmentWatcher();
      throw error;
    }
  })();
  startOperation = { controller: current, port: requestedPort, promise: operation };
  try {
    return await operation;
  } finally {
    if (startOperation?.promise === operation) startOperation = null;
  }
}

`
);

replaceOnce(
  runtimeFile,
  `async function stopTunnel() {
  const current = tunnelController();
  sessionRequested = false;
  stopAttachmentWatcher();
  const pendingRecovery = attachmentRecoveryPromise;
  if (pendingRecovery) await pendingRecovery.catch(() => null);
  return current.stop();
}`,
  `async function stopTunnel() {
  const current = tunnelController();
  sessionRequested = false;
  stopAttachmentWatcher();
  const pendingStart = startOperation?.controller === current ? startOperation.promise : null;
  if (pendingStart) await pendingStart.catch(() => null);
  const pendingRecovery = attachmentRecoveryPromise;
  if (pendingRecovery) await pendingRecovery.catch(() => null);
  return current.stop();
}`
);

replaceOnce(
  runtimeFile,
  `  ATTACHMENT_POLL_MS,
  clearTunnelController,`,
  `  ATTACHMENT_POLL_MS,
  NGROK_CONFLICT_RETRY_DELAYS_MS,
  clearTunnelController,`
);

const apiFile = 'vscode-host/ngrok-agent-api.js';
replaceRegion(
  apiFile,
  'function discoverNgrokPublicUrl(port, {',
  'module.exports = {',
`function normalizedPublicUrl(value) {
  return String(value || '').trim().replace(/\\/$/, '');
}

function endpointPublicUrl(item) {
  return normalizedPublicUrl(item?.url || item?.public_url || item?.publicUrl || '');
}

function endpointUpstreamUrl(item) {
  return String(
    item?.upstream?.url ||
    item?.upstream?.uri ||
    item?.upstream_url ||
    item?.upstreamUrl ||
    item?.config?.addr ||
    item?.config?.upstream ||
    ''
  ).trim();
}

function collectionItems(payload, resource) {
  if (resource === 'endpoints') return Array.isArray(payload?.endpoints) ? payload.endpoints : [];
  if (resource === 'tunnels') return Array.isArray(payload?.tunnels) ? payload.tunnels : [];
  return [];
}

function requestAgentCollection(apiBase, resource, {
  request = http.request,
  timeoutMs = 1000
} = {}) {
  const endpointUrl = \`${'${String(apiBase).replace(/\\/$/, \'\')}'}\/${'${resource}'}\`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    let req;
    try {
      req = request(endpointUrl, { method: 'GET' }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_NGROK_AGENT_RESPONSE_BYTES) {
            response.destroy();
            finish(null);
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled || response.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(null);
          }
        });
      });
      req.on('error', () => finish(null));
      req.setTimeout(Math.max(250, Number(timeoutMs) || 1000), () => {
        req.destroy();
        finish(null);
      });
      req.end();
    } catch {
      finish(null);
    }
  });
}

async function discoverNgrokPublicUrl(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  expectedUrl = ''
} = {}) {
  if (!apiBase) return '';
  const expected = normalizedPublicUrl(expectedUrl);
  for (const resource of ['endpoints', 'tunnels']) {
    const payload = await requestAgentCollection(apiBase, resource, { request, timeoutMs });
    const match = collectionItems(payload, resource).find(item => {
      const url = endpointPublicUrl(item);
      return upstreamMatchesPort(endpointUpstreamUrl(item), port) &&
        url.startsWith('https://') &&
        (!expected || url === expected);
    });
    if (match) return endpointPublicUrl(match);
  }
  return '';
}

`
);

replaceOnce(
  apiFile,
  `  configPathFromCheckOutput,
  discoverNgrokPublicUrl,`,
  `  collectionItems,
  configPathFromCheckOutput,
  discoverNgrokPublicUrl,
  endpointPublicUrl,
  endpointUpstreamUrl,`
);

const testFile = 'tests/ngrok-runtime-recovery.test.cjs';
fs.writeFileSync(testFile, `'use strict';\n\nconst assert = require('node:assert/strict');\nconst { EventEmitter } = require('node:events');\nconst test = require('node:test');\nconst { discoverNgrokPublicUrl } = require('../vscode-host/ngrok-agent-api.js');\nconst {\n  clearTunnelController,\n  setTunnelController,\n  startTunnel,\n  stopTunnel\n} = require('../vscode-host/tunnel-runtime.js');\n\nfunction responseRequest(routes) {\n  return (url, _options, callback) => {\n    const request = new EventEmitter();\n    request.setTimeout = () => {};\n    request.destroy = () => {};\n    request.end = () => {\n      const response = new EventEmitter();\n      const route = routes.find(item => String(url).endsWith(item.suffix));\n      response.statusCode = route?.status ?? 404;\n      response.destroy = () => {};\n      callback(response);\n      queueMicrotask(() => {\n        if (route?.payload !== undefined) response.emit('data', Buffer.from(JSON.stringify(route.payload)));\n        response.emit('end');\n      });\n    };\n    return request;\n  };\n}\n\ntest('ngrok discovery falls back to the legacy tunnels Agent API shape', async () => {\n  const publicUrl = await discoverNgrokPublicUrl(8788, {\n    apiBase: 'http://127.0.0.1:4040/api',\n    request: responseRequest([\n      { suffix: '/endpoints', status: 404 },\n      { suffix: '/tunnels', status: 200, payload: { tunnels: [\n        { public_url: 'https://legacy.ngrok.app', config: { addr: 'http://127.0.0.1:8788' } }\n      ] } }\n    ]),\n    timeoutMs: 250\n  });\n  assert.equal(publicUrl, 'https://legacy.ngrok.app');\n});\n\ntest('ngrok discovery accepts alternate current upstream field names while keeping exact loopback-port checks', async () => {\n  const publicUrl = await discoverNgrokPublicUrl(8788, {\n    apiBase: 'http://127.0.0.1:4040/api',\n    request: responseRequest([\n      { suffix: '/endpoints', status: 200, payload: { endpoints: [\n        { url: 'https://current.ngrok.app', upstream_url: 'http://localhost:8788' }\n      ] } }\n    ]),\n    timeoutMs: 250\n  });\n  assert.equal(publicUrl, 'https://current.ngrok.app');\n});\n\ntest('duplicate Start calls for one port converge on one tunnel start operation', async () => {\n  let starts = 0;\n  let release;\n  const gate = new Promise(resolve => { release = resolve; });\n  const controller = {\n    logger() {},\n    status() { return { running: false, owned: false, attached: false }; },\n    async start() {\n      starts += 1;\n      await gate;\n      return { attached: false, owned: true, publicUrl: 'https://ready.ngrok.app' };\n    },\n    async stop() { return { stopped: true }; }\n  };\n  setTunnelController(controller);\n  try {\n    const first = startTunnel(8788);\n    const second = startTunnel(8788);\n    await new Promise(resolve => setImmediate(resolve));\n    assert.equal(starts, 1);\n    release();\n    const [a, b] = await Promise.all([first, second]);\n    assert.equal(a.publicUrl, 'https://ready.ngrok.app');\n    assert.equal(b.publicUrl, 'https://ready.ngrok.app');\n    assert.equal(starts, 1);\n  } finally {\n    release?.();\n    await stopTunnel().catch(() => {});\n    clearTunnelController(controller);\n  }\n});\n\ntest('transient ERR_NGROK_334 is reconciled automatically instead of failing the user Start', async () => {\n  let starts = 0;\n  const controller = {\n    logger() {},\n    status() { return { running: false, owned: false, attached: false }; },\n    async start() {\n      starts += 1;\n      if (starts === 1) {\n        const error = new Error('ngrok endpoint is already online');\n        error.code = 'DEVMATE_NGROK_ENDPOINT_CONFLICT';\n        throw error;\n      }\n      return { attached: true, owned: false, publicUrl: 'https://reused.ngrok.app' };\n    },\n    async stop() { return { stopped: true }; }\n  };\n  setTunnelController(controller);\n  try {\n    const result = await startTunnel(8788);\n    assert.equal(starts, 2);\n    assert.equal(result.publicUrl, 'https://reused.ngrok.app');\n  } finally {\n    await stopTunnel().catch(() => {});\n    clearTunnelController(controller);\n  }\n});\n`, 'utf8');

const docsFile = 'docs/NGROK_SETUP.md';
replaceOnce(
  docsFile,
  `If ngrok reports that the same endpoint is already active in another Agent/session, first determine whether that Agent is intentionally serving the same DevMate instance.\n\nUseful actions include:`,
  `If ngrok briefly reports that the same endpoint is already active, DevMate now treats that as a recoverable lifecycle condition: duplicate Start requests are coalesced, the local Agent is re-queried through both current and legacy-compatible endpoint views, and bounded retries allow a just-stopped or concurrently-starting DevMate session to converge without user cleanup.\n\nOnly a persistent conflict that cannot be verified as the current loopback Gateway is surfaced to the user. In that case, determine whether another Agent is intentionally serving the same ngrok account/domain.\n\nUseful actions include:`
);

const changelogFile = 'CHANGELOG.md';
replaceOnce(
  changelogFile,
  '# Changelog\n\n',
  `# Changelog\n\n## 3.3.6\n\n- Restored zero-friction ngrok startup by coalescing concurrent Start requests and automatically reconciling transient ERR_NGROK_334 conflicts instead of immediately tearing the session down.\n- Made local ngrok endpoint discovery compatible with both the current /api/endpoints response shapes and the legacy /api/tunnels shape while preserving exact loopback Gateway-port validation.\n- Serialized Stop behind an in-flight tunnel Start so automatic Start, manual Start, Restart, reload, and teardown cannot create a duplicate provider race.\n- Added regression coverage for duplicate Start convergence, transient endpoint-conflict recovery, alternate Agent API fields, and legacy Agent API fallback.\n\n`
);

console.log('Applied DevMate 3.3.6 ngrok runtime recovery patch.');
