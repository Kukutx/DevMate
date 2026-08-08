'use strict';

const SAFE_STORAGE_PREFIX = 'safeStorage:v1:';

function electronSafeStorage() {
  try {
    const api = require('electron')?.safeStorage;
    return api && typeof api.isEncryptionAvailable === 'function' ? api : null;
  } catch {
    return null;
  }
}

function encryptionAvailable(api = electronSafeStorage()) {
  try { return !!api?.isEncryptionAvailable?.(); }
  catch { return false; }
}

function encryptSecret(value, api = electronSafeStorage()) {
  const secret = String(value || '').trim();
  if (!secret) return '';
  if (!encryptionAvailable(api) || typeof api.encryptString !== 'function') {
    const error = new Error('Secure OS-backed encryption is unavailable in this Obsidian environment');
    error.code = 'DEVMATE_SECRET_ENCRYPTION_UNAVAILABLE';
    throw error;
  }
  const encrypted = api.encryptString(secret);
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    const error = new Error('Obsidian secure storage returned no encrypted secret');
    error.code = 'DEVMATE_SECRET_ENCRYPTION_FAILED';
    throw error;
  }
  return `${SAFE_STORAGE_PREFIX}${encrypted.toString('base64')}`;
}

function decryptSecret(value, api = electronSafeStorage()) {
  const encoded = String(value || '').trim();
  if (!encoded) return '';
  if (!encoded.startsWith(SAFE_STORAGE_PREFIX)) {
    const error = new Error('Stored DevMate secret uses an unsupported format');
    error.code = 'DEVMATE_SECRET_FORMAT_UNSUPPORTED';
    throw error;
  }
  if (!encryptionAvailable(api) || typeof api.decryptString !== 'function') {
    const error = new Error('Secure OS-backed decryption is unavailable in this Obsidian environment');
    error.code = 'DEVMATE_SECRET_DECRYPTION_UNAVAILABLE';
    throw error;
  }
  let encrypted;
  try { encrypted = Buffer.from(encoded.slice(SAFE_STORAGE_PREFIX.length), 'base64'); }
  catch {
    const error = new Error('Stored DevMate secret is malformed');
    error.code = 'DEVMATE_SECRET_FORMAT_INVALID';
    throw error;
  }
  if (!encrypted.length) {
    const error = new Error('Stored DevMate secret is empty');
    error.code = 'DEVMATE_SECRET_FORMAT_INVALID';
    throw error;
  }
  const secret = String(api.decryptString(encrypted) || '').trim();
  if (!secret) {
    const error = new Error('Stored DevMate secret could not be decrypted');
    error.code = 'DEVMATE_SECRET_DECRYPTION_FAILED';
    throw error;
  }
  return secret;
}

module.exports = {
  SAFE_STORAGE_PREFIX,
  decryptSecret,
  electronSafeStorage,
  encryptSecret,
  encryptionAvailable
};