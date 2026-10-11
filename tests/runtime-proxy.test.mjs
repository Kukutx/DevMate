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

test('the proxy comes from the environment, or on Windows from the system setting of the account', async () => {
  assert.equal(environmentProxy({}), null);
  assert.deepEqual(environmentProxy({ https_proxy: 'http://10.0.0.1:8080', NO_PROXY: 'a.example, .b.example' }),
    { source: 'environment', https: 'http://10.0.0.1:8080', http: 'http://10.0.0.1:8080', bypass: ['a.example', '.b.example'] });
  assert.deepEqual(environmentProxy({ HTTP_PROXY: 'http://plain:1', HTTPS_PROXY: 'http://secure:2' }), { source: 'environment', https: 'http://secure:2', http: 'http://plain:1', bypass: [] });
  assert.equal(environmentProxy({ ALL_PROXY: 'http://all:3' }).https, 'http://all:3');
  // One address for everything, as Clash and most tools set it.
  assert.deepEqual(await windowsSystemProxy(registry({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890', ProxyOverride: 'localhost;127.*;10.*;192.168.*;*.corp.example;<local>' })),
    { source: 'system', https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', bypass: ['localhost', '127.0.0.0-127.255.255.255', '10.0.0.0-10.255.255.255', '192.168.0.0-192.168.255.255', '*.corp.example'] });
  assert.deepEqual(await windowsSystemProxy(registry({ ProxyEnable: 1, ProxyServer: 'http=proxy.example:80;https=secure.example:443;ftp=old:21' })),
    { source: 'system', https: 'http://secure.example:443', http: 'http://proxy.example:80', bypass: [] });
  // Set but switched off, as it is while such a tool is not running: no proxy.
  assert.equal(await windowsSystemProxy(registry({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' })), null);
  assert.equal(await windowsSystemProxy(registry({})), null);
  assert.equal(await windowsSystemProxy(() => { throw new Error('no registry here'); }), null);
  assert.equal(await windowsSystemProxy(() => Promise.reject(new Error('the system did not answer in time'))), null);
  // What cannot be used is said, not guessed at.
  assert.deepEqual(await windowsSystemProxy(registry({ ProxyEnable: 0, AutoConfigURL: 'http://wpad/proxy.pac' })), { source: 'system', script: true });
  assert.deepEqual(await windowsSystemProxy(registry({ ProxyEnable: 1, ProxyServer: 'socks=127.0.0.1:1080' })), { source: 'system', unsupported: 'only a SOCKS proxy is set' });
  assert.equal(shownProxy('http://user:secret@proxy.example:3128/'), 'http://proxy.example:3128');
  assert.equal(shownProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('it is applied once, switched when the system setting is, and this computer itself is never asked through it', async () => {
  const applied = [];
  let restored = 0, system = null, asked = 0;
  const proxy = createOutboundProxy({ env: {}, platform: 'win32', system: async () => { asked++; return system; }, apply: settings => { applied.push(settings); return () => { restored++; }; } });
  assert.equal(proxy.current(), null); assert.equal(await proxy.refresh(), false); assert.deepEqual(applied, []);
  // Asked twice at the same moment, the system is asked once.
  assert.deepEqual(await Promise.all([proxy.refresh(), proxy.refresh()]), [false, false]); assert.equal(asked, 2);
  system = { source: 'system', https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', bypass: ['*.corp.example', 'localhost'] };
  assert.equal(await proxy.refresh(), true);
  assert.deepEqual(applied, [{ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1,*.corp.example' }]);
  assert.deepEqual(proxy.current(), { source: 'system', proxy: 'http://127.0.0.1:7890', settings: applied[0] });
  assert.equal(await proxy.refresh(), false, 'nothing changed, nothing is applied again'); assert.equal(applied.length, 1);
  // The owner switches the proxy off: back to direct, and the earlier setting is undone.
  system = null;
  assert.equal(await proxy.refresh(), true); assert.equal(restored, 1); assert.equal(proxy.current(), null);
  system = { source: 'system', script: true };
  assert.equal(await proxy.refresh(), true); assert.deepEqual(proxy.current(), { source: 'system', script: true }); assert.equal(applied.length, 1);
  // The variables win over the system setting, and another system is never asked for one.
  const fromEnvironment = createOutboundProxy({ env: { HTTPS_PROXY: 'http://user:pw@corp:3128' }, platform: 'win32', system: () => { throw new Error('not asked'); }, apply: settings => { applied.push(settings); return () => {}; } });
  await fromEnvironment.refresh();
  assert.deepEqual(fromEnvironment.current().proxy, 'http://corp:3128'); assert.equal(applied.at(-1).HTTPS_PROXY, 'http://user:pw@corp:3128');
  const elsewhere = createOutboundProxy({ env: {}, platform: 'linux', system: () => { throw new Error('not asked'); }, apply: () => () => {} });
  assert.equal(await elsewhere.refresh(), false); assert.equal(elsewhere.current(), null);
  // A Node from before 24.14 cannot do this. It starts all the same, and what is in force says why requests go directly.
  const older = createOutboundProxy({ env: { HTTPS_PROXY: 'http://corp:3128' }, platform: 'linux', apply: null });
  assert.equal(await older.refresh(), true);
  assert.deepEqual(Object.keys(older.current()).sort(), ['source', 'unsupported']); assert.match(older.current().unsupported, /^Node\.js \S+ cannot send its own requests through a proxy; that takes Node\.js 24\.14 or newer$/);
  const without = createOutboundProxy({ env: {}, platform: 'linux', apply: null });
  assert.equal(await without.refresh(), false); assert.equal(without.current(), null, 'with no proxy set there is nothing to say');
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
  const socks = await line({ source: 'system', unsupported: 'only a SOCKS proxy is set' });
  assert.match(socks.detail, /only a SOCKS proxy is set/); assert.match(socks.fix, /HTTPS_PROXY/);
  const older = await line({ source: 'environment', unsupported: 'Node.js 24.3.0 cannot send its own requests through a proxy; that takes Node.js 24.14 or newer' });
  assert.equal(older.status, 'warn'); assert.match(older.fix, /Install Node\.js 24\.14 or newer/);
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
  // The system setting, switched on here and off again further down, as a tool like Clash switches it.
  let system = { source: 'system', https: proxyUrl, http: proxyUrl, bypass: [] };
  const proxy = createOutboundProxy({ env: {}, platform: 'win32', system: async () => system });
  assert.equal(await proxy.refresh(), true);
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
  // A client's metadata document: fetched through the proxy, and only under a public name. The proxy looks the name
  // up and connects; a computer that cannot look names up itself (as behind such a proxy) leaves it to the proxy.
  const behind = lookup => createClientMetadataResolver({ proxy: () => proxy.current().settings, lookup });
  const resolver = behind(() => { throw new Error('this computer cannot look the name up'); });
  await assert.rejects(resolver('https://client.devmate-proxy-test.example/metadata.json'), /Client metadata request failed/);
  assert.ok(seen.includes('CONNECT client.devmate-proxy-test.example:443'), seen.join());
  // Where this computer can look the name up, it does: a name that answers with an address of this computer or of a
  // local network is refused before the proxy is asked, so that the proxy is not sent there.
  for (const [name, answer] of [['inside', [{ address: '10.0.0.8', family: 4 }]], ['loop', [{ address: '127.0.0.1', family: 4 }]], ['link', [{ address: '169.254.169.254', family: 4 }]],
    ['mixed', [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }]]])
    await assert.rejects(behind(async () => answer)('https://' + name + '.devmate-proxy-test.example/metadata.json'), /resolve exclusively to public addresses/, name);
  assert.equal(seen.filter(item => /inside|loop|link|mixed/.test(item)).length, 0, 'the proxy was not sent to an address of a local network');
  // A public address, the made-up addresses of a proxy tool, and a look that gets no answer in time go to the proxy.
  for (const [name, lookup] of [['public', async () => [{ address: '93.184.216.34', family: 4 }]], ['faked', async () => [{ address: '198.18.0.42', family: 4 }]], ['silent', () => new Promise(() => {})]]) {
    await assert.rejects(behind(lookup)('https://' + name + '.devmate-proxy-test.example/metadata.json'), /Client metadata request failed/, name);
    assert.ok(seen.includes('CONNECT ' + name + '.devmate-proxy-test.example:443'), name + ': ' + seen.join());
  }
  for (const local of ['https://192.168.1.10/client.json', 'https://intranet/client.json', 'https://build.corp/client.json', 'https://printer.local/client.json'])
    await assert.rejects(resolver(local), /public host name/, local);
  assert.equal(seen.filter(item => /192\.168|intranet|corp|printer/.test(item)).length, 0, 'nothing on the local network was asked for');
  // Without a proxy setting, a computer whose names all resolve to made-up addresses (a proxy tool in TUN mode) is told so.
  const direct = createClientMetadataResolver({ lookup: async () => [{ address: '198.18.0.42', family: 4 }] });
  await assert.rejects(direct('https://client.devmate-proxy-test.example/metadata.json'), /made-up addresses \(198\.18\.x\.x\).*system-proxy mode/);
  // While it is on, a request to a name that exists nowhere goes to the proxy: a plain one is answered by it. fetch
  // reaches it too, in the way its Node does it for a plain address: it asks the proxy for a tunnel, which this
  // stand-in refuses, or hands the proxy the request itself, as newer Node does.
  const plain = url => new Promise(resolve => { const request = http.get(url, response => { response.resume(); resolve(response.statusCode); }); request.on('error', error => resolve(error.code)); });
  assert.equal(await plain('http://origin.devmate-proxy-test.invalid/through'), 200);
  assert.ok(seen.includes('GET http://origin.devmate-proxy-test.invalid/through'), seen.join());
  const fetched = await fetch('http://origin.devmate-proxy-test.invalid/fetched').then(response => response.status, () => 'refused');
  assert.ok(fetched === 'refused' ? seen.includes('CONNECT origin.devmate-proxy-test.invalid:80') : fetched === 200 && seen.includes('GET http://origin.devmate-proxy-test.invalid/fetched'), fetched + ': ' + seen.join());
  // The owner switches the system proxy off: the next look puts requests back on the direct way, and the proxy hears no more.
  system = null;
  const before = seen.length;
  assert.equal(await proxy.refresh(), true); assert.equal(proxy.current(), null);
  assert.equal(await plain('http://origin.devmate-proxy-test.invalid/direct'), 'ENOTFOUND');
  await assert.rejects(fetch('http://origin.devmate-proxy-test.invalid/direct'), error => error.cause?.code === 'ENOTFOUND');
  assert.equal(seen.length, before, 'nothing more reached the proxy');
  // And on again.
  system = { source: 'system', https: proxyUrl, http: proxyUrl, bypass: [] };
  assert.equal(await proxy.refresh(), true);
  assert.equal(await plain('http://origin.devmate-proxy-test.invalid/again'), 200);
});
