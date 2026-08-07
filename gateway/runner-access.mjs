import crypto from 'node:crypto';
import { defaultedBoolean, defaultedInteger } from './strict-config.mjs';

export const RUNNER_PROTOCOL_VERSION = 1;

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cleanId(value, fallback = 'runner') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('expiresAt must be a valid ISO date-time');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('expiresAt must be a valid ISO date-time');
  return new Date(time).toISOString();
}

function normalizeStrings(values, limit = 200) {
  if (!Array.isArray(values)) throw new TypeError('Expected an array of strings');
  return [...new Set(values
    .map(value => {
      if (typeof value !== 'string') throw new TypeError('Expected an array of strings');
      return value.trim();
    })
    .filter(Boolean))].slice(0, limit);
}

function hashSecret(secret, salt) {
  return base64url(crypto.scryptSync(String(secret), Buffer.from(salt, 'base64url'), 32));
}

function uniqueCredentialId(config, requested = '') {
  const base = cleanId(requested || `runner-${crypto.randomBytes(3).toString('hex')}`);
  const used = new Set((config.runnerControl?.credentials || []).map(item => item.id));
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  return id;
}

export function normalizeRunnerControlConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  config.runnerControl ||= {};
  const control = config.runnerControl;
  if (typeof control !== 'object' || Array.isArray(control)) throw new TypeError('runnerControl must be an object');
  control.enabled = defaultedBoolean(control.enabled, false, 'runnerControl.enabled');
  if (control.path === undefined) control.path = '/runner/v1';
  else if (control.path !== '/runner/v1') throw new Error('runnerControl.path must be /runner/v1');
  control.maxRequestBytes = defaultedInteger(control.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024, 'runnerControl.maxRequestBytes');
  control.requestsPerMinute = defaultedInteger(control.requestsPerMinute, 600, 30, 10000, 'runnerControl.requestsPerMinute');
  control.maxCredentials = defaultedInteger(control.maxCredentials, 100, 1, 500, 'runnerControl.maxCredentials');
  if (control.credentials === undefined) control.credentials = [];
  if (!Array.isArray(control.credentials)) throw new TypeError('runnerControl.credentials must be an array');
  return config;
}

export function runnerCredentialPublic(credential) {
  return {
    id: credential.id,
    name: credential.name,
    capabilities: Array.isArray(credential.capabilities) ? [...credential.capabilities] : [],
    workspaceIds: Array.isArray(credential.workspaceIds) ? [...credential.workspaceIds] : [],
    maxConcurrent: defaultedInteger(credential.maxConcurrent, 1, 1, 16, 'runner credential maxConcurrent'),
    createdAt: credential.createdAt || null,
    updatedAt: credential.updatedAt || null,
    expiresAt: credential.expiresAt || null,
    disabled: credential.disabled === true,
    lastUsedAt: credential.lastUsedAt || null,
    tokenVersion: defaultedInteger(credential.tokenVersion, 1, 1, Number.MAX_SAFE_INTEGER, 'runner credential tokenVersion')
  };
}

export function createRunnerCredential(config, input = {}) {
  normalizeRunnerControlConfig(config);
  if (config.runnerControl.credentials.length >= config.runnerControl.maxCredentials) {
    throw new Error(`Runner credential limit reached (${config.runnerControl.maxCredentials})`);
  }
  const workspaceIds = normalizeStrings(input.workspaceIds ?? [], 200);
  if (!workspaceIds.length) throw new Error('External Runner credentials require at least one explicit workspaceId');
  const id = uniqueCredentialId(config, input.id || input.name);
  const secret = base64url(crypto.randomBytes(32));
  const salt = base64url(crypto.randomBytes(16));
  const timestamp = new Date().toISOString();
  const capabilities = normalizeStrings(input.capabilities ?? ['core', 'external'], 50).map(value => value.toLowerCase());
  const credential = {
    id,
    name: String(input.name || id).trim().slice(0, 200) || id,
    capabilities,
    workspaceIds,
    maxConcurrent: defaultedInteger(input.maxConcurrent, 1, 1, 16, 'Runner maxConcurrent'),
    salt,
    tokenHash: hashSecret(secret, salt),
    tokenVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: parseExpiry(input.expiresAt),
    disabled: false,
    lastUsedAt: null
  };
  if (!credential.capabilities.includes('core')) credential.capabilities.unshift('core');
  if (!credential.capabilities.includes('external')) credential.capabilities.push('external');
  config.runnerControl.credentials.push(credential);
  config.runnerControl.enabled = true;
  return { credential: runnerCredentialPublic(credential), token: `dmr_${id}_${secret}` };
}

export function updateRunnerCredential(config, id, patch = {}) {
  normalizeRunnerControlConfig(config);
  const credential = config.runnerControl.credentials.find(item => item.id === id);
  if (!credential) throw new Error(`Runner credential not found: ${id}`);
  if (patch.name !== undefined) credential.name = String(patch.name || '').trim().slice(0, 200) || credential.id;
  if (patch.capabilities !== undefined) {
    credential.capabilities = normalizeStrings(patch.capabilities, 50).map(value => value.toLowerCase());
    if (!credential.capabilities.includes('core')) credential.capabilities.unshift('core');
    if (!credential.capabilities.includes('external')) credential.capabilities.push('external');
  }
  if (patch.workspaceIds !== undefined) {
    const workspaceIds = normalizeStrings(patch.workspaceIds, 200);
    if (!workspaceIds.length) throw new Error('External Runner credentials require at least one explicit workspaceId');
    credential.workspaceIds = workspaceIds;
  }
  if (patch.maxConcurrent !== undefined) credential.maxConcurrent = defaultedInteger(patch.maxConcurrent, 1, 1, 16, 'Runner maxConcurrent');
  if (patch.expiresAt !== undefined) credential.expiresAt = parseExpiry(patch.expiresAt);
  if (patch.disabled !== undefined) credential.disabled = defaultedBoolean(patch.disabled, false, 'Runner disabled');
  credential.updatedAt = new Date().toISOString();
  return runnerCredentialPublic(credential);
}

export function rotateRunnerCredentialToken(config, id) {
  normalizeRunnerControlConfig(config);
  const credential = config.runnerControl.credentials.find(item => item.id === id);
  if (!credential) throw new Error(`Runner credential not found: ${id}`);
  const secret = base64url(crypto.randomBytes(32));
  const salt = base64url(crypto.randomBytes(16));
  credential.salt = salt;
  credential.tokenHash = hashSecret(secret, salt);
  credential.tokenVersion = defaultedInteger(credential.tokenVersion, 1, 1, Number.MAX_SAFE_INTEGER - 1, 'runner credential tokenVersion') + 1;
  credential.updatedAt = new Date().toISOString();
  credential.disabled = false;
  return { credential: runnerCredentialPublic(credential), token: `dmr_${credential.id}_${secret}` };
}

export function revokeRunnerCredential(config, id) {
  normalizeRunnerControlConfig(config);
  const credential = config.runnerControl.credentials.find(item => item.id === id);
  if (!credential) throw new Error(`Runner credential not found: ${id}`);
  credential.disabled = true;
  credential.updatedAt = new Date().toISOString();
  return runnerCredentialPublic(credential);
}

function parseRunnerToken(token) {
  const match = String(token || '').match(/^dmr_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}

export function verifyRunnerToken(token, config) {
  normalizeRunnerControlConfig(config);
  if (!config.runnerControl.enabled) return null;
  const parsed = parseRunnerToken(token);
  if (!parsed) return null;
  const credential = config.runnerControl.credentials.find(item => item.id === parsed.id);
  if (!credential || credential.disabled || !credential.salt || !credential.tokenHash) return null;
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) return null;
  const candidate = hashSecret(parsed.secret, credential.salt);
  if (!timingSafeEqualText(candidate, credential.tokenHash)) return null;
  const workspaceIds = normalizeStrings(credential.workspaceIds ?? [], 200);
  if (!workspaceIds.length) return null;
  const capabilities = normalizeStrings(credential.capabilities ?? [], 50);
  if (!capabilities.includes('core') || !capabilities.includes('external')) {
    throw new Error(`Runner credential ${credential.id} is missing required core/external capabilities`);
  }
  return {
    id: credential.id,
    name: credential.name || credential.id,
    capabilities,
    workspaceIds,
    maxConcurrent: defaultedInteger(credential.maxConcurrent, 1, 1, 16, 'Runner maxConcurrent'),
    source: 'runner-token',
    tokenVersion: defaultedInteger(credential.tokenVersion, 1, 1, Number.MAX_SAFE_INTEGER, 'runner credential tokenVersion')
  };
}

export function touchRunnerCredential(config, id, at = new Date().toISOString()) {
  normalizeRunnerControlConfig(config);
  const credential = config.runnerControl.credentials.find(item => item.id === id);
  if (!credential) return false;
  const last = Date.parse(credential.lastUsedAt || 0);
  if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000) return false;
  credential.lastUsedAt = at;
  return true;
}

export const __test = { hashSecret, parseRunnerToken, timingSafeEqualText };
