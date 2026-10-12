import { createRequire } from 'node:module';
import { EXTENSION_ORIGIN } from './chrome.mjs';
import { VERSION } from './version.mjs';

// DevMate's native messaging host: the program a browser starts for the DevMate extension, and for that extension
// only. It speaks the browser's framing on its standard input and output (a length of four bytes, then JSON) and is
// the link between the extension and the runtime on this computer:
//
//   the runtime asks the browser to do something  → { type: 'call', id, method, params }   ← { type: 'result', id, ok, result | error }
//   the extension, as an entry, asks the runtime  → { type: 'request', id, action, input } ← { type: 'response', id, ok, result | error }
//   what happened in the runtime                  → { type: 'event', name, data }
//
// As an entry the extension may ask for the status, a start, a link to the workbench, the MCP address and what waits
// for the owner. It cannot stop the runtime and cannot call an operation by name. The host never starts the runtime
// by itself: that is the extension's "start with the browser" switch, off until the owner turns it on. When the
// browser goes, this program goes; the runtime stays.

export const PROTOCOL = 1;
// A browser accepts at most 1 MiB from a host in one message, and sends at most 64 MiB.
const MAX_TO_BROWSER = 1024 * 1024, MAX_FROM_BROWSER = 64 * 1024 * 1024;
// What one answer of the browser may weigh on its way into the runtime (a picture of a page is a few megabytes).
const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const ACTIONS = ['status', 'start', 'workbench', 'mcpUrl', 'pending'];
const pause = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });

/** The messages of a stream that carries the browser's framing: each a four-byte length, least significant first, then JSON. */
export function frames(onMessage, onFault = () => {}) {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (size > MAX_FROM_BROWSER) { onFault(new Error('A message of ' + size + ' bytes is more than a browser sends.')); pending = Buffer.alloc(0); return; }
      if (pending.length < 4 + size) return;
      const body = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      let message;
      try { message = JSON.parse(body.toString('utf8')); } catch { onFault(new Error('A message was not JSON.')); continue; }
      onMessage(message);
    }
  };
}
export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8'), head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Serve one browser. origin is what the browser says started this program; input and output are its standard streams;
 * client is a host client of the instance (runtime/host-client.cjs). Resolves when the browser closes the connection.
 */
export async function serveChromeHost({ origin, input, output, client, pollMs = 2000, pendingMs = 5000, log = () => {} } = {}) {
  // A browser names the extension it starts a host for. Any other caller is not served.
  if (origin !== EXTENSION_ORIGIN) throw Object.assign(new Error('devmate chrome-host is started by a browser for the DevMate extension, not by hand.'), { code: 'forbidden' });
  const stop = new AbortController(), signal = stop.signal;
  let extension = null, linkId = null, running = null, pendingCount = null, polling = false;
  const send = message => {
    const data = frame(message);
    if (data.length - 4 > MAX_TO_BROWSER) return false;
    try { output.write(data); return true; } catch { return false; }
  };
  // port: the local port this runtime answers the owner on, the workbench among it. The extension keeps the browser's
  // tools off the pages of that origin: what is decided there is the owner's to decide at the computer.
  const runtime = async () => {
    const status = await client.status(), up = status.running === true;
    return { running: up, version: up ? status.record?.version || VERSION : VERSION, ...(up && Number.isInteger(status.record?.port) ? { port: status.record.port } : {}), ...(status.outdated ? { outdated: true } : {}) };
  };
  // How many things wait for the owner, and only that: what they say (the task a client handed over, a question of an
  // agent) is read in the workbench, and is not sent into the browser for a number the extension shows.
  // (Counted up to a few hundred of each: twenty tasks of a client alone may wait at once, beside what agents ask.)
  const pending = async () => {
    const [approvals, inputs] = await Promise.all([client.call('approval.list', { status: 'pending', limit: 200 }), client.call('input.list', { status: 'pending', limit: 200 })]);
    return { count: approvals.items.length + inputs.items.length };
  };

  // Everything the runtime asks of the browser while it runs: one reader, asking again as soon as it was answered.
  async function work() {
    if (polling || !extension) return;
    polling = true;
    try {
      linkId = (await client.call('chrome.attach', { browser: extension.browser, extension: extension.version, methods: extension.methods })).linkId;
      while (!signal.aborted && linkId) {
        const { calls } = await client.call('chrome.next', { linkId, waitMs: 25000 }, { timeoutMs: 40000 });
        for (const call of calls) {
          if (!send({ type: 'call', id: call.id, method: call.method, params: call.params })) {
            await client.call('chrome.result', { linkId, id: call.id, ok: false, error: { code: 'invalid_input', message: 'This request is larger than a browser accepts in one message.' } }).catch(() => {});
          }
        }
      }
    } catch (error) { log('link: ' + (error?.code || '') + ' ' + (error?.message || error)); }
    finally { polling = false; linkId = null; }
  }
  // Whether the runtime runs, and what waits for the owner: told to the extension when it changes.
  async function watch() {
    let lastPending = 0;
    while (!signal.aborted) {
      try {
        const now = await runtime();
        // (Also where only the port is another: a runtime of the same version that was started again elsewhere.)
        if (running === null || now.running !== running.running || now.version !== running.version || now.port !== running.port) { running = now; if (extension) send({ type: 'event', name: 'runtime.status', data: now }); }
        if (now.running) {
          if (!polling) void work();
          if (extension && Date.now() - lastPending >= pendingMs) {
            lastPending = Date.now();
            const { count } = await pending();
            if (count !== pendingCount) { pendingCount = count; send({ type: 'event', name: 'pending.changed', data: { count } }); }
          }
        } else pendingCount = null;
      } catch (error) { log('watch: ' + (error?.message || error)); }
      await pause(pollMs, signal);
    }
  }

  async function asked(message) {
    const answer = (ok, value) => send({ type: 'response', id: message.id, ok, ...(ok ? { result: value } : { error: value }) });
    try {
      if (!ACTIONS.includes(message.action)) return answer(false, { code: 'invalid_input', message: 'DevMate does not do ' + String(message.action).slice(0, 40) + ' for the extension.' });
      if (message.action === 'status') return answer(true, running = await runtime());
      if (message.action === 'start') {
        await client.start();
        running = await runtime();
        send({ type: 'event', name: 'runtime.status', data: running });
        if (!polling) void work();
        return answer(true, running);
      }
      if (message.action === 'workbench') return answer(true, { url: await client.workbenchUrl() });
      if (message.action === 'mcpUrl') {
        // The address the owner pastes into a client in the cloud, as "devmate mcp-url" prints it: the public route
        // where there is one, and only otherwise the address that works on this computer alone. scope says which.
        const connection = await client.call('connection.status', {}), local = await client.mcpUrl();
        const remote = connection.tunnelId || connection.publicUrl || connection.url;
        return answer(true, remote ? { url: remote, scope: connection.tunnelId ? 'tunnel' : 'public', local, ...(connection.temporaryAddress ? { temporary: true } : {}), ...(connection.remoteMcpVerified === false ? { verified: false } : {}) }
          : { url: local, scope: 'local', ...(connection.kind && connection.kind !== 'local' ? { waiting: connection.kind } : {}) });
      }
      return answer(true, await pending());
    } catch (error) {
      const stopped = error?.code === 'RUNTIME_STOPPED';
      return answer(false, { code: stopped ? 'not_running' : error?.code || 'failed', message: stopped ? 'DevMate is not running.' : String(error?.message || error).slice(0, 500) });
    }
  }
  async function received(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') {
      extension = { version: String(message.extension || '').slice(0, 40), browser: String(message.browser || '').slice(0, 100),
        methods: Array.isArray(message.methods) ? message.methods.filter(name => typeof name === 'string' && name.length <= 80).slice(0, 200) : [] };
      running = await runtime().catch(() => ({ running: false, version: VERSION }));
      send({ type: 'ready', protocol: PROTOCOL, runtime: running });
      if (running.running && !polling) void work();
    } else if (message.type === 'result') {
      if (!linkId || typeof message.id !== 'string') return;
      const size = Buffer.byteLength(JSON.stringify(message.result ?? null));
      const outcome = size > MAX_RESULT_BYTES ? { ok: false, error: { code: 'browser_error', message: 'The browser\'s answer is ' + Math.round(size / 1048576) + ' MiB, more than DevMate takes in one answer. Ask for less.' } }
        : message.ok === true ? { ok: true, result: message.result } : { ok: false, error: { code: String(message.error?.code || 'browser_error').slice(0, 80), message: String(message.error?.message || 'The browser could not do this.').slice(0, 2000) } };
      await client.call('chrome.result', { linkId, id: message.id, ...outcome }).catch(error => log('result: ' + (error?.message || error)));
    } else if (message.type === 'request') await asked(message);
  }

  const closed = new Promise(resolve => { input.once('end', resolve); input.once('close', resolve); input.once('error', resolve); });
  input.on('data', frames(message => { void received(message).catch(error => log('message: ' + (error?.message || error))); }, error => log(error.message)));
  void watch();
  await closed;
  stop.abort();
  // The browser is gone: the runtime is told, and keeps running.
  if (linkId) await client.call('chrome.detach', { linkId }, { timeoutMs: 3000 }).catch(() => {});
  client.dispose?.();
}

/** The program itself: devmate chrome-host <origin> [--parent-window=<n>] [--instance <directory>], as a browser starts it. */
export async function chromeHostMain(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const origin = argv.find(word => word.startsWith('chrome-extension://')) || '';
  const at = argv.indexOf('--instance'), instanceRoot = at >= 0 ? argv[at + 1] : undefined;
  const { createHostClient } = createRequire(import.meta.url)('./host-client.cjs');
  try {
    // The Node that runs this program is the one a start uses.
    await serveChromeHost({ origin, input: stdin, output: stdout, client: createHostClient({ ...(instanceRoot ? { instanceRoot } : {}), nodePath: process.execPath }),
      log: line => { try { stderr.write('devmate chrome-host: ' + line + '\n'); } catch {} } });
    return 0;
  } catch (error) {
    try { stderr.write('devmate chrome-host: ' + (error?.message || error) + '\n'); } catch {}
    return error?.code === 'forbidden' ? 2 : 1;
  }
}
