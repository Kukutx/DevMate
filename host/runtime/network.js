'use strict';

const http = require('node:http');
const net = require('node:net');
const { DEFAULT_PORT } = require('./constants.js');

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
  return httpJson(`http://127.0.0.1:${port}/control/health`, timeoutMs);
}

function healthMatches(health, config) {
  return !!(
    health?.ok &&
    health.json?.name === 'devmate' &&
    (!config?.instanceId || health.json.instanceId === config.instanceId)
  );
}

function isPortFree(port) {
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
    try { server.listen(port, '127.0.0.1'); }
    catch { finish(false); }
  });
}

async function choosePort(config, preferredPort = DEFAULT_PORT) {
  const base = Number(config?.server?.port || preferredPort || DEFAULT_PORT);
  for (let port = base; port < base + 20; port += 1) {
    const health = await healthAt(port, 600);
    if (healthMatches(health, config)) return { port, attached: true };
    if (!health.ok && await isPortFree(port)) return { port, attached: false };
  }
  throw new Error(`No free DevMate port found from ${base} to ${base + 19}`);
}

module.exports = {
  MAX_HTTP_JSON_BYTES,
  choosePort,
  healthAt,
  healthMatches,
  httpJson,
  isPortFree
};
