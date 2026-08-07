import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installHttpServerBootstrap } from '../gateway/http-server-bootstrap.mjs';

function fixture() {
  const calls = [];
  const originalCreateServer = (...args) => {
    calls.push(['native', ...args]);
    return new EventEmitter();
  };
  return {
    calls,
    originalCreateServer,
    httpModule: { createServer: originalCreateServer }
  };
}

test('layers Gateway HTTP wrappers only during bootstrap and restores the native factory', () => {
  const { calls, originalCreateServer, httpModule } = fixture();
  const servers = [];
  const installA = module => {
    const previous = module.createServer;
    module.createServer = (...args) => {
      calls.push(['a']);
      return previous(...args);
    };
  };
  const installB = module => {
    const previous = module.createServer;
    module.createServer = (...args) => {
      calls.push(['b']);
      return previous(...args);
    };
  };

  const bootstrap = installHttpServerBootstrap(httpModule, {
    installers: [installA, installB],
    onServer: server => servers.push(server)
  });
  assert.equal(bootstrap.active, true);
  assert.notEqual(httpModule.createServer, originalCreateServer);

  const server = httpModule.createServer('listener');
  assert.equal(servers.length, 1);
  assert.equal(servers[0], server);
  assert.deepEqual(calls.map(item => item[0]), ['b', 'a', 'native']);

  assert.equal(bootstrap.restore(), true);
  assert.equal(bootstrap.restore(), false);
  assert.equal(bootstrap.active, false);
  assert.equal(httpModule.createServer, originalCreateServer);

  httpModule.createServer('after');
  assert.deepEqual(calls.map(item => item[0]), ['b', 'a', 'native', 'native']);
});

test('restores the original factory when an installer fails', () => {
  const { originalCreateServer, httpModule } = fixture();
  assert.throws(
    () => installHttpServerBootstrap(httpModule, {
      installers: [
        module => { module.createServer = () => new EventEmitter(); },
        () => { throw new Error('installer failed'); }
      ]
    }),
    /installer failed/
  );
  assert.equal(httpModule.createServer, originalCreateServer);
});

test('rejects invalid bootstrap dependencies without mutating the HTTP module', () => {
  const { originalCreateServer, httpModule } = fixture();
  assert.throws(() => installHttpServerBootstrap(httpModule, { installers: 'bad' }), /installers must be an array/);
  assert.equal(httpModule.createServer, originalCreateServer);
  assert.throws(() => installHttpServerBootstrap(httpModule, { installers: [null] }), /installer must be a function/);
  assert.equal(httpModule.createServer, originalCreateServer);
  assert.throws(() => installHttpServerBootstrap(httpModule, { onServer: null }), /onServer must be a function/);
  assert.equal(httpModule.createServer, originalCreateServer);
});

test('Gateway runtime restores the process-global HTTP factory after all bootstrap initialization', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'gateway', 'server-runtime.mjs'), 'utf8');
  assert.match(source, /installHttpServerBootstrap\(http,/);
  assert.doesNotMatch(source, /http\.createServer\s*=/);

  const bootstrapStart = source.lastIndexOf('\ntry {');
  assert.ok(bootstrapStart > 0);
  const bootstrapBlock = source.slice(bootstrapStart);
  assert.match(bootstrapBlock, /installPlatformCapabilities\(McpServer\)/);
  assert.match(bootstrapBlock, /startJobRuntime\(\)/);
  assert.match(bootstrapBlock, /await import\('\.\/server\.mjs'\)/);
  assert.match(bootstrapBlock, /finally\s*\{\s*httpBootstrap\.restore\(\);\s*\}/s);
});
