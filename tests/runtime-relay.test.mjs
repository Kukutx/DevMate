import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { relaySettings, relayScript, relayRemovalScript, setupRelay, removeRelay, relayTarget } from '../runtime/relay.mjs';
import { normalizeSshConfig, sshArguments, ownerAddressArguments, createSshConnection } from '../runtime/ssh-connection.mjs';
import { verifyPublicMcp } from '../runtime/connection-verify.mjs';
import { startRuntime } from '../runtime/main.mjs';
import { main as cli } from '../runtime/cli.mjs';
import { normalizeConfig } from '../runtime/config.mjs';

const key = 'k'.repeat(32);
const output = () => { const sink = { text: '', write(value) { sink.text += value; } }; return sink; };

test('a relay is a server of the owner\'s own, named as user@host, with an address that stays', () => {
  assert.deepEqual(relayTarget('deploy@relay.example.com'), { user: 'deploy', host: 'relay.example.com' });
  for (const bad of ['relay.example.com', 'a@b@c', '@host', 'user@', 'us er@host', 'user@-x', 'root@::1']) assert.throws(() => relayTarget(bad), { code: 'invalid_input' }, bad);
  const named = relaySettings({ target: 'deploy@203.0.113.7', domain: 'devmate.example.com', key });
  assert.deepEqual([named.site, named.byAddress, named.publicUrl, named.remotePort, named.allowList], ['devmate.example.com', false, 'https://devmate.example.com/mcp/' + key, 18443, true]);
  // Without a name the relay is reached by the server's address, which then has to be one.
  assert.deepEqual([relaySettings({ target: 'root@203.0.113.7', key }).site, relaySettings({ target: 'root@203.0.113.7', key }).byAddress], ['203.0.113.7', true]);
  assert.throws(() => relaySettings({ target: 'root@relay.example.com', key }), { code: 'invalid_input', message: /--domain/ });
  assert.throws(() => relaySettings({ target: 'root@203.0.113.7', domain: '203.0.113.7', key }), { code: 'invalid_input' });
  assert.throws(() => relaySettings({ target: 'root@203.0.113.7', key: 'short' }), { code: 'invalid_input' });
  // A key that nobody chose is 24 random bytes, new for every relay.
  const fresh = [relaySettings({ target: 'root@203.0.113.7' }).key, relaySettings({ target: 'root@203.0.113.7' }).key];
  assert.match(fresh[0], /^[A-Za-z0-9_-]{32}$/); assert.notEqual(fresh[0], fresh[1]);
});

test('the server script forwards one unguessable path, unbuffered, and by default only to ChatGPT, Claude and the owner', () => {
  const script = relayScript(relaySettings({ target: 'deploy@203.0.113.7', domain: 'devmate.example.com', key }));
  assert.match(script, /^#!\/bin\/sh\nset -eu\n/); assert.ok(!script.includes('\r'));
  assert.match(script, /handle \/mcp\/\$KEY \{/); assert.match(script, /reverse_proxy 127\.0\.0\.1:\$PORT \{\n\t\t\tflush_interval -1/); assert.match(script, /handle \{\n\t\trespond 404/);
  assert.match(script, /respond @stranger \\"devmate-relay: this address is not on the list\\" 403/); assert.match(script, /remote_ip 160\.79\.104\.0\/21/); assert.match(script, /openai\.com\/chatgpt-connectors\.json/);
  // What it says back never carries the key, and the key is on no command line.
  assert.match(script, /say "ready: https:\/\/\$SITE\/mcp\/<key> forwards/); assert.equal(script.split(key).length - 1, 1, 'the key is written once, into a variable');
  // A name of its own gets an ordinary certificate; an address needs the short-lived kind and a Caddy that knows it.
  assert.ok(!script.includes('profile shortlived'));
  const byAddress = relayScript(relaySettings({ target: 'root@203.0.113.7', key }));
  assert.match(byAddress, /profile shortlived/); assert.match(byAddress, /cannot get a certificate for an IP address/);
  // Where that Caddy comes from when the system's own is too old: Caddy's own repository, by the steps Caddy publishes.
  assert.match(byAddress, /dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key/); assert.match(byAddress, /dnf copr enable -y @caddy\/caddy/); assert.match(byAddress, /It was here before, so it is left as it is/);
  assert.match(relayScript(relaySettings({ target: 'root@203.0.113.7', key, allowList: false })), /ALLOW_LIST='no'/);
  assert.match(relayRemovalScript(), /Caddy was here before and stays/);
});

test('the server script really runs: it writes the site, keeps a good list, is the same when run again, and is removed without a trace',
  { skip: process.platform === 'win32' && 'a POSIX shell script; run on Linux and macOS' }, t => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-relay-')), root = path.join(work, 'root'), bin = path.join(work, 'bin'), calls = path.join(work, 'calls.log');
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'etc', 'caddy'), { recursive: true }); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'etc', 'caddy', 'Caddyfile'), '# what the distribution ships\n:80 {\n\tfile_server\n}\n');
    // Stand-ins for what needs root or a network. The list is in the shape OpenAI publishes it.
    const list = JSON.stringify({ creationTime: '2026-10-06T23:18:01', prefixes: Array.from({ length: 40 }, (_, index) => ({ ipv4Prefix: '198.18.' + index + '.0/28' })) });
    fs.writeFileSync(path.join(work, 'list.json'), list);
    const stand = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "' + name + ' $*" >> "' + calls + '"\n' + body + '\n', { mode: 0o755 });
    stand('caddy', 'if [ "${1:-}" = version ]; then echo "v2.10.2 stand-in"; fi');
    stand('systemctl', ''); stand('curl', 'if [ -n "${CURL_FAILS:-}" ]; then exit 22; fi\ncat "' + path.join(work, 'list.json') + '"');
    const run = (script, env = {}, args = []) => {
      const file = path.join(work, 'script.sh'); fs.writeFileSync(file, script);
      const result = spawnSync('sh', [file, ...args], { encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin', DEVMATE_RELAY_ROOT: root, SSH_CLIENT: '198.51.100.7 51234 22', ...env } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    const devmate = path.join(root, 'etc', 'caddy', 'devmate'), read = name => fs.readFileSync(path.join(devmate, name), 'utf8');
    const script = relayScript(relaySettings({ target: 'deploy@203.0.113.7', domain: 'devmate.example.com', key }));
    assert.match(run(script), /devmate-relay: ready: https:\/\/devmate\.example\.com\/mcp\/<key> forwards to 127\.0\.0\.1:18443/);
    assert.match(read('site.caddy'), /^# Written by "devmate relay setup"[^\n]*\ndevmate\.example\.com \{\n\thandle \/mcp\/k{32} \{\n\t\t@stranger \{/);
    assert.match(read('site.caddy'), new RegExp('import ' + devmate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/owner\\.ranges'));
    assert.equal(read('openai.ranges').trim().split(' ').length, 41, 'the forty published ranges after the directive'); assert.equal(read('anthropic.ranges'), 'remote_ip 160.79.104.0/21\n');
    assert.equal(read('owner.ranges'), 'remote_ip 198.51.100.7\n', 'the address this computer connected from');
    const main = () => fs.readFileSync(path.join(root, 'etc', 'caddy', 'Caddyfile'), 'utf8');
    assert.match(main(), /^# what the distribution ships\n:80 \{\n\tfile_server\n\}\n\nimport devmate\/site\.caddy\n$/);
    // Run again: the same files, the import line once.
    const before = [read('site.caddy'), read('openai.ranges'), main()];
    run(script);
    assert.deepEqual([read('site.caddy'), read('openai.ranges'), main()], before);
    // This computer's address changed: its helper replaces that one entry.
    run(fs.readFileSync(path.join(root, 'usr', 'local', 'lib', 'devmate', 'allow-owner'), 'utf8'), { SSH_CLIENT: '203.0.113.44 4000 22' });
    assert.equal(read('owner.ranges'), 'remote_ip 203.0.113.44\n');
    // The published list cannot be read, or is suddenly almost empty: the good one stays.
    const refresh = fs.readFileSync(path.join(root, 'usr', 'local', 'lib', 'devmate', 'refresh-allow'), 'utf8');
    run(refresh, { CURL_FAILS: '1' }); assert.equal(read('openai.ranges'), before[1]);
    fs.writeFileSync(path.join(work, 'list.json'), JSON.stringify({ prefixes: [{ ipv4Prefix: '198.18.0.0/28' }] }));
    run(refresh); assert.equal(read('openai.ranges'), before[1]);
    // Removal takes away what setup wrote and leaves a Caddy that was there before.
    assert.match(run(relayRemovalScript()), /removed: the relay\. Caddy was here before and stays\./);
    assert.equal(fs.existsSync(devmate), false); assert.equal(fs.existsSync(path.join(root, 'usr', 'local', 'lib', 'devmate')), false);
    assert.equal(main(), '# what the distribution ships\n:80 {\n\tfile_server\n}\n\n');
  });

test('a relay reached by its address gets a Caddy that can do that: this script\'s own is brought up to date from Caddy\'s repository, the owner\'s is left alone',
  { skip: process.platform === 'win32' ? 'a POSIX shell script; run on Linux and macOS' : spawnSync('sh', ['-c', 'command -v caddy'], { env: { PATH: '/usr/bin:/bin' } }).status === 0 && 'this machine has a Caddy of its own' }, t => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-relay-caddy-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    // A server, as stand-ins: its package manager installs Caddy 2.6 from the system's packages (or none at all), and
    // 2.10 once Caddy's own repository is on the list. Nothing here reaches a network or needs root.
    const server = (name, { caddy, packaged = true } = {}) => {
      const root = path.join(work, name, 'root'), bin = path.join(work, name, 'bin'), calls = path.join(work, name, 'calls.log');
      fs.mkdirSync(path.join(root, 'etc', 'caddy'), { recursive: true }); fs.mkdirSync(bin); fs.writeFileSync(calls, '');
      const stand = (tool, body) => fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\necho "' + tool + ' $*" >> "' + calls + '"\n' + body + '\n', { mode: 0o755 });
      const installed = version => '#!/bin/sh\nif [ "${1:-}" = version ]; then echo "' + version + ' stand-in"; fi\n';
      if (caddy) fs.writeFileSync(path.join(bin, 'caddy'), installed(caddy), { mode: 0o755 });
      const source = path.join(root, 'etc', 'apt', 'sources.list.d', 'caddy-stable.list');
      stand('apt-get', String.raw`case "$*" in *" caddy")
  if [ -s "${source}" ]; then VERSION=v2.10.2; elif [ "${packaged}" = true ]; then VERSION=v2.6.2; else echo "E: Unable to locate package caddy" >&2; exit 100; fi
  printf '#!/bin/sh\nif [ "$1" = version ]; then echo "%s stand-in"; fi\n' "$VERSION" > "${path.join(bin, 'caddy')}"; chmod 755 "${path.join(bin, 'caddy')}";;
esac`);
      stand('curl', 'echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main"');
      stand('gpg', 'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cat > "$2"; fi; shift; done');
      const run = script => { const file = path.join(work, name, 'script.sh'); fs.writeFileSync(file, script);
        return spawnSync('sh', [file], { encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin', DEVMATE_RELAY_ROOT: root, SSH_CLIENT: '198.51.100.7 51234 22' } }); };
      return { root, run, source, called: () => fs.readFileSync(calls, 'utf8'), has: (...parts) => fs.existsSync(path.join(root, ...parts)) };
    };
    const byAddress = relayScript(relaySettings({ target: 'root@203.0.113.7', key }));

    // Nothing installed: the system's own Caddy comes first, is found too old for an address, and is replaced.
    const fresh = server('fresh'), first = fresh.run(byAddress);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /devmate-relay: this system packages Caddy 2\.6, which cannot get a certificate for an IP address: taking the current one from the package repository of Caddy itself/);
    assert.match(first.stdout, /devmate-relay: ready: https:\/\/203\.0\.113\.7\/mcp\/<key> forwards to 127\.0\.0\.1:18443 \(v2\.10\.2 stand-in\)/);
    assert.match(fresh.called(), /apt-get install -y -qq caddy\n(.*\n)*apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg\n(.*\n)*gpg --batch --yes --dearmor -o .*caddy-stable-archive-keyring\.gpg\n(.*\n)*apt-get update -qq\napt-get install -y -qq caddy\n/);
    assert.match(fs.readFileSync(fresh.source, 'utf8'), /^deb \[signed-by=/); assert.ok(fresh.has('usr', 'share', 'keyrings', 'caddy-stable-archive-keyring.gpg'));
    assert.ok(fresh.has('etc', 'caddy', '.installed-by-devmate') && fresh.has('etc', 'caddy', '.repository-by-devmate'));
    assert.match(fs.readFileSync(path.join(fresh.root, 'etc', 'caddy', 'devmate', 'site.caddy'), 'utf8'), /profile shortlived/);
    // Taking the relay off takes the repository off as well: the server is as it was.
    assert.match(fresh.run(relayRemovalScript()).stdout, /removed: the relay, and Caddy, which this had installed/);
    assert.ok(!fs.existsSync(fresh.source) && !fresh.has('usr', 'share', 'keyrings', 'caddy-stable-archive-keyring.gpg') && !fresh.has('etc', 'caddy', '.repository-by-devmate') && !fresh.has('etc', 'caddy', '.installed-by-devmate'));

    // A Caddy that was on the server before is the owner's: it is not replaced, and the way to do that is spelled out.
    const theirs = server('theirs', { caddy: 'v2.6.2' }), refused = theirs.run(byAddress);
    assert.equal(refused.status, 6, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /devmate-relay: error: this server has Caddy 2\.6, which cannot get a certificate for an IP address \(2\.10 or newer can\)\. It was here before, so it is left as it is\. To replace it with the current one, run on the server as root: apt install -y debian-keyring .* && apt install -y caddy \. Or give the relay a name with --domain\./);
    assert.equal(theirs.called(), '', 'nothing was installed or fetched'); assert.ok(!fs.existsSync(theirs.source) && !theirs.has('etc', 'caddy', 'devmate', 'site.caddy'));
    // The same server and a name instead of an address: any Caddy 2 will do, and it stays as it is.
    assert.equal(theirs.run(relayScript(relaySettings({ target: 'root@203.0.113.7', domain: 'devmate.example.com', key }))).status, 0); assert.ok(!theirs.called().includes('apt-get'));

    // A system that packages no Caddy at all gets it from Caddy's repository, whatever the relay is reached by.
    const bare = server('bare', { packaged: false }), third = bare.run(relayScript(relaySettings({ target: 'root@203.0.113.7', domain: 'devmate.example.com', key })));
    assert.equal(third.status, 0, third.stdout + third.stderr);
    assert.match(third.stdout, /devmate-relay: this system packages no Caddy: taking it from the package repository of Caddy itself/); assert.match(third.stdout, /ready: https:\/\/devmate\.example\.com\/mcp\/<key>/);
    assert.ok(bare.has('etc', 'caddy', '.repository-by-devmate') && bare.has('etc', 'caddy', '.installed-by-devmate'));
  });

test('setting a relay up runs that script over the owner\'s own SSH, and says plainly what went wrong', async () => {
  const runs = [];
  const answering = (code, stdout, stderr = '') => async request => { runs.push(request); return { code, stdout, stderr }; };
  const done = await setupRelay({ target: 'deploy@203.0.113.7', domain: 'devmate.example.com', executable: '/usr/bin/ssh', identityFile: '/home/me/.ssh/id_ed25519', key,
    run: answering(0, 'refreshed: 283 ranges\ndevmate-relay: ready: https://devmate.example.com/mcp/<key> forwards to 127.0.0.1:18443 (v2.10.2)\n') });
  assert.deepEqual(done.connection, { kind: 'ssh', publicUrl: 'https://devmate.example.com/mcp/' + key, executable: '/usr/bin/ssh', host: '203.0.113.7', user: 'deploy', sshPort: 22, remotePort: 18443, identityFile: '/home/me/.ssh/id_ed25519' });
  assert.deepEqual(done.notes, ['ready: https://devmate.example.com/mcp/<key> forwards to 127.0.0.1:18443 (v2.10.2)']);
  // No password is ever asked for; the first contact records the server's key, and the script travels on standard input.
  const { options, host, script } = runs[0];
  assert.equal(host, '203.0.113.7'); assert.ok(options.includes('BatchMode=yes')); assert.ok(options.includes('StrictHostKeyChecking=accept-new'));
  assert.deepEqual(options.slice(options.indexOf('-i'), options.indexOf('-i') + 4), ['-i', '/home/me/.ssh/id_ed25519', '-o', 'IdentitiesOnly=yes']); assert.match(script, /^#!\/bin\/sh/);
  assert.ok(!options.join(' ').includes(key), 'the key is not on the command line');
  await assert.rejects(setupRelay({ target: 'deploy@203.0.113.7', domain: 'devmate.example.com', executable: '/usr/bin/ssh', run: answering(255, '', 'deploy@203.0.113.7: Permission denied (publickey).\n') }),
    { code: 'ssh_failed', message: /without a password: .*Permission denied.*Set up key login first/ });
  await assert.rejects(setupRelay({ target: 'deploy@203.0.113.7', domain: 'devmate.example.com', executable: '/usr/bin/ssh', run: answering(3, 'devmate-relay: error: this needs root. Log in as root, or give deploy sudo without a password.\n') }),
    { code: 'relay_setup_failed', message: /this needs root/ });
  // Removing insists on the server key it already knows.
  runs.length = 0;
  assert.deepEqual(await removeRelay({ target: 'deploy@203.0.113.7', executable: '/usr/bin/ssh', run: answering(0, 'devmate-relay: removed: the relay. Caddy was here before and stays.\n') }),
    { removed: true, notes: ['removed: the relay. Caddy was here before and stays.'] });
  assert.ok(runs[0].options.includes('StrictHostKeyChecking=yes'));
});

test('devmate relay setup makes that server how this computer is reached, keeps its address when run again, and is the owner\'s to run', async t => {
  const instance = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-relay-cli-'));
  t.after(() => fs.rmSync(instance, { recursive: true, force: true }));
  const asked = [];
  const run = async (args, extra = {}) => {
    const stdout = output(), stderr = output();
    const code = await cli([...args, '--instance', instance, '--executable', process.execPath], { stdout, stderr, env: {},
      setup: async options => { asked.push(options); const relay = relaySettings({ target: options.target, domain: options.domain, allowList: options.allowList, ...(options.key ? { key: options.key } : {}) });
        return { ...relay, notes: ['ready'], connection: { kind: 'ssh', publicUrl: relay.publicUrl, executable: options.executable, host: relay.host, user: relay.user, sshPort: options.sshPort, remotePort: relay.remotePort } }; },
      remove: async () => ({ removed: true, notes: ['removed'] }), ...extra });
    return { code, stdout: stdout.text, stderr: stderr.text };
  };
  const saved = () => JSON.parse(fs.readFileSync(path.join(instance, 'config.json'), 'utf8'));
  const first = await run(['relay', 'setup', 'deploy@203.0.113.7', '--domain', 'devmate.example.com']);
  assert.equal(first.code, 0, first.stderr);
  const address = saved().connection.publicUrl;
  assert.match(address, /^https:\/\/devmate\.example\.com\/mcp\/[A-Za-z0-9_-]{32}$/); assert.equal(saved().connection.relay, true); assert.deepEqual(saved().auth, { mode: 'none' });
  // What is printed can be pasted anywhere: the address is there without its key.
  assert.match(first.stdout, /"relay": "https:\/\/devmate\.example\.com\/mcp\/<key>"/); assert.ok(!first.stdout.includes(address.split('/').pop())); assert.match(first.stdout, /devmate mcp-url/);
  assert.equal(asked[0].allowList, true); assert.equal(asked[0].key, undefined);
  // The doctor of a runtime that is not running reads the saved settings: it too prints the address without its key.
  const stopped = await run(['doctor']);
  assert.match(stopped.stdout, /\[ ok \] settings: connection: ssh, auth: none, public URL: https:\/\/devmate\.example\.com\/mcp\/<key>\n/); assert.ok(!stopped.stdout.includes(address.split('/').pop()));
  assert.ok(!(await run(['doctor', '--report'])).stdout.includes(address.split('/').pop()), 'nor does the report for a bug report');
  // Again, for the same server: the client's address must not change.
  await run(['relay', 'setup', 'deploy@203.0.113.7', '--domain', 'devmate.example.com', '--any-address']);
  assert.equal(saved().connection.publicUrl, address); assert.equal(asked[1].key, address.split('/').pop()); assert.equal(asked[1].allowList, false);
  // Through a connected client the command is refused: it changes how this computer is reached.
  const refused = await cli(['relay', 'setup', 'deploy@203.0.113.7'], { stdout: output(), stderr: output(), env: { DEVMATE_CLIENT_COMMAND: '1' } });
  assert.notEqual(refused, 0); assert.equal(saved().connection.publicUrl, address);
  // An option of another command is not passed over in silence, and nothing is done on the server for it.
  const optioned = await run(['relay', 'setup', 'deploy@203.0.113.7', '--openai-tunnel', 'tunnel_abc123']);
  assert.notEqual(optioned.code, 0); assert.match(optioned.stderr, /relay setup does not take --openai-tunnel\..* then: devmate connect beside --openai-tunnel tunnel_abc123/); assert.equal(asked.length, 2);
  // OpenAI's tunnel is put beside the relay without the relay being named again, and nothing of its address is printed.
  // (That command takes nothing that names a connection, the program of one included: it is run as it is written.)
  const plainly = async args => { const stdout = output(), stderr = output(); return { code: await cli([...args, '--instance', instance], { stdout, stderr, env: {} }), stdout: stdout.text, stderr: stderr.text }; };
  assert.match((await run(['connect', 'beside', '--openai-tunnel', 'tunnel_abc123'])).stderr, /takes only --openai-tunnel and --organization \(given: --executable\)/);
  const beside = await plainly(['connect', 'beside', '--openai-tunnel', 'tunnel_abc123']);
  assert.equal(beside.code, 0, beside.stderr); assert.equal(saved().connection.publicUrl, address); assert.equal(saved().openaiTunnel.tunnelId, 'tunnel_abc123');
  assert.deepEqual(JSON.parse(beside.stdout).saved.connection, { kind: 'ssh', relay: true }); assert.ok(!beside.stdout.includes(address.split('/').pop()) && !beside.stdout.includes('devmate.example.com'));
  // It stays beside the relay when the relay is set up again, which is said.
  const again = await run(['relay', 'setup', 'deploy@203.0.113.7', '--domain', 'devmate.example.com']);
  assert.equal(saved().openaiTunnel.tunnelId, 'tunnel_abc123'); assert.match(again.stdout, /"openaiTunnel": "tunnel_abc123 stays beside it"/); assert.doesNotMatch(again.stdout, /no longer used/);
  assert.equal((await plainly(['connect', 'beside', '--openai-tunnel', 'none'])).code, 0); assert.equal(saved().openaiTunnel, undefined); assert.equal(saved().connection.publicUrl, address);
  // Taking the relay away takes it out of this computer's settings as well.
  const removed = await run(['relay', 'remove', 'deploy@203.0.113.7']);
  assert.equal(removed.code, 0, removed.stderr); assert.deepEqual(saved().connection, { kind: 'local' });
  assert.notEqual((await run(['relay', 'setup'])).code, 0);
  // A relay set up where OpenAI's tunnel was the connection takes its place. That the tunnel is no longer used is said,
  // with the one command that puts it beside the relay.
  assert.equal(await cli(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_abc123', '--organization', 'org-abc', '--instance', instance], { stdout: output(), stderr: output(), env: {} }), 0);
  const over = await run(['relay', 'setup', 'deploy@203.0.113.7']);
  assert.equal(saved().connection.kind, 'ssh'); assert.equal(saved().openaiTunnel, undefined);
  assert.match(over.stdout, /"OpenAI's tunnel tunnel_abc123 is no longer used\. To run it beside the relay: devmate connect beside --openai-tunnel tunnel_abc123 --organization org-abc"/);
});

test('the SSH route carries the relay\'s path, tells the relay this computer\'s address first, and the ingress answers only under that path', async t => {
  const config = { kind: 'ssh', publicUrl: 'https://devmate.example.com/mcp/' + key, executable: process.execPath, host: '203.0.113.7', user: 'deploy', relay: true };
  assert.deepEqual(normalizeSshConfig(config), { ...config, sshPort: 22, remotePort: 18443 });
  for (const bad of ['https://devmate.example.com/mcp/short', 'https://devmate.example.com/other/' + key, 'https://devmate.example.com/mcp/' + key + '/x']) {
    assert.throws(() => normalizeSshConfig({ ...config, publicUrl: bad }), { code: 'invalid_connection' }, bad);
  }
  assert.throws(() => normalizeSshConfig({ ...config, relay: 'yes' }), { code: 'invalid_connection' });
  // A relay forwards one path and no sign-in pages: the two together are refused when they are set, not found out later.
  const issuer = 'https://devmate.example.com';
  assert.throws(() => normalizeConfig({ connection: config, auth: { mode: 'oauth', issuer } }), { code: 'invalid_issuer', message: /forwards that one path only, so nobody can sign in through it/ });
  assert.equal(normalizeConfig({ connection: { kind: 'ssh', publicUrl: issuer + '/mcp', executable: process.execPath, host: '203.0.113.7', user: 'deploy' }, auth: { mode: 'oauth', issuer } }).auth.mode, 'oauth');
  const forward = sshArguments(normalizeSshConfig(config), 'http://127.0.0.1:8789/mcp/' + key);
  assert.deepEqual(forward.slice(-3), ['-R', '127.0.0.1:18443:127.0.0.1:8789', '203.0.113.7']); assert.ok(forward.includes('StrictHostKeyChecking=yes')); assert.ok(!forward.join(' ').includes(key));
  assert.deepEqual(ownerAddressArguments(normalizeSshConfig(config)).slice(-2), ['203.0.113.7', '/usr/local/lib/devmate/allow-owner']);
  // Starting the connection: first the relay is told, then the forward is held open. An ordinary SSH route is told nothing.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-relay-ssh-'));
  // The runtime closes first; only then can its directory be removed.
  let runtime;
  t.after(async () => { await runtime?.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const spawned = [];
  const spawnImpl = (file, args) => {
    const child = new EventEmitter(); child.pid = 7000 + spawned.length; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter();
    spawned.push(args);
    queueMicrotask(() => { child.emit('spawn'); if (args.at(-1) === '/usr/local/lib/devmate/allow-owner') { child.exitCode = 0; child.emit('exit', 0, null); } });
    return child;
  };
  const terminateImpl = async child => { child.exitCode = 0; child.emit('exit', 0, null); return { exitConfirmed: true }; };
  const connection = createSshConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/' + key, instanceRoot: temp, env: { PATH: 'x' }, spawnImpl, terminateImpl });
  assert.equal((await connection.start()).phase, 'process-running');
  assert.deepEqual(spawned.map(args => args.at(-1)), ['/usr/local/lib/devmate/allow-owner', '203.0.113.7']);
  await connection.stop();
  spawned.length = 0;
  const plain = createSshConnection({ config: { ...config, relay: undefined, publicUrl: 'https://devmate.example.com/mcp' }, localMcpUrl: 'http://127.0.0.1:8789/mcp', instanceRoot: temp, env: { PATH: 'x' }, spawnImpl, terminateImpl });
  await plain.start(); assert.equal(spawned.length, 1); await plain.stop();
  // A relay that does not answer is waited for a moment and no longer: the forward is started all the same, the log
  // says why, and the login that is still on its way is ended at its own limit, not by the start.
  spawned.length = 0;
  const said = [], killed = [];
  const silent = (file, args) => {
    const child = new EventEmitter(); child.pid = 7100 + spawned.length; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter(); child.kill = () => killed.push(args.at(-1));
    spawned.push(args);
    queueMicrotask(() => { child.emit('spawn'); });
    return child;
  };
  const unanswered = createSshConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/' + key, instanceRoot: temp, env: { PATH: 'x' }, spawnImpl: silent, terminateImpl, tellWaitMs: 40, note: line => said.push(line) });
  const began = Date.now();
  assert.equal((await unanswered.start()).phase, 'process-running');
  assert.ok(Date.now() - began < 5000, 'the start did not wait for the login to give up');
  assert.deepEqual(spawned.map(args => args.at(-1)), ['/usr/local/lib/devmate/allow-owner', '203.0.113.7']);
  assert.equal(said.length, 1); assert.match(said[0], /^the relay at 203\.0\.113\.7 has not answered for 0 seconds; the start goes on without it\./); assert.ok(!said[0].includes(key));
  assert.deepEqual(killed, [], 'the login is left to its own limit');
  // It stays the connection's own: a stop ends it, so that a restart leaves no login behind.
  await unanswered.stop();
  assert.deepEqual(killed, ['/usr/local/lib/devmate/allow-owner']);
  // And how a late one ended is written down where its being late was.
  for (const [ending, words] of [[child => { child.exitCode = 0; child.emit('exit', 0, null); }, /^the relay at 203\.0\.113\.7 has been told this computer's address after all\.$/],
    [child => { child.exitCode = 255; child.emit('exit', 255, null); }, /^the relay at 203\.0\.113\.7 was not told this computer's address \(the login ended with code 255\)\.$/]]) {
    spawned.length = 0; said.length = 0;
    const logins = [];
    const later = (file, args) => { const child = silent(file, args); if (args.at(-1) === '/usr/local/lib/devmate/allow-owner') logins.push(child); return child; };
    const slow = createSshConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/' + key, instanceRoot: temp, env: { PATH: 'x' }, spawnImpl: later, terminateImpl, tellWaitMs: 40, note: line => said.push(line) });
    await slow.start();
    ending(logins[0]);
    assert.equal(said.length, 2); assert.match(said[1], words);
    await slow.stop();
  }

  // The runtime behind the relay: the configured path opens it, /mcp alone does not exist.
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: config }));
  runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'ssh', phase: 'process-running', publicUrl: config.publicUrl, remoteMcpVerified: false }; } }) });
  const ask = pathname => new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port: runtime.ingressPort, path: pathname, method: 'OPTIONS', headers: { host: 'devmate.example.com' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.once('error', reject); req.end(); });
  assert.deepEqual([await ask('/mcp/' + key), await ask('/mcp'), await ask('/mcp/' + 'A'.repeat(32))], [204, 404, 404]);
  // Through a relay answers may stream again: only the quick tunnel is held to plain JSON.
  const doctor = await runtime.service.call('runtime.doctor', {}, { id: 'owner', surface: 'local' });
  assert.ok(!JSON.stringify(doctor).includes(key), 'the doctor prints the address without its key');
  // What keeps strangers out of a relay is said as it is; sign-in, which it cannot have, is not what the doctor advises.
  const security = doctor.checks.find(item => item.id === 'security');
  assert.equal(security.status, 'warn'); assert.match(security.detail, /^The relay has no sign-in and cannot have one: it forwards only the path its address ends in\./); assert.doesNotMatch(security.fix, /sign-in|oauth/i);
});

test('a relay that does not list this computer is told apart from a route that does not work', async () => {
  const url = 'https://devmate.example.com/mcp/' + key;
  const failing = () => ({ async connect() { throw new Error('HTTP 403'); }, async close() {} });
  const refused = await verifyPublicMcp({ url, clientFactory: failing, transportFactory: () => ({}), lookup: async () => ({ address: '203.0.113.7', family: 4 }),
    fetchImpl: async () => new Response('devmate-relay: this address is not on the list', { status: 403 }) });
  assert.deepEqual([refused.verified, refused.reachable, refused.pending], [false, true, 'not-listed']); assert.match(refused.reason, /ChatGPT and Claude are on the list/);
  // Any other refusal is what it is.
  const broken = await verifyPublicMcp({ url, clientFactory: failing, transportFactory: () => ({}), lookup: async () => ({ address: '203.0.113.7', family: 4 }),
    fetchImpl: async () => new Response('Forbidden', { status: 403 }) });
  assert.deepEqual([broken.verified, broken.reachable, broken.pending], [false, false, undefined]);
});
