'use strict';

const https = require('node:https');
const runtimeIo = require('./runtime-io.js');

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MIN_MAX_RESPONSE_BYTES = 1024;
const MAX_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 4000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 120000;

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

function defaultTransports() {
  return {
    http: { request: (...args) => runtimeIo.httpRequest(...args) },
    https
  };
}

function requestRaw(
  url,
  options = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  transports = null
) {
  return new Promise(resolve => {
    let target;
    try {
      target = url instanceof URL ? url : new URL(url);
    } catch (error) {
      resolve({ ok: false, error: `bad url: ${error.message || error}` });
      return;
    }

    const timeout = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const limit = boundedInteger(
      maxBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_MAX_RESPONSE_BYTES,
      MAX_MAX_RESPONSE_BYTES
    );
    const effectiveTransports = transports || defaultTransports();
    const transport = target.protocol === 'https:' ? effectiveTransports.https : effectiveTransports.http;
    if (!transport?.request || !['http:', 'https:'].includes(target.protocol)) {
      resolve({ ok: false, error: `unsupported protocol: ${target.protocol || '(missing)'}` });
      return;
    }

    let request = null;
    let response = null;
    let timer = null;
    let settled = false;
    let bytes = 0;

    const finish = value => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(value);
      return true;
    };

    const abort = (error, extra = {}) => {
      if (!finish({ ok: false, error, bytes, maxBytes: limit, ...extra })) return;
      try { response?.destroy(); } catch {}
      try { request?.destroy(); } catch {}
    };

    try {
      request = transport.request(target, {
        method: options?.method || 'GET',
        headers: options?.headers || {},
        agent: options?.agent
      }, incoming => {
        response = incoming;
        const advertisedLength = Number(incoming.headers?.['content-length']);
        if (Number.isFinite(advertisedLength) && advertisedLength > limit) {
          abort('response-too-large', {
            status: incoming.statusCode,
            contentLength: advertisedLength
          });
          return;
        }

        const chunks = [];
        incoming.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > limit) {
            abort('response-too-large', { status: incoming.statusCode });
            return;
          }
          chunks.push(buffer);
        });
        incoming.on('aborted', () => abort('response-aborted', { status: incoming.statusCode }));
        incoming.on('error', error => abort(error.message || String(error), { status: incoming.statusCode }));
        incoming.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          finish({
            ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
            status: incoming.statusCode,
            headers: incoming.headers,
            body: text,
            json,
            bytes,
            maxBytes: limit
          });
        });
      });
    } catch (error) {
      finish({ ok: false, error: error.message || String(error), bytes, maxBytes: limit });
      return;
    }

    timer = setTimeout(() => abort('timeout'), timeout);
    timer.unref?.();
    request.on('error', error => {
      if (settled) return;
      finish({ ok: false, error: error.message || String(error), bytes, maxBytes: limit });
    });

    try {
      if (body !== null) {
        request.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      }
      request.end();
    } catch (error) {
      abort(error.message || String(error));
    }
  });
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_MAX_RESPONSE_BYTES,
  MIN_TIMEOUT_MS,
  boundedInteger,
  defaultTransports,
  requestRaw
};
