'use strict';

const http = require('node:http');
const net = require('node:net');
const { DEFAULT_PORT } = require('./constants.js');

function httpJson(url, timeoutMs = 1500) {
  return new Promise(resolve => {
    let request;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      request = http.get(url, { timeout: timeoutMs }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          finish({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            json,
            text
          });
        });
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
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
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
  choosePort,
  healthAt,
  healthMatches,
  httpJson,
  isPortFree
};
