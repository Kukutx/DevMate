import dns from 'node:dns/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { VERSION } from './version.mjs';

const reason = error => String(error?.cause?.code || error?.code || error?.message || error).slice(0, 300);
// Whether the world's DNS knows a host name, asked of public resolvers directly. The answer of this computer's own
// resolver is a different question: asked too early about a name that is seconds old, it remembers "no such name".
export async function publicDnsKnows(host, { servers = ['1.1.1.1', '8.8.8.8'], timeoutMs = 3000 } = {}) {
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers(servers);
  const found = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  return found.some(result => result.status === 'fulfilled' && result.value.length > 0);
}

/**
 * Prove the configured public URL reaches THIS runtime: a real MCP client
 * connects through the public route, lists tools and calls one, and the answer
 * must carry this runtime's generation. A live tunnel process alone proves nothing.
 * With sign-in enabled the runtime presents a short-lived token it issued to
 * itself, so the check is the same round trip a signed-in client makes.
 *
 * newAddress: the host name was created moments ago (a quick tunnel). It is not asked for through this computer's
 * resolver before public DNS knows it, and a resolver that already remembers "no such name" is told apart from a
 * route that does not work.
 */
export async function verifyPublicMcp({ url, authMode = 'none', accessToken, expectedGeneration, timeoutMs = 15000, newAddress = false, knownPublicly = publicDnsKnows, lookup = dns.lookup,
  fetchImpl = globalThis.fetch, clientFactory = () => new Client({ name: 'devmate-connection-verify', version: VERSION }, { versionNegotiation: { mode: 'auto' } }),
  transportFactory = (target, headers) => new StreamableHTTPClientTransport(new URL(target), { requestInit: { redirect: 'error', ...(headers ? { headers } : {}) } }) } = {}) {
  if (authMode === 'oauth' && !accessToken) {
    // Without a token only reachability and the OAuth challenge can be confirmed.
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
      await response.body?.cancel();
      const challenged = response.status === 401 && /resource_metadata=/.test(response.headers.get('www-authenticate') || '');
      return { verified: false, reachable: challenged, reason: challenged
        ? 'The public endpoint is reachable and asks for OAuth. Sign in from the MCP client to complete the check.'
        : 'Unexpected HTTP ' + response.status + ' from the public endpoint.' };
    } catch (error) { return { verified: false, reachable: false, reason: reason(error) }; }
  }
  const host = new URL(url).hostname;
  if (newAddress && !await knownPublicly(host).catch(() => true)) return { verified: false, reachable: false, pending: 'dns', reason: 'The address is seconds old and not in DNS yet.' };
  const client = clientFactory();
  try {
    await client.connect(await transportFactory(url, accessToken ? { Authorization: 'Bearer ' + accessToken } : undefined), { timeout: timeoutMs });
    const listed = await client.listTools({}, { timeout: timeoutMs });
    const status = await client.callTool({ name: 'connection_status', arguments: {} }, { timeout: timeoutMs });
    if (status.isError) return { verified: false, reachable: true, reason: 'The public endpoint rejected a tool call.' };
    if (status.structuredContent?.instance?.generation !== expectedGeneration) {
      return { verified: false, reachable: true, reason: 'The public URL is answered by a different DevMate runtime.' };
    }
    return { verified: true, reachable: true, tools: listed.tools.length };
  } catch (error) {
    // The client library reports its own error; whether this computer can resolve the name is asked directly.
    const unresolved = await Promise.resolve().then(() => lookup(host)).then(() => false, failure => failure?.code === 'ENOTFOUND');
    if (unresolved && await knownPublicly(host).catch(() => false)) return { verified: false, reachable: false, pending: 'local-dns',
      reason: 'This computer\'s DNS does not know the address yet, while public DNS does: clients in the cloud can already connect. The check here passes once this computer\'s DNS forgets its earlier answer.' };
    return { verified: false, reachable: false, reason: reason(error) };
  } finally { await client.close().catch(() => {}); }
}
