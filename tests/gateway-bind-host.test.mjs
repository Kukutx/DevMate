
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Gateway defaults to loopback and permits an explicit deployment bind host', () => {
  const source = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
  assert.match(source, /process\.env\.DEVMATE_BIND_HOST \|\| config\.server\?\.host \|\| '127\.0\.0\.1'/);
  assert.match(source, /httpServer\.listen\(config\.server\.port,bindHost/);
  assert.doesNotMatch(source, /httpServer\.listen\(config\.server\.port,'127\.0\.0\.1'/);
});

test('container deployment explicitly binds inside the namespace and publishes host loopback', () => {
  const docker = fs.readFileSync(path.join(root, 'deploy', 'docker', 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'deploy', 'docker', 'compose.example.yml'), 'utf8');
  assert.match(docker, /DEVMATE_BIND_HOST=0\.0\.0\.0/);
  assert.match(compose, /DEVMATE_BIND_HOST:\s*0\.0\.0\.0/);
  assert.match(compose, /127\.0\.0\.1:8787:8787/);
});
