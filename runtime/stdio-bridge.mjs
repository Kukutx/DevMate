import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * DevMate for a client that starts its MCP servers as programs and talks to
 * them over standard input and output (`devmate mcp`). This process keeps no
 * state of its own: it relays every message to the one runtime of the
 * instance, on its local port, where a caller without credentials is the owner.
 * Both ends are the official SDK transports, so framing, streaming answers and
 * protocol headers are theirs.
 *
 * `connect` resolves the runtime's MCP address, starting the runtime when it is
 * not running. It is asked again when the runtime cannot be reached, so the
 * bridge survives a restart of the runtime. A message is sent again only when
 * it certainly did not arrive: a call that may have started is never run twice.
 * What happens to one request never decides another: a refusal or a broken
 * connection is the answer to that request alone.
 */
const UNKNOWN_OUTCOME = 'The DevMate runtime stopped answering while this request was in progress. It may or may not have taken effect: check before repeating it.';
// The runtime answered this one request with a refusal (too large, malformed, not allowed): nothing was started.
const refused = error => Number.isInteger(error?.status) && error.status !== 503;
// Refused before anything was read, or turned away by a runtime that is stopping: nothing was started.
function undelivered(error) {
  const codes = [error?.code, error?.cause?.code, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.map(item => item?.code) : [])];
  return codes.includes('ECONNREFUSED') || error?.status === 503;
}
export async function serveStdioBridge({ connect, stdin = process.stdin, stdout = process.stdout, log = () => {} } = {}) {
  if (typeof connect !== 'function') throw new TypeError('The stdio bridge needs a way to reach the runtime.');
  // One message may be as large as the runtime accepts in one request. The SDK's own bound for a line of standard
  // input is lower, and exceeding it ends the whole connection instead of failing one request.
  const client = new StdioServerTransport(stdin, stdout, { maxBufferSize: 20 * 1024 * 1024 });
  let upstream = null, opening = null, protocolVersion = null, finished = false, release;
  const closed = new Promise(resolve => { release = resolve; });
  // Requests passed on and not answered yet, each with the connection it travels on.
  const waiting = new Map();
  // Connections that failed for one request. No new request uses them; each is closed once the requests still
  // travelling on it have ended on their own, because closing it under them would cut off answers still to come.
  const retired = new Set();
  const fail = (id, message) => client.send({ jsonrpc: '2.0', id, error: { code: -32603, message } }).catch(() => {});
  const carries = transport => [...waiting.values()].includes(transport);
  function settle(id) {
    const transport = waiting.get(id);
    if (!waiting.delete(id)) return false;
    if (retired.has(transport) && !carries(transport)) { retired.delete(transport); void transport.close().catch(() => {}); }
    return true;
  }
  function retire(transport) {
    if (upstream === transport) upstream = null;
    if (carries(transport)) retired.add(transport); else void transport.close().catch(() => {});
  }

  const open = () => opening ||= (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(await connect()), { requestInit: { redirect: 'error' } });
    transport.onmessage = message => {
      // A client of an earlier protocol revision names its revision once; every later request must carry it.
      if (typeof message?.result?.protocolVersion === 'string') { protocolVersion = message.result.protocolVersion; transport.setProtocolVersion?.(protocolVersion); }
      if (message?.id !== undefined && !message.method) settle(message.id);
      client.send(message).catch(error => log('reply not delivered: ' + error.message));
    };
    transport.onerror = error => log('runtime: ' + error.message);
    await transport.start();
    if (protocolVersion) transport.setProtocolVersion?.(protocolVersion);
    return upstream = transport;
  })().finally(() => { opening = null; });

  async function relay(message) {
    const request = message?.id !== undefined && !!message.method;
    for (let attempt = 0; ; attempt++) {
      let transport;
      // Nothing has been sent yet, so looking for the runtime once more is always safe: it may have been restarted on another port.
      try { transport = upstream || await open(); }
      catch (error) { if (attempt === 0 && !finished) continue; throw error; }
      if (request) waiting.set(message.id, transport);
      try {
        // An answer that is streamed can break off; the request is then answered here instead of never.
        return await transport.send(message, request ? { onRequestStreamEnd: () => { if (settle(message.id)) { log('answer cut off'); fail(message.id, UNKNOWN_OUTCOME); } } } : undefined);
      } catch (error) {
        if (refused(error)) { error.refused = true; throw error; }
        retire(transport);
        if (attempt === 0 && !finished && undelivered(error)) { settle(message.id); continue; }
        error.outcomeUnknown = !undelivered(error);
        throw error;
      }
    }
  }
  client.onmessage = message => {
    relay(message).catch(error => {
      log('not relayed: ' + error.message);
      // A request is owed exactly one answer; a failed relay is that answer unless it was already given.
      if (message?.id !== undefined && message.method && settle(message.id)) {
        fail(message.id, error.refused ? 'The DevMate runtime refused this request: ' + error.message
          : error.outcomeUnknown ? UNKNOWN_OUTCOME : 'The DevMate runtime could not be reached: ' + error.message);
      }
    });
  };
  client.onerror = error => log('client: ' + error.message);
  async function close() {
    if (finished) return;
    finished = true;
    const connections = [upstream, ...retired].filter(Boolean);
    upstream = null; retired.clear();
    await Promise.allSettled([...connections.map(transport => transport.close()), client.close()]);
    release();
  }
  // The client ending its side ends this process's purpose.
  client.onclose = () => { void close(); };
  stdin.once('end', () => { void close(); });
  stdin.once('close', () => { void close(); });
  await client.start();
  return { closed, close };
}
