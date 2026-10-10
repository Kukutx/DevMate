import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { VERSION } from './version.mjs';

const endpoint = process.env.DEVMATE_AGENT_URL;
const token = process.env.DEVMATE_AGENT_TOKEN;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/api\/agent$/.test(endpoint) || !token) {
  throw new Error('DevMate agent channel requires a scoped local endpoint and token.');
}
const server = new McpServer({ name: 'devmate-agent-channel', version: VERSION });
const tools = [
  ['agent_peers', 'List native agents in this project workflow, with optional pagination.',
    z.object({ cursor:z.string().min(1).max(160).optional(), limit:z.number().int().min(1).max(200).optional() }), true],
  ['agent_inbox', 'Read the latest messages to or from this agent. Use nextCursor to retrieve older messages.',
    z.object({ cursor:z.string().min(1).max(512).optional(), limit:z.number().int().min(1).max(500).optional() }), true],
  ['agent_send_message', 'Deliver a message to other agents in this workflow. Supply a unique operationId for each new send, and reuse the SAME operationId on retries after an uncertain response. Delivery is asynchronous and executes a native turn when the recipient is ready.',
    z.object({ operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
      recipientIds: z.array(z.string()).min(1).max(16), body: z.string().min(1).max(100000) }), false]
];
for (const [name, description, inputSchema, readOnlyHint] of tools) {
  server.registerTool(name, { description, inputSchema, annotations: {
    readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: readOnlyHint, openWorldHint: false
  } }, async input => {
    const response = await fetch(endpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + token
    }, body: JSON.stringify({ name, input }), signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    if (!response.ok || !body.ok) return { isError: true, content: [{ type: 'text', text: body.error?.message || 'Agent channel request failed.' }] };
    return { structuredContent: body.result, content: [{ type: 'text', text: JSON.stringify(body.result) }] };
  });
}
await server.connect(new StdioServerTransport());
