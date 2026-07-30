import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerServerInitializer,
  registerToolDecorator,
  serverExtensionHostStatus
} from '../gateway/server-extension-host.mjs';

class MockServer {
  constructor() {
    this.tools = new Map();
    this.connectCalls = 0;
  }
  registerTool(name, config, handler) {
    this.tools.set(name, { config, handler });
  }
  async connect() {
    this.connectCalls += 1;
    return 'connected';
  }
}

const events = [];
registerServerInitializer(MockServer, {
  id: 'late',
  order: 30,
  async initialize(server) {
    await new Promise(resolve => setTimeout(resolve, 10));
    events.push('late');
    server.registerTool('late_tool', {}, async () => 'late');
  }
});
registerServerInitializer(MockServer, {
  id: 'early',
  order: 10,
  initialize(server) {
    events.push('early');
    server.registerTool('early_tool', {}, async () => 'early');
  }
});
registerToolDecorator(MockServer, {
  id: 'outer',
  order: 20,
  decorate({ handler }) {
    return { handler: async args => `${await handler(args)}:outer` };
  }
});
registerToolDecorator(MockServer, {
  id: 'inner',
  order: 10,
  decorate({ handler }) {
    return { handler: async args => `${await handler(args)}:inner` };
  }
});

// Duplicate registrations are deliberately ignored by id.
registerServerInitializer(MockServer, {
  id: 'early',
  order: 1,
  initialize() {
    throw new Error('duplicate initializer should not run');
  }
});

test('orders decorators and initializers deterministically', async () => {
  const server = new MockServer();
  server.registerTool('base', {}, async () => 'base');
  await Promise.all([server.connect(), server.connect()]);

  assert.deepEqual(events, ['early', 'late']);
  assert.equal(server.connectCalls, 2);
  assert.equal(await server.tools.get('base').handler({}), 'base:inner:outer');
  assert.equal(await server.tools.get('early_tool').handler({}), 'early:inner:outer');
  assert.equal(await server.tools.get('late_tool').handler({}), 'late:inner:outer');
});

test('reports one installed host with sorted extensions', () => {
  assert.deepEqual(serverExtensionHostStatus(MockServer), {
    installed: true,
    decorators: [
      { id: 'inner', order: 10 },
      { id: 'outer', order: 20 }
    ],
    initializers: [
      { id: 'early', order: 10 },
      { id: 'late', order: 30 }
    ]
  });
});
