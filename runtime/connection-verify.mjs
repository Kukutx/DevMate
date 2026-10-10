import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { VERSION } from './version.mjs';

const reason = error => String(error?.cause?.code || error?.code || error?.message || error).slice(0, 300);

/**
 * Prove the configured public URL reaches THIS runtime: a real MCP client
 * connects through the public route, lists tools and calls one, and the answer
 * must carry this runtime's generation. A live tunnel process alone proves nothing.
 * With sign-in enabled the runtime presents a short-lived token it issued to
 * itself, so the check is the same round trip a signed-in client makes.
 */
export async function verifyPublicMcp({ url, authMode = 'none', accessToken, expectedGeneration, timeoutMs = 15000,
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
    return { verified: false, reachable: false, reason: reason(error) };
  } finally { await client.close().catch(() => {}); }
}
