'use strict';

const { resolveNodeRuntime } = require('./platform/node-runtime.js');
const { nodeFetch } = require('./platform/node-fetch.cjs');

function wait(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function newer(mine, running) {
  const parts = value => String(value || '0').split(/[.+-]/).slice(0, 3).map(part => Number(part) || 0);
  const [a, b] = [parts(mine), parts(running)];
  for (let index = 0; index < 3; index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}

/**
 * What an editor host (VS Code, Obsidian) uses to reach the one shared runtime
 * of an instance. Any number of hosts and the CLI use the same runtime at once;
 * starting from several of them at the same moment still yields exactly one.
 */
function createHostClient(options = {}) {
  let clientPromise, versionPromise;
  const subscriptions = new Set();
  // Every request of a host goes through Node's HTTP client: the same in a Node extension host and in an Electron window.
  const settings = { fetchImpl: nodeFetch, ...options };
  const factory = () => import('./client.mjs').then(module => overrides => module.createRuntimeClient({ ...settings, ...overrides }));
  const client = () => clientPromise ||= factory().then(create => create());
  const version = () => versionPromise ||= import('./version.mjs');
  // The port a start from this entry asks for. One the owner set in this entry, other than the usual one, is their
  // word. Otherwise the port the runtime ran on when this entry stopped it is taken again: the runtime may have been
  // started elsewhere (a terminal, another entry) on a port this entry's settings do not name, and a restart from
  // here moved it, away from the clients on this computer and the route of a tunnel that were set to it. Where
  // nothing is remembered the launcher decides (the port of a runtime that ended unexpectedly, else the usual one).
  let ran;
  const startPort = async () => {
    const usual = (await import('./client.mjs')).DEFAULT_RUNTIME_PORT;
    return options.port !== undefined && Number(options.port) !== usual ? options.port : ran;
  };
  return {
    async start() {
      // An editor's own executable is Electron, not Node: use the configured Node, else the one on PATH.
      let node;
      try { node = (options.resolveNode || resolveNodeRuntime)({ preferredExecutable: options.nodePath || '', processExecutable: '' }); }
      catch (cause) {
        // What each try said: a Node that is there but too old, or too slow to answer, is not one that is missing.
        const said = reason => /ENOENT/.test(reason) ? 'not found' : /ETIMEDOUT/.test(reason) ? 'did not answer in time' : String(reason || 'not usable').slice(0, 120);
        const tried = (cause.attempts || []).filter(item => item.source !== 'host').map(item => (item.source === 'configured' ? 'the one in the settings' : 'node on PATH') + ': ' + said(item.reason)).join('; ');
        const error = new Error('DevMate needs Node.js 24 or newer and did not find one it can use' + (tried ? ' (' + tried + ')' : '') + '. Install it from https://nodejs.org, or enter the path of the Node executable in the DevMate settings of this editor.');
        error.code = 'NODE_REQUIRED';
        error.cause = cause;
        throw error;
      }
      const launcher = await import('./launcher.mjs');
      return launcher.startRuntime({ ...options, port: await startPort(), nodePath: node.executable, clientFactory: await factory() });
    },
    async stop() {
      const launcher = await import('./launcher.mjs');
      const before = await launcher.runtimeStatus({ ...options, clientFactory: await factory() }).catch(() => null);
      if (before?.running && Number.isInteger(before.record?.port)) ran = before.record.port;
      return launcher.stopRuntime({ ...options, clientFactory: await factory() });
    },
    async status() {
      const launcher = await import('./launcher.mjs');
      const status = await launcher.runtimeStatus({ ...options, clientFactory: await factory() });
      // The runtime keeps serving the code it was started from. When this host ships a newer
      // version, say so; an older host leaves a newer runtime alone, so two hosts never take turns.
      const { BUILD_ID, VERSION } = await version();
      return { ...status, host: { buildId: BUILD_ID, version: VERSION },
        outdated: status.running === true && newer(VERSION, status.record.version) };
    },
    async snapshot() { return (await client()).snapshot(); },
    async operations() { return (await client()).operations(); },
    async call(operation, input = {}, overrides = {}) { return (await client()).call(operation, input, overrides); },
    /** A single-use link that signs the user's browser in to the workbench. */
    async workbenchUrl() { return (await client()).signInUrl(); },
    async mcpUrl() { return (await client()).origin() + '/mcp'; },
    subscribe(listener, onError = () => {}, onConnected = () => {}, { scoped = true } = {}) {
      const abort = new AbortController();
      subscriptions.add(abort);
      const done = (async () => {
        let cursor, instanceId, backoff = 250, reported = false;
        while (!abort.signal.aborted) {
          try {
            const status = await this.status();
            if (!status.running) {
              await wait(1500, abort.signal);
              continue;
            }
            if (instanceId !== status.record.instanceId) {
              cursor = undefined;
              instanceId = status.record.instanceId;
            }
            let received = false;
            for await (const event of (await client()).events({
              signal: abort.signal,
              after: cursor,
              scoped,
              onConnect: handshake => {
                if (cursor === undefined && Number.isSafeInteger(handshake?.cursor)) cursor = handshake.cursor;
                reported = false;
                onConnected(handshake);
              }
            })) {
              if (abort.signal.aborted) break;
              const next = Number(event.id);
              if (event.id !== undefined && Number.isSafeInteger(next) && next >= 0) cursor = next;
              received = true;
              listener(event);
            }
            if (received) backoff = 250;
          } catch (error) {
            if (error.code === 'EVENT_CURSOR_AHEAD') {
              cursor = undefined;
              reported = false;
              continue;
            }
            if (!abort.signal.aborted && !reported) {
              reported = true;
              onError(error);
            }
          }
          if (abort.signal.aborted) break;
          await wait(backoff, abort.signal);
          backoff = Math.min(backoff * 2, 5000);
        }
      })().finally(() => { subscriptions.delete(abort); });
      return { dispose: () => abort.abort(), done };
    },
    dispose() {
      for (const abort of subscriptions) abort.abort();
      subscriptions.clear();
    }
  };
}

module.exports = { createHostClient };
