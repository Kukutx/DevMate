'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SAFE_STORAGE_PREFIX,
  decryptSecret,
  encryptSecret,
  encryptionAvailable
} = require('../obsidian-plugin/src/secret-store.js');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: buffer => String(buffer).replace(/^enc:/, '')
  };
}

test('Obsidian managed secrets are stored only as encrypted payloads', () => {
  const api = fakeSafeStorage();
  const stored = encryptSecret('secret-token-value', api);
  assert.match(stored, new RegExp(`^${SAFE_STORAGE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(stored, /secret-token-value/);
  assert.equal(decryptSecret(stored, api), 'secret-token-value');
});

test('Obsidian managed secret storage fails closed when OS encryption is unavailable', () => {
  const unavailable = { isEncryptionAvailable: () => false };
  assert.equal(encryptionAvailable(unavailable), false);
  assert.throws(() => encryptSecret('secret', unavailable), /encryption is unavailable/);
  assert.throws(() => decryptSecret(`${SAFE_STORAGE_PREFIX}Zm9v`, unavailable), /decryption is unavailable/);
});

test('Obsidian managed secret storage rejects plaintext legacy values', () => {
  assert.throws(() => decryptSecret('plain-secret', fakeSafeStorage()), /unsupported format/);
});
