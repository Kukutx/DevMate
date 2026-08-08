'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowedHosts,
  normalizeAllowedHosts,
  publicHost,
  reconcileAllowedHosts
} = require('../shared/deployment-hosts.cjs');

test('normalizes bounded Host identities without inventing URL semantics', () => {
  assert.equal(publicHost('https://Example.COM:8443'), 'example.com:8443');
  assert.equal(publicHost('not a url'), '');
  assert.deepEqual(normalizeAllowedHosts([' A.Example.com ', 'a.example.com', '', 'B.EXAMPLE.COM']), [
    'a.example.com',
    'b.example.com'
  ]);
  assert.deepEqual(allowedHosts(['manual.example.com'], 'https://active.example.com'), [
    'manual.example.com',
    'active.example.com'
  ]);
});

test('production URL migration removes the previous active Host and adds the next stable Host', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com', 'manual.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: 'https://new.example.com',
    nextMode: 'production'
  }), ['manual.example.com', 'new.example.com']);
});

test('production to team dynamic ingress removes the obsolete production Host without deleting manual policy', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com', 'manual.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: '',
    nextMode: 'team'
  }), ['manual.example.com']);
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: '',
    nextMode: 'team'
  }), []);
});

test('team stable URL migration keeps an existing Host policy and replaces the active route', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com', 'manual.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: 'https://new.example.com',
    nextMode: 'team'
  }), ['manual.example.com', 'new.example.com']);
});

test('personal mode removes the obsolete active route while retaining unrelated remembered policy', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com', 'manual.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: '',
    nextMode: 'personal'
  }), ['manual.example.com']);
});
