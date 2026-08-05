'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SpawnLayer,
  installedSpawnLayers
} = require('../vscode-host/spawn-layer.js');

function wrapper(name, calls) {
  return previous => function layeredSpawn(command, args, options) {
    calls.push(name);
    return previous(command, args, options);
  };
}

test('installs nested spawn layers and restores them in reverse order', () => {
  const calls = [];
  const original = () => { calls.push('base'); return 'ok'; };
  const childProcess = { spawn: original };
  const lower = new SpawnLayer({ childProcess, name: 'lower', wrap: wrapper('lower', calls) }).install();
  const upper = new SpawnLayer({ childProcess, name: 'upper', wrap: wrapper('upper', calls) }).install();

  assert.deepEqual(installedSpawnLayers(childProcess), ['lower', 'upper']);
  assert.equal(childProcess.spawn('cmd', [], {}), 'ok');
  assert.deepEqual(calls, ['upper', 'lower', 'base']);
  assert.deepEqual(upper.snapshot(), {
    name: 'upper',
    active: true,
    depth: 2,
    stack: ['lower', 'upper']
  });

  assert.deepEqual(upper.dispose(), { disposed: true });
  assert.deepEqual(installedSpawnLayers(childProcess), ['lower']);
  assert.deepEqual(lower.dispose(), { disposed: true });
  assert.deepEqual(installedSpawnLayers(childProcess), []);
  assert.equal(childProcess.spawn, original);
});

test('rejects out-of-order disposal without corrupting the active chain', () => {
  const childProcess = { spawn() {} };
  const original = childProcess.spawn;
  const lower = new SpawnLayer({ childProcess, name: 'lower', wrap: previous => previous }).install();
  const upper = new SpawnLayer({ childProcess, name: 'upper', wrap: previous => previous }).install();

  assert.throws(
    () => lower.dispose(),
    error => error.code === 'DEVMATE_SPAWN_LAYER_ORDER_VIOLATION' && error.layerName === 'lower'
  );
  assert.deepEqual(installedSpawnLayers(childProcess), ['lower', 'upper']);
  upper.dispose();
  lower.dispose();
  assert.equal(childProcess.spawn, original);
});

test('reactivation captures the new lower spawn implementation', () => {
  const calls = [];
  const firstBase = () => { calls.push('first-base'); };
  const childProcess = { spawn: firstBase };
  const first = new SpawnLayer({ childProcess, name: 'managed', wrap: wrapper('managed-1', calls) }).install();
  childProcess.spawn('cmd');
  first.dispose();

  const secondBase = () => { calls.push('second-base'); };
  childProcess.spawn = secondBase;
  const second = new SpawnLayer({ childProcess, name: 'managed', wrap: wrapper('managed-2', calls) }).install();
  childProcess.spawn('cmd');
  second.dispose();

  assert.deepEqual(calls, ['managed-1', 'first-base', 'managed-2', 'second-base']);
  assert.equal(childProcess.spawn, secondBase);
});

test('install and dispose are idempotent for the same layer instance', () => {
  const original = () => 'ok';
  const childProcess = { spawn: original };
  const layer = new SpawnLayer({ childProcess, name: 'one', wrap: previous => previous });
  assert.equal(layer.install(), layer);
  assert.equal(layer.install(), layer);
  assert.deepEqual(installedSpawnLayers(childProcess), ['one']);
  assert.deepEqual(layer.dispose(), { disposed: true });
  assert.deepEqual(layer.dispose(), { disposed: true, alreadyDisposed: true });
  assert.equal(childProcess.spawn, original);
});
