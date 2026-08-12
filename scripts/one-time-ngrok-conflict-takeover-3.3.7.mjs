import fs from 'node:fs';

function replaceOnce(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing replacement anchor in ${file}: ${before.slice(0, 160)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous replacement anchor in ${file}: ${before.slice(0, 160)}`);
  fs.writeFileSync(file, `${source.slice(0, first)}${after}${source.slice(first + before.length)}`, 'utf8');
}

const agentFile = 'vscode-host/ngrok-agent-api.js';
replaceOnce(
  agentFile,
  `function normalizedPublicUrl(value) {\n`,
  `function loopbackUpstreamPort(value) {\n  const raw = String(value || '').trim();\n  if (!raw) return 0;\n  if (/^\\d+$/.test(raw)) {\n    const port = Number(raw);\n    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;\n  }\n  try {\n    const parsed = new URL(raw.includes('://') ? raw : \`http://\${raw}\`);\n    if (parsed.protocol !== 'http:' || !loopbackUpstreamHost(parsed.hostname)) return 0;\n    const port = Number(parsed.port || 80);\n    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;\n  } catch {\n    return 0;\n  }\n}\n\nfunction normalizedPublicUrl(value) {\n`
);

replaceOnce(
  agentFile,
  `async function discoverNgrokPublicUrl(port, {\n`,
  `function endpointIdentity(item, resource) {\n  const value = resource === 'tunnels'\n    ? (item?.name || item?.id || '')\n    : (item?.id || item?.name || '');\n  return String(value || '').trim();\n}\n\nfunction requestAgentDelete(apiBase, resource, identity, {\n  request = http.request,\n  timeoutMs = 1000\n} = {}) {\n  const value = String(identity || '').trim();\n  if (!value) return Promise.resolve(false);\n  const endpointUrl = \`\${String(apiBase).replace(/\\/$/, '')}/\${resource}/\${encodeURIComponent(value)}\`;\n  return new Promise(resolve => {\n    let settled = false;\n    const finish = value => {\n      if (settled) return;\n      settled = true;\n      resolve(value === true);\n    };\n    let req;\n    try {\n      req = request(endpointUrl, { method: 'DELETE' }, response => {\n        response.on?.('data', () => {});\n        response.on?.('end', () => finish([200, 202, 204, 404].includes(Number(response.statusCode))));\n      });\n      req.on?.('error', () => finish(false));\n      req.setTimeout?.(Math.max(250, Number(timeoutMs) || 1000), () => {\n        req.destroy?.();\n        finish(false);\n      });\n      req.end();\n    } catch {\n      finish(false);\n    }\n  });\n}\n\nfunction probeDevMateGateway(port, {\n  request = http.request,\n  timeoutMs = 500\n} = {}) {\n  const target = Number(port);\n  if (!Number.isInteger(target) || target <= 0 || target > 65535) return Promise.resolve(false);\n  return new Promise(resolve => {\n    let settled = false;\n    const chunks = [];\n    let bytes = 0;\n    const finish = value => {\n      if (settled) return;\n      settled = true;\n      resolve(value === true);\n    };\n    let req;\n    try {\n      req = request(\`http://127.0.0.1:\${target}/control/health\`, { method: 'GET' }, response => {\n        response.on?.('data', chunk => {\n          if (settled) return;\n          const buffer = Buffer.from(chunk);\n          bytes += buffer.length;\n          if (bytes > 16 * 1024) {\n            response.destroy?.();\n            finish(false);\n            return;\n          }\n          chunks.push(buffer);\n        });\n        response.on?.('end', () => {\n          if (settled || Number(response.statusCode) !== 200) return finish(false);\n          try {\n            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));\n            finish(body?.name === 'devmate');\n          } catch {\n            finish(false);\n          }\n        });\n      });\n      req.on?.('error', () => finish(false));\n      req.setTimeout?.(Math.max(100, Number(timeoutMs) || 500), () => {\n        req.destroy?.();\n        finish(false);\n      });\n      req.end();\n    } catch {\n      finish(false);\n    }\n  });\n}\n\nasync function localNgrokEndpointCandidates(port, {\n  apiBase = DEFAULT_NGROK_AGENT_API_BASE,\n  request = http.request,\n  timeoutMs = 1000\n} = {}) {\n  if (!apiBase) return [];\n  const target = Number(port);\n  const resources = ['tunnels', 'endpoints'];\n  const collected = [];\n  for (const resource of resources) {\n    const payload = await requestAgentCollection(apiBase, resource, { request, timeoutMs });\n    const items = collectionItems(payload, resource);\n    for (const item of items) {\n      const upstreamPort = loopbackUpstreamPort(endpointUpstreamUrl(item));\n      const publicUrl = endpointPublicUrl(item);\n      const identity = endpointIdentity(item, resource);\n      if (!identity || !publicUrl.startsWith('https://') || !upstreamPort || upstreamPort === target) continue;\n      collected.push({ resource, identity, publicUrl, upstreamPort });\n    }\n    if (collected.length && resource === 'tunnels') break;\n  }\n  const unique = new Map();\n  for (const item of collected) {\n    const key = \`\${item.publicUrl}|\${item.upstreamPort}\`;\n    if (!unique.has(key)) unique.set(key, item);\n  }\n  return [...unique.values()];\n}\n\nasync function stopConflictingLocalNgrokEndpoints(port, {\n  apiBase = DEFAULT_NGROK_AGENT_API_BASE,\n  request = http.request,\n  timeoutMs = 1000\n} = {}) {\n  const candidates = await localNgrokEndpointCandidates(port, { apiBase, request, timeoutMs });\n  if (!candidates.length) return { stopped: 0, candidates: 0, ambiguous: false, endpoints: [] };\n\n  const verified = [];\n  for (const candidate of candidates) {\n    if (await probeDevMateGateway(candidate.upstreamPort, { request, timeoutMs: Math.min(750, timeoutMs) })) {\n      verified.push(candidate);\n    }\n  }\n\n  const selected = verified.length ? verified : (candidates.length === 1 ? candidates : []);\n  if (!selected.length) {\n    return { stopped: 0, candidates: candidates.length, ambiguous: true, endpoints: candidates };\n  }\n\n  const stopped = [];\n  for (const candidate of selected) {\n    const ok = await requestAgentDelete(apiBase, candidate.resource, candidate.identity, { request, timeoutMs });\n    if (ok) stopped.push(candidate);\n  }\n  return {\n    stopped: stopped.length,\n    candidates: candidates.length,\n    ambiguous: false,\n    endpoints: stopped\n  };\n}\n\nasync function discoverNgrokPublicUrl(port, {\n`
);

replaceOnce(
  agentFile,
  `  loopbackAgentApiBase,\n  loopbackUpstreamHost,\n  ngrokWebAddrFromConfig,\n  resolveNgrokAgentApiBase,\n  upstreamMatchesPort,\n`,
  `  localNgrokEndpointCandidates,\n  loopbackAgentApiBase,\n  loopbackUpstreamHost,\n  loopbackUpstreamPort,\n  ngrokWebAddrFromConfig,\n  probeDevMateGateway,\n  requestAgentDelete,\n  resolveNgrokAgentApiBase,\n  stopConflictingLocalNgrokEndpoints,\n  upstreamMatchesPort,\n`
);

const controllerFile = 'vscode-host/tunnel-controller.js';
replaceOnce(
  controllerFile,
  `const {\n  discoverNgrokPublicUrl,\n  resolveNgrokAgentApiBase\n} = require('./ngrok-agent-api.js');\n`,
  `const {\n  discoverNgrokPublicUrl,\n  resolveNgrokAgentApiBase,\n  stopConflictingLocalNgrokEndpoints\n} = require('./ngrok-agent-api.js');\n`
);

replaceOnce(
  controllerFile,
  `      const output = this.childOutput(child);\n      if (!childActive(child)) {\n`,
  `      const output = this.childOutput(child);\n      if (launch.provider === 'ngrok' && classifyNgrokError(output)?.kind === 'endpoint-conflict') {\n        await this.waitForProviderOutput(child, 100);\n        throw providerStartupError(match.provider, this.childOutput(child), child, { secrets: this.childSecrets(child) });\n      }\n      if (!childActive(child)) {\n`
);

replaceOnce(
  controllerFile,
  `  async spawnProvider(match, { preserveOwner = false } = {}) {\n`,
  `  async spawnProvider(match, { preserveOwner = false, conflictRecovery = true } = {}) {\n`
);

replaceOnce(
  controllerFile,
  `      if (launch.provider === 'ngrok' && error?.code === 'DEVMATE_NGROK_ENDPOINT_CONFLICT') {\n        const reusableUrl = await this.reusableLocalNgrokUrl(match, launch).catch(() => '');\n        if (reusableUrl) {\n          if (this.child === child) this.child = null;\n          return this.adoptExistingNgrok(match, ownerId, reusableUrl, launch.agentApiBase);\n        }\n      }\n      if (this.child === child) this.child = null;\n      this.resetOwnership(ownerId);\n      throw error;\n`,
  `      if (launch.provider === 'ngrok' && error?.code === 'DEVMATE_NGROK_ENDPOINT_CONFLICT') {\n        const reusableUrl = await this.reusableLocalNgrokUrl(match, launch).catch(() => '');\n        if (reusableUrl) {\n          if (this.child === child) this.child = null;\n          return this.adoptExistingNgrok(match, ownerId, reusableUrl, launch.agentApiBase);\n        }\n        if (conflictRecovery && launch.agentApiBase) {\n          const recovery = await stopConflictingLocalNgrokEndpoints(match.port, {\n            apiBase: launch.agentApiBase,\n            request: this.httpRequest,\n            timeoutMs: 1000\n          }).catch(reconcileError => ({ stopped: 0, error: reconcileError }));\n          if (recovery.stopped > 0) {\n            const summary = recovery.endpoints\n              .map(item => \`\${item.publicUrl} -> 127.0.0.1:\${item.upstreamPort}\`)\n              .join(', ');\n            this.logger(\`Stopped stale local ngrok endpoint(s) after ERR_NGROK_334: \${summary}. Retrying the current DevMate Gateway once.\`);\n            if (this.child === child) this.child = null;\n            this.resetOwnership(ownerId);\n            return this.spawnProvider(match, { preserveOwner: false, conflictRecovery: false });\n          }\n          if (recovery.ambiguous) {\n            this.logger('ERR_NGROK_334 recovery found multiple non-DevMate local ngrok endpoints and left them untouched.');\n          }\n        }\n      }\n      if (this.child === child) this.child = null;\n      this.resetOwnership(ownerId);\n      throw error;\n`
);

const recoveryTest = 'tests/ngrok-runtime-recovery.test.cjs';
replaceOnce(
  recoveryTest,
  `const { discoverNgrokPublicUrl } = require('../vscode-host/ngrok-agent-api.js');\n`,
  `const {\n  discoverNgrokPublicUrl,\n  stopConflictingLocalNgrokEndpoints\n} = require('../vscode-host/ngrok-agent-api.js');\n`
);

const testAppend = `\n\ntest('ERR_NGROK_334 recovery stops a stale local DevMate ngrok endpoint before retry', async () => {\n  const calls = [];\n  const request = (url, options, callback) => {\n    const req = new EventEmitter();\n    req.setTimeout = () => {};\n    req.destroy = () => {};\n    req.end = () => {\n      const method = String(options?.method || 'GET').toUpperCase();\n      const target = String(url);\n      calls.push({ method, target });\n      const response = new EventEmitter();\n      response.destroy = () => {};\n      let status = 404;\n      let payload;\n      if (method === 'GET' && target.endsWith('/api/tunnels')) {\n        status = 200;\n        payload = { tunnels: [{ name: 'stale-devmate', public_url: 'https://default.ngrok.app', config: { addr: 'http://127.0.0.1:8787' } }] };\n      } else if (method === 'GET' && target.endsWith(':8787/control/health')) {\n        status = 200;\n        payload = { name: 'devmate', version: '3.3.6' };\n      } else if (method === 'DELETE' && target.endsWith('/api/tunnels/stale-devmate')) {\n        status = 204;\n      }\n      response.statusCode = status;\n      callback(response);\n      queueMicrotask(() => {\n        if (payload !== undefined) response.emit('data', Buffer.from(JSON.stringify(payload)));\n        response.emit('end');\n      });\n    };\n    return req;\n  };\n\n  const result = await stopConflictingLocalNgrokEndpoints(8788, {\n    apiBase: 'http://127.0.0.1:4040/api',\n    request,\n    timeoutMs: 250\n  });\n  assert.equal(result.stopped, 1);\n  assert.equal(result.ambiguous, false);\n  assert.equal(result.endpoints[0].upstreamPort, 8787);\n  assert.equal(calls.some(call => call.method === 'DELETE' && call.target.endsWith('/api/tunnels/stale-devmate')), true);\n});\n\ntest('ERR_NGROK_334 recovery does not delete ambiguous unrelated local ngrok endpoints', async () => {\n  const deleted = [];\n  const request = (url, options, callback) => {\n    const req = new EventEmitter();\n    req.setTimeout = () => {};\n    req.destroy = () => {};\n    req.end = () => {\n      const method = String(options?.method || 'GET').toUpperCase();\n      const target = String(url);\n      const response = new EventEmitter();\n      response.destroy = () => {};\n      let status = 404;\n      let payload;\n      if (method === 'GET' && target.endsWith('/api/tunnels')) {\n        status = 200;\n        payload = { tunnels: [\n          { name: 'one', public_url: 'https://one.ngrok.app', config: { addr: 'http://127.0.0.1:3000' } },\n          { name: 'two', public_url: 'https://two.ngrok.app', config: { addr: 'http://127.0.0.1:4000' } }\n        ] };\n      } else if (method === 'DELETE') {\n        deleted.push(target);\n        status = 204;\n      }\n      response.statusCode = status;\n      callback(response);\n      queueMicrotask(() => {\n        if (payload !== undefined) response.emit('data', Buffer.from(JSON.stringify(payload)));\n        response.emit('end');\n      });\n    };\n    return req;\n  };\n\n  const result = await stopConflictingLocalNgrokEndpoints(8788, {\n    apiBase: 'http://127.0.0.1:4040/api',\n    request,\n    timeoutMs: 250\n  });\n  assert.equal(result.stopped, 0);\n  assert.equal(result.ambiguous, true);\n  assert.deepEqual(deleted, []);\n});\n\ntest('TunnelController performs real local endpoint reconciliation instead of wait-only ERR334 retries', () => {\n  const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'vscode-host', 'tunnel-controller.js'), 'utf8');\n  assert.match(source, /stopConflictingLocalNgrokEndpoints/);\n  assert.match(source, /conflictRecovery/);\n  assert.match(source, /Stopped stale local ngrok endpoint/);\n});\n`;
const recoverySource = fs.readFileSync(recoveryTest, 'utf8');
if (!recoverySource.includes("ERR_NGROK_334 recovery stops a stale local DevMate ngrok endpoint before retry")) {
  fs.writeFileSync(recoveryTest, recoverySource.trimEnd() + testAppend, 'utf8');
}

replaceOnce(
  recoveryTest,
  `const assert = require('node:assert/strict');\nconst { EventEmitter } = require('node:events');\nconst test = require('node:test');\n`,
  `const assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst { EventEmitter } = require('node:events');\nconst test = require('node:test');\n`
);

const docsFile = 'docs/NGROK_SETUP.md';
replaceOnce(
  docsFile,
  `If ngrok briefly reports that the same endpoint is already active, DevMate now treats that as a recoverable lifecycle condition: duplicate Start requests are coalesced, the local Agent is re-queried through both current and legacy-compatible endpoint views, and bounded retries allow a just-stopped or concurrently-starting DevMate session to converge without user cleanup.\n\nOnly a persistent conflict that cannot be verified as the current loopback Gateway is surfaced to the user. In that case, determine whether another Agent is intentionally serving the same ngrok account/domain.\n`,
  `If ngrok reports that the same endpoint is already active, DevMate treats it as a recoverable lifecycle condition. Duplicate Start requests are coalesced and the local Agent is re-queried through current and legacy-compatible endpoint views. When ERR_NGROK_334 is caused by a stale local ngrok endpoint, DevMate now identifies the conflicting loopback endpoint, prefers endpoints whose upstream is a DevMate Gateway, stops that stale local endpoint through the Agent API, and retries the current Gateway once automatically.\n\nIf several unrelated local ngrok endpoints are present, DevMate leaves them untouched rather than guessing. A persistent conflict with no safely identifiable local endpoint is surfaced as an account/domain conflict instead of silently enabling pooling or routing MCP traffic to the wrong workspace.\n`
);

const changelogFile = 'CHANGELOG.md';
replaceOnce(
  changelogFile,
  `# Changelog\n\n## 3.3.6\n`,
  `# Changelog\n\n## 3.3.7\n\n- Fixed the remaining ERR_NGROK_334 startup regression by performing real local Agent reconciliation instead of wait-only retries.\n- Detects stale local ngrok endpoints that forward to another loopback Gateway, verifies DevMate upstreams when possible, stops the conflicting local endpoint through the Agent API, and retries the requested DevMate Gateway once.\n- Detects endpoint-conflict output immediately so Start no longer waits the full provider readiness timeout before recovery.\n- Keeps ambiguous unrelated local ngrok endpoints untouched and still refuses to enable pooling implicitly.\n\n## 3.3.6\n`
);

console.log('Applied DevMate 3.3.7 local ngrok conflict recovery patch.');
