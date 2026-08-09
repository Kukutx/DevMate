'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowedHosts,
  normalizeAllowedHosts,
  publicHost,
  reconcileAllowedHosts
} = require('../shared/public-host-policy.cjs');

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

test('replacing the active public endpoint keeps manual policy and replaces only the derived Host', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com', 'manual.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: 'https://new.example.com'
  }), ['manual.example.com', 'new.example.com']);
});

test('clearing a dynamic public endpoint removes only its previous derived Host', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com', 'manual.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: ''
  }), ['manual.example.com']);
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['old.example.com'],
    previousPublicUrl: 'https://old.example.com',
    nextPublicUrl: ''
  }), []);
});

test('adding a stable endpoint never drops unrelated explicit Host policy', () => {
  assert.deepEqual(reconcileAllowedHosts({
    currentAllowedHosts: ['manual.example.com'],
    previousPublicUrl: '',
    nextPublicUrl: 'https://stable.example.com'
  }), ['manual.example.com', 'stable.example.com']);
});
