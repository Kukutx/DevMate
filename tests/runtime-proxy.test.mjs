import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';
import { createOutboundProxy, environmentProxy, shownProxy, windowsSystemProxy } from '../runtime/platform/proxy.mjs';
import { createClientMetadataResolver } from '../runtime/auth-client.mjs';
import { createOpenAiTunnel } from '../runtime/openai-tunnel.mjs';

const registry = values => () => 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n' +
  Object.entries(values).map(([name, value]) => '    ' + name + '    ' + (typeof value === 'number' ? 'REG_DWORD    0x' + value.toString(16) : 'REG_SZ    ' + value)).join('\r\n') + '\r\n';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('the proxy comes from the environment, or on Windows from the system setting of the account', () => {
  assert.equal(environmentProxy({}), null);
  assert.deepEqual(environmentProxy({ https_proxy: 'http://10.0.0.1:8080', NO_PROXY: 'a.example, .b.example' }),
    { source: 'environment', https: 'http://10.0.0.1:8080', http: 'http://10.0.0.1:8080', bypass: ['a.example', '.b.example'] });
  assert.deepEqual(environmentProxy({ HTTP_PROXY: 'http://plain:1', HTTPS_PROXY: 'http://secure:2' }), { source: 'environment', https: 'http://secure:2', http: 'http://plain:1', bypass: [] });
  assert.equal(environmentProxy({ ALL_PROXY: 'http://all:3' }).https, 'http://all:3');
  // One address for everything, as Clash and most tools set it.
  assert.deepEqual(windowsSystemProxy(registry({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890', ProxyOverride: 'localhost;127.*;10.*;192.168.*;*.corp.example;<local>' })),
    { source: 'system', https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', bypass: ['localhost', '127.0.0.0-127.255.255.255', '10.0.0.0-10.255.255.255', '192.168.0.0-192.168.255.255', '*.corp.example'] });
  assert.deepEqual(windowsSystemProxy(registry({ ProxyEnable: 1, ProxyServer: 'http=proxy.example:80;https=secure.example:443;ftp=old:21' })),
    { source: 'system', https: 'http://secure.example:443', http: 'http://proxy.example:80', bypass: [] });
  // Set but switched off, as it is while such a tool is not running: no proxy.
  assert.equal(windowsSystemProxy(registry({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' })), null);
  assert.equal(windowsSystemProxy(registry({})), null);
  assert.equal(windowsSystemProxy(() => { throw new Error('no registry here'); }), null);
  // What cannot be used is said, not guessed at.
  assert.deepEqual(windowsSystemProxy(registry({ ProxyEnable: 0, AutoConfigURL: 'http://wpad/proxy.pac' })), { source: 'system', script: true });
  assert.deepEqual(windowsSystemProxy(registry({ ProxyEnable: 1, ProxyServer: 'socks=127.0.0.1:1080' })), { source: 'system', unsupported: 'only a SOCKS proxy is set' });
  assert.equal(shownProxy('http://user:secret@proxy.example:3128/'), 'http://proxy.example:3128');
  assert.equal(shownProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('it is applied once, switched when the system setting is, and this computer itself is never asked through it', () => {
  const applied = [];
  let restored = 0, system = null;
  const proxy = createOutboundProxy({ env: {}, platform: 'win32', system: () => system, apply: settings => { applied.push(settings); return () => { restored++; }; } });
  assert.equal(proxy.current(), null); assert.equal(proxy.refresh(), false); assert.deepEqual(applied, []);
  system = { source: 'system', https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', bypass: ['*.corp.example', 'localhost'] };
  assert.equal(proxy.refresh(), true);
  assert.deepEqual(applied, [{ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1,*.corp.example' }]);
  assert.deepEqual(proxy.current(), { source: 'system', proxy: 'http://127.0.0.1:7890', settings: applied[0] });
  assert.equal(proxy.refresh(), false, 'nothing changed, nothing is applied again'); assert.equal(applied.length, 1);
  // The owner switches the proxy off: back to direct, and the earlier setting is undone.
  system = null;
  assert.equal(proxy.refresh(), true); assert.equal(restored, 1); assert.equal(proxy.current(), null);
  system = { source: 'system', script: true };
  assert.equal(proxy.refresh(), true); assert.deepEqual(proxy.current(), { source: 'system', script: true }); assert.equal(applied.length, 1);
  // The variables win over the system setting, and another system is never asked for one.
  const fromEnvironment = createOutboundProxy({ env: { HTTPS_PROXY: 'http://user:pw@corp:3128' }, platform: 'win32', system: () => { throw new Error('not asked'); }, apply: settings => { applied.push(settings); return () => {}; } });
  assert.deepEqual(fromEnvironment.current().proxy, 'http://corp:3128'); assert.equal(applied.at(-1).HTTPS_PROXY, 'http://user:pw@corp:3128');
  assert.equal(createOutboundProxy({ env: {}, platform: 'linux', system: () => { throw new Error('not asked'); }, apply: () => () => {} }).current(), null);
});

test('the doctor says which proxy is in force and names a setting it cannot use', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-proxy-doctor-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const owner = { id: 'owner', surface: 'local' };
  const line = async current => { service.proxy = current === undefined ? null : { current: () => current }; return (await service.call('runtime.doctor', {}, owner)).checks.find(check => check.id === 'proxy'); };
  assert.equal(await line(undefined), undefined, 'nothing to say when the process serves no proxy setting');
  assert.equal(await line(null), undefined, 'and nothing when requests go directly');
  assert.deepEqual(await line({ source: 'system', proxy: 'http://127.0.0.1:7890', settings: {} }), { id: 'proxy', status: 'ok', detail: 'Requests to the outside go through http://127.0.0.1:7890 (the system proxy of this account).' });
  assert.match((await line({ source: 'environment', proxy: 'http://corp:3128', settings: {} })).detail, /HTTPS_PROXY \/ HTTP_PROXY variables/);
  const script = await line({ source: 'system', script: true });
  assert.equal(script.status, 'warn'); assert.match(script.detail, /proxy script/); assert.match(script.fix, /HTTPS_PROXY/);
  assert.match((await line({ source: 'system', unsupported: 'only a SOCKS proxy is set' })).detail, /only a SOCKS proxy is set/);
});

test('with a proxy in force the runtime\'s own requests reach it: the tunnel service, and a sign-in client\'s metadata', async t => {
  const seen = [];
  // A stand-in proxy: it answers plain requests itself and refuses to open tunnels, which is enough to see who asks it.
  const stand = http.createServer((req, res) => {
    seen.push('GET ' + req.url);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messages: [] }));
  });
  stand.on('connect', (req, socket) => { seen.push('CONNECT ' + req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  const local = http.createServer((req, res) => { res.writeHead(200); res.end('direct'); });
  const proxyUrl = 'http://127.0.0.1:' + await listen(stand), localUrl = 'http://127.0.0.1:' + await listen(local) + '/';
  const proxy = createOutboundProxy({ env: { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl }, platform: 'linux' });
  t.after(() => { proxy.stop(); stand.close(); local.close(); });
  // This computer itself is reached directly.
  assert.equal(await (await fetch(localUrl)).text(), 'direct'); assert.deepEqual(seen, []);
  // The tunnel client polls OpenAI's service through the proxy; here that tunnel cannot be opened, which it reports.
  const tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', runtimeKeyEnv: 'CONTROL_PLANE_API_KEY', env: { CONTROL_PLANE_API_KEY: 'sk-proxy-test' }, localMcpUrl: localUrl + 'mcp',
    instanceId: 'instance', pollTimeoutMs: 1000, pause: () => new Promise(resolve => setTimeout(resolve, 20)) });
  await tunnel.start().catch(() => {});
  for (let attempt = 0; attempt < 100 && !seen.includes('CONNECT api.openai.com:443'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  await tunnel.stop();
  assert.ok(seen.includes('CONNECT api.openai.com:443'), seen.join());
  // A client's metadata document: fetched through the proxy, and only under a public name.
  const resolver = createClientMetadataResolver({ proxy: () => proxy.current().settings, lookup: () => { throw new Error('the name is not looked up here'); } });
  await assert.rejects(resolver('https://client.devmate-proxy-test.example/metadata.json'), /Client metadata request failed/);
  assert.ok(seen.includes('CONNECT client.devmate-proxy-test.example:443'), seen.join());
  for (const local of ['https://192.168.1.10/client.json', 'https://intranet/client.json', 'https://build.corp/client.json', 'https://printer.local/client.json'])
    await assert.rejects(resolver(local), /public host name/, local);
  assert.equal(seen.filter(item => /192\.168|intranet|corp|printer/.test(item)).length, 0, 'nothing on the local network was asked for');
  // Switched off again, requests go directly.
  proxy.stop();
  await assert.rejects(fetch('http://origin.devmate-proxy-test.invalid/'), error => error.cause?.code === 'ENOTFOUND');
});
