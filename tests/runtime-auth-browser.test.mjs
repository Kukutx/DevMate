import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Store } from '../runtime/store.mjs';
import { createAuth } from '../runtime/auth.mjs';

// A real browser enforces what a request-level test cannot see: Chromium applies the
// page's form-action policy to the redirect that answers the form post.
const candidates = [process.env.DEVMATE_TEST_BROWSER, chromium.executablePath(),
  path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
const executablePath = candidates.find(value => fs.existsSync(value));
const issuer = 'https://devmate.example';
const claudeCode = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'oauth', 'claude-code.client.json'), 'utf8'));
const ipv6Client = { client_id: 'https://client.example/ipv6.json', client_name: 'IPv6 loopback fixture', redirect_uris: ['http://[::1]/callback'], grant_types: ['authorization_code', 'refresh_token'] };
const verifier = 'browser-verifier-'.repeat(4);
const listen = async (server, host) => { server.listen(0, host); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('a browser completes sign-in: the one-time code form reaches the client callback with code, state and iss',
  { skip: !executablePath ? 'No installed Chromium browser; set DEVMATE_TEST_BROWSER.' : false, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-auth-browser-'));
  const store = new Store(root);
  const auth = createAuth({ store, instanceRoot: root, config: { mode: 'oauth', issuer }, clientMetadata: async id => id === ipv6Client.client_id ? ipv6Client : claudeCode });
  const posts = [];
  // The authorization server as the ingress serves it. This loopback server stands in for
  // the HTTPS proxy in front of it, so the browser's own origin here is the public issuer.
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/authorize') posts.push({ origin: req.headers.origin, site: req.headers['sec-fetch-site'] });
    if (req.headers.origin === local) req.headers.origin = issuer;
    if (!await auth.handle(req, res, new URL(req.url, issuer))) { res.writeHead(404); res.end(); }
  });
  const local = 'http://127.0.0.1:' + await listen(server, '127.0.0.1');
  // What a native client does: listen on a port of its own choosing and wait for the redirect.
  const arrivals = [];
  const callbacks = [];
  async function callback(host) {
    const receiver = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (url.pathname !== '/callback') { res.writeHead(204); return res.end(); } // the browser also asks for a favicon
      arrivals.push(url); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Signed in</title>You can close this window.');
    });
    callbacks.push(receiver);
    return listen(receiver, host);
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { await browser.close(); await close(server); for (const receiver of callbacks) await close(receiver); auth.close(); store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const loginCode = () => auth.operations.find(op => op.name === 'auth.code.create').run({});
  const record = code => store.list('auth-code').find(item => item.hash === createHash('sha256').update(code).digest('hex'));

  const cases = [{ label: 'Claude Code on localhost', client: claudeCode, host: 'localhost', bind: '127.0.0.1' }, { label: 'Claude Code on 127.0.0.1', client: claudeCode, host: '127.0.0.1', bind: '127.0.0.1' }];
  const ipv6 = http.createServer();
  if (await listen(ipv6, '::1').then(() => true, () => false)) { await close(ipv6); cases.push({ label: 'IPv6 loopback', client: ipv6Client, host: '[::1]', bind: '::1' }); }
  for (const item of cases) {
    const port = await callback(item.bind), redirectUri = 'http://' + item.host + ':' + port + '/callback', state = 'state for ' + item.label;
    const page = await browser.newPage(), problems = [];
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('pageerror', error => problems.push(String(error)));
    const login = loginCode();
    await page.goto(local + '/oauth/authorize?' + new URLSearchParams({ client_id: item.client.client_id, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'devmate offline_access', state }));
    assert.equal(await page.title(), 'Authorize DevMate');
    assert.match(await page.locator('body').innerText(), new RegExp(item.client.client_name));
    assert.match(await page.locator('body').innerText(), /local application/);

    // A mistyped code shows the form again and spends nothing.
    await page.fill('input[name=authorization_code]', login.code + 'x');
    await Promise.all([page.waitForResponse(response => response.request().method() === 'POST'), page.click('button[type=submit]')]);
    await page.waitForSelector('.notice');
    assert.match(await page.locator('.notice').innerText(), /not valid/);
    assert.equal(record(login.code).status, 'active');
    problems.length = 0; // the 403 above is logged by the browser as a failed load

    await page.fill('input[name=authorization_code]', login.code);
    await page.click('button[type=submit]');
    await page.waitForURL(url => url.port === String(port) && url.pathname === '/callback', { timeout: 15000 }).catch(error => {
      throw new Error(item.label + ': the browser never reached the callback (' + page.url() + '). ' + problems.join(' | '), { cause: error });
    });
    const arrived = arrivals.at(-1);
    assert.equal(arrived.host, item.host + ':' + port, item.label);
    assert.deepEqual([...arrived.searchParams.keys()].sort(), ['code', 'iss', 'state']);
    assert.equal(arrived.searchParams.get('state'), state); assert.equal(arrived.searchParams.get('iss'), issuer);
    assert.equal(await page.title(), 'Signed in');
    assert.deepEqual(problems, [], item.label);
    assert.equal(record(login.code).status, 'used');

    const exchanged = await fetch(local + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: item.client.client_id,
      code: arrived.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirectUri, resource: issuer + '/mcp' }) });
    const tokens = await exchanged.json();
    assert.equal(exchanged.status, 200, JSON.stringify(tokens));
    assert.ok(auth.authenticate({ headers: { authorization: 'Bearer ' + tokens.access_token } })); assert.ok(tokens.refresh_token);
    await page.close();
  }
  assert.equal(arrivals.length, cases.length);
  // The browser marks its own form post as same-origin; with the page's no-referrer
  // policy the Origin header it sends is "null" rather than the page's origin.
  assert.equal(posts.length, cases.length * 2);
  for (const post of posts) { assert.equal(post.site, 'same-origin'); assert.ok(['null', local].includes(post.origin), post.origin); }
});
