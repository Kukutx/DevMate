'use strict';

const http = require('node:http');
const net = require('node:net');
const { DEFAULT_PORT, strictPort } = require('../../shared/port.cjs');

const MAX_HTTP_JSON_BYTES = 64 * 1024;

function httpJson(url, timeoutMs = 1500, maxBytes = MAX_HTTP_JSON_BYTES) {
  return new Promise(resolve => {
    let request;
    let settled = false;
    const limit = Math.max(1024, Number(maxBytes) || MAX_HTTP_JSON_BYTES);
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      request = http.get(url, { timeout: timeoutMs }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > limit) {
            response.destroy();
            request.destroy();
            finish({
              ok: false,
              status: response.statusCode,
              error: 'response-too-large',
              bytes,
              maxBytes: limit,
              json: null,
              text: ''
            });
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          finish({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            json,
            text,
            bytes
          });
        });
        response.on('error', error => finish({ ok: false, status: response.statusCode, error: error.message }));
      });
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', error => finish({ ok: false, error: error.message }));
  });
}

function healthAt(port, timeoutMs = 1500) {
  const validPort = strictPort(port, { label: 'Gateway port' });
  return httpJson(`http://127.0.0.1:${validPort}/control/health`, timeoutMs);
}

function healthMatches(health, config) {
  const expectedVersion = String(config?.appVersion || '').trim();
  return !!(
    health?.ok &&
    health.json?.name === 'devmate' &&
    (!config?.instanceId || health.json.instanceId === config.instanceId) &&
    (!expectedVersion || health.json.version === expectedVersion)
  );
}

function isPortFree(port) {
  const validPort = strictPort(port, { label: 'Gateway port' });
  return new Promise(resolve => {
    const server = net.createServer();
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => server.close(() => finish(true)));
    try { server.listen(validPort, '127.0.0.1'); }
    catch { finish(false); }
  });
}

function sameDevMateInstance(health, config) {
  return !!(
    health?.ok &&
    health.json?.name === 'devmate' &&
    (!config?.instanceId || health.json.instanceId === config.instanceId)
  );
}

function portConflict(port, health, config) {
  const sameInstance = sameDevMateInstance(health, config);
  const runningVersion = String(health?.json?.version || '').trim();
  const expectedVersion = String(config?.appVersion || '').trim();
  const error = new Error(sameInstance
    ? `DevMate Gateway port ${port} is still occupied by this machine's ${runningVersion || 'older'} Gateway while ${expectedVersion || 'the current host'} is starting. DevMate will wait for the shared runtime handoff instead of moving to another port.`
    : `DevMate Gateway port ${port} is already in use. DevMate keeps the configured Gateway port stable and will not move to another port automatically.`);
  error.code = sameInstance ? 'DEVMATE_GATEWAY_STALE_INSTANCE' : 'DEVMATE_GATEWAY_PORT_CONFLICT';
  error.port = port;
  error.sameInstance = sameInstance;
  error.runningVersion = runningVersion || null;
  error.expectedVersion = expectedVersion || null;
  error.health = health?.json || null;
  return error;
}

async function choosePort(config, preferredPort = DEFAULT_PORT) {
  const port = strictPort(config?.server?.port ?? preferredPort, { label: 'Gateway port' });
  const health = await healthAt(port, 600);
  if (healthMatches(health, config)) return { port, attached: true };
  if (!health.ok && await isPortFree(port)) return { port, attached: false };
  if (sameDevMateInstance(health, config)) {
    return { port, attached: false, stale: true, health: health.json };
  }
  throw portConflict(port, health, config);
}

module.exports = {
  MAX_HTTP_JSON_BYTES,
  choosePort,
  healthAt,
  healthMatches,
  httpJson,
  isPortFree,
  portConflict,
  sameDevMateInstance
};
