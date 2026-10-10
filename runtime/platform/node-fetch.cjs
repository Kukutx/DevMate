'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');

/**
 * The few parts of fetch() the runtime client uses, on Node's own HTTP client.
 * An editor host is not always a plain Node process: inside an Electron window
 * (Obsidian) the global fetch is the browser's. That one adds the page's origin
 * to every request and applies cross-origin rules, and the local control port
 * rightly refuses a foreign origin. Node's HTTP client is the same everywhere.
 * Only loopback HTTP is ever requested through this.
 */
function nodeFetch(input, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const url = new URL(String(input));
    if (url.protocol !== 'http:') return reject(new TypeError('Only local HTTP is requested through this client.'));
    const request = http.request(url, { method, headers, agent: false });
    const abort = () => request.destroy(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const done = () => signal?.removeEventListener('abort', abort);
    request.once('error', error => {
      done();
      // The caller tells "nothing listens there" from other failures by the cause, as with the built-in fetch.
      reject(signal?.aborted ? signal.reason : Object.assign(new TypeError('fetch failed'), { cause: error }));
    });
    request.once('response', response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        done(); request.destroy();
        return reject(new TypeError('The runtime answered with a redirect, which is never followed.'));
      }
      response.once('close', done);
      // A stream cut off by an abort ends with the reason of that abort.
      const stream = Readable.toWeb(response);
      resolve({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: name => { const value = response.headers[String(name).toLowerCase()]; return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value; } },
        body: stream,
        async text() { let text = ''; const decoder = new TextDecoder(); for await (const chunk of stream) text += decoder.decode(chunk, { stream: true }); return text + decoder.decode(); },
        async json() { return JSON.parse(await this.text()); }
      });
    });
    request.end(body === undefined ? undefined : body);
  });
}

module.exports = { nodeFetch };
