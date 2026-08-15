import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/oauth.mjs';

const { originFor } = __test;

function request(host, extra = {}) {
  return { headers: { host, ...extra } };
}

test('OAuth origin ignores spoofable forwarded Host and protocol headers', () => {
  assert.equal(originFor(request('127.0.0.1:8787', {
    'x-forwarded-host': 'evil.example.com',
    'x-forwarded-proto': 'https'
  })), 'http://127.0.0.1:8787');

  assert.equal(originFor(request('devmate.example.com', {
    'x-forwarded-host': 'evil.example.com',
    'x-forwarded-proto': 'http'
  })), 'https://devmate.example.com');
});

test('OAuth origin keeps local loopback HTTP and public HTTPS contracts', () => {
  assert.equal(originFor(request('localhost:8787')), 'http://localhost:8787');
  assert.equal(originFor(request('[::1]:8787')), 'http://[::1]:8787');
  assert.equal(originFor(request('public.example.com')), 'https://public.example.com');
});

test('OAuth origin rejects malformed Host input', () => {
  for (const host of ['', 'evil.example.com/path', 'user@evil.example.com', 'bad host']) {
    assert.throws(() => originFor(request(host)), /invalid host/);
  }
});
