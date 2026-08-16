'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_NGROK_AGENT_API_BASE,
  configPathFromCheckOutput,
  discoverNgrokPublicUrl,
  loopbackAgentApiBase,
  ngrokWebAddrFromConfig,
  resolveNgrokAgentApiBase,
  upstreamMatchesPort
} = require('../vscode-host/ngrok-agent-api.js');

function fakeRequest(payload, { statusCode = 200, capture = null } = {}) {
  return (url, options, callback) => {
    capture?.(url, options);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(JSON.stringify(payload)));
        response.emit('end');
      });
    };
    return request;
  };
}

test('reads only current v3 agent.web_addr without treating other YAML keys as agent settings', () => {
  assert.equal(ngrokWebAddrFromConfig('version: 3\nagent:\n  web_addr: "127.0.0.1:4242"\nendpoints: []\n'), '127.0.0.1:4242');
  assert.equal(ngrokWebAddrFromConfig('agent:\n  web_addr: 127.0.0.1:4141\n'), null);
  assert.equal(ngrokWebAddrFromConfig('version: 3\nagent:\n  authtoken: x\nendpoints:\n  - name: web_addr\n'), null);
  assert.equal(ngrokWebAddrFromConfig('version: 3\nagent:\n  web_addr: false\n'), 'false');
});

test('normalizes only local Agent API addresses and fails closed for disabled, invalid, or nonlocal bindings', () => {
  assert.equal(loopbackAgentApiBase(null), DEFAULT_NGROK_AGENT_API_BASE);
  assert.equal(loopbackAgentApiBase('127.0.0.1:4141'), 'http://127.0.0.1:4141/api');
  assert.equal(loopbackAgentApiBase('localhost:4242'), 'http://127.0.0.1:4242/api');
  assert.equal(loopbackAgentApiBase('0.0.0.0:4343'), 'http://127.0.0.1:4343/api');
  assert.equal(loopbackAgentApiBase('false'), '');
  assert.equal(loopbackAgentApiBase('https://remote.example.com:4040'), '');
  assert.equal(loopbackAgentApiBase('remote.example.com:4040'), '');
});

test('config check output resolves the active v3 config and web_addr without changing ngrok config', () => {
  assert.equal(configPathFromCheckOutput('Valid configuration file at C:\\Users\\Dev\\AppData\\Local\\ngrok\\ngrok.yml\n'), 'C:\\Users\\Dev\\AppData\\Local\\ngrok\\ngrok.yml');
  const calls = [];
  const configFile = path.resolve('fixtures', 'ngrok', 'ngrok.yml');
  const api = resolveNgrokAgentApiBase('ngrok', {
    spawnSync(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: `Valid configuration file at ${configFile}\n`, stderr: '' };
    },
    readFile(file) {
      assert.equal(file, configFile);
      return 'version: 3\nagent:\n  web_addr: 127.0.0.1:4545\n';
    }
  });
  assert.equal(api, 'http://127.0.0.1:4545/api');
  assert.deepEqual(calls, [['ngrok', ['config', 'check']]]);
});

test('current endpoint API matches only endpoint.url plus endpoint.upstream.url', async () => {
  let requested = '';
  const url = await discoverNgrokPublicUrl(8787, {
    apiBase: 'http://127.0.0.1:4545/api',
    request: fakeRequest({
      endpoints: [
        { url: 'https://wrong.ngrok.app', upstream: { url: 'http://localhost:9000' } },
        { url: 'http://insecure.ngrok.app', upstream: { url: 'http://localhost:8787' } },
        { url: 'https://ready.ngrok.app', upstream: { url: 'http://127.0.0.1:8787' } }
      ]
    }, { capture: value => { requested = value; } })
  });
  assert.equal(requested, 'http://127.0.0.1:4545/api/endpoints');
  assert.equal(url, 'https://ready.ngrok.app');
  assert.equal(upstreamMatchesPort('8787', 8787), true);
  assert.equal(upstreamMatchesPort('localhost:8787', 8787), true);
  assert.equal(upstreamMatchesPort('http://127.0.0.2:8787', 8787), true);
  assert.equal(upstreamMatchesPort('http://[::1]:8787', 8787), true);
  assert.equal(upstreamMatchesPort('http://192.168.1.20:8787', 8787), false);
  assert.equal(upstreamMatchesPort('https://localhost:8787', 8787), false);
});
