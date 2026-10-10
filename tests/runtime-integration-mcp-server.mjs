// Protocol fixture only. Started as an owned stdio child by isolated integration tests.
import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEAAAAABJRU5ErkJggg==';
const server = new McpServer({ name: 'devmate-integration-external', version: '1.0.0' });
server.registerTool('image', { inputSchema: z.object({}) }, async () => ({
  content: [
    { type: 'text', text: 'fixture image caption', annotations: { audience: ['user'] } },
    { type: 'image', data: png, mimeType: 'image/png', annotations: { audience: ['user'], priority: 0.9 } }
  ],
  structuredContent: { pid: process.pid, source: 'official SDK stdio fixture' },
  _meta: { fixture: { preserve: true } }
}));
server.registerTool('form', { inputSchema: z.object({}) }, async (_args, context) => {
  if (!context.mcpReq.inputResponses?.answer) return inputRequired({
    inputRequests: { answer: inputRequired.elicit({
      mode: 'form', message: 'Choose a fixture release',
      requestedSchema: { type: 'object', properties: {
        name: { type: 'string', title: 'Name', minLength: 2 },
        channel: { type: 'string', title: 'Channel', enum: ['internal', 'preview'] },
        confirm: { type: 'boolean', title: 'Confirm' }
      }, required: ['name', 'channel', 'confirm'], additionalProperties: false }
    }) }
  });
  const response = context.mcpReq.inputResponses.answer;
  return { content: [{ type: 'text', text: 'native form response returned' }], structuredContent: { response, pid: process.pid } };
});
await server.connect(new StdioServerTransport());
