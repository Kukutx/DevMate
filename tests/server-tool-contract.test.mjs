import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerToolDecorator,
  serverExtensionInstanceStatus
} from '../gateway/server-extension-host.mjs';

function Server() {
  this.calls = [];
}
Server.prototype.registerTool = function registerTool(name, config, handler) {
  this.calls.push({ name, config, handler });
  return { name };
};
Server.prototype.connect = async function connect() { return 'connected'; };

registerToolDecorator(Server, {
  id: 'test.noop',
  order: 1,
  decorate(registration) { return registration; }
});

test('tracks registered tool contracts per server instance', () => {
  const server = new Server();
  server.registerTool('example_status', {
    title: 'Example status',
    description: 'Read example status.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, async () => ({}));
  assert.deepEqual(serverExtensionInstanceStatus(server).tools, [{
    name: 'example_status',
    title: 'Example status',
    description: 'Read example status.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    hasInputSchema: true,
    hasOutputSchema: false
  }]);
});

test('rejects duplicate tool names across all registration sources', () => {
  const server = new Server();
  const config = {
    title: 'Duplicate',
    description: 'Duplicate registration fixture.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  };
  server.registerTool('duplicate_tool', config, async () => ({}));
  assert.throws(() => server.registerTool('duplicate_tool', config, async () => ({})), /Duplicate MCP tool registration/);
});
