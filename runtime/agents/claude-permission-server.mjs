// Public MCP permission tool for Claude Code --permission-prompt-tool.
// Uses the installed official MCP SDK, with no provider-private control protocol.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const endpoint = process.env.DEVMATE_AGENT_APPROVAL_ENDPOINT;
const token = process.env.DEVMATE_AGENT_APPROVAL_TOKEN;
if (!endpoint || !token || !/^http:\/\/127\.0\.0\.1:\d+\/permission$/.test(endpoint)) {
  process.stderr.write('Missing DevMate approval bridge\n'); process.exit(1);
}
const unavailable = { behavior: 'deny', message: 'Approval bridge unavailable' };
// The answer arrives when a person decides, which can take hours. node:http waits for
// response headers without a deadline; fetch gives up after five minutes and would
// report a denial while DevMate still shows the request as pending.
function ask(input) {
  return new Promise(resolve => {
    const body = JSON.stringify(input);
    const request = http.request(endpoint, { method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + token } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); });
      response.on('error', () => resolve(unavailable));
      response.on('end', () => {
        try {
          const decision = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(['allow', 'deny'].includes(decision?.behavior) ? decision : unavailable);
        } catch { resolve(unavailable); }
      });
    });
    request.on('error', () => resolve(unavailable));
    request.end(body);
  });
}
const server = new McpServer({ name: 'devmate-approval', version: '1.0.0' });
server.registerTool('decide', {
  description: 'Ask the user whether this exact Claude tool invocation is permitted.',
  inputSchema: z.object({
    tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional()
  }).passthrough()
}, async input => ({ content: [{ type: 'text', text: JSON.stringify(await ask(input)) }] }));
await server.connect(new StdioServerTransport());
