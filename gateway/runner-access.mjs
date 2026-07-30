import crypto from 'node:crypto';

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

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parseExpiry(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('expiresAt must be a valid ISO date-time');
  return new Date(time).toISOString();
}

function normalizeStrings(values, limit = 200) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
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
  config.runnerControl ||= {};
  const control = config.runnerControl;
  control.enabled = control.enabled === true;
  control.path = '/runner/v1';
  control.maxRequestBytes = clampInt(control.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024);
  control.requestsPerMinute = clampInt(control.requestsPerMinute, 600, 30, 10000);
  control.maxCredentials = clampInt(control.maxCredentials, 100, 1, 500);
  if (!Array.isArray(control.credentials)) control.credentials = [];
  return config;
}

export function runnerCredentialPublic(credential) {
  return {
    id: credential.id,
    name: credential.name,
    capabilities: Array.isArray(credential.capabilities) ? [...credential.capabilities] : [],
    workspaceIds: Array.isArray(credential.workspaceIds) ? [...credential.workspaceIds] : [],
    maxConcurrent: clampInt(credential.maxConcurrent, 1, 1, 16),
    createdAt: credential.createdAt || null,
    updatedAt: credential.updatedAt || null,
    expiresAt: credential.expiresAt || null,
    disabled: !!credential.disabled,
    lastUsedAt: credential.lastUsedAt || null,
    tokenVersion: credential.tokenVersion || 1
  };
}

export function createRunnerCredential(config, input = {}) {
  normalizeRunnerControlConfig(config);
  if (config.runnerControl.credentials.length >= config.runnerControl.maxCredentials) {
    throw new Error(`Runner credential limit reached (${config.runnerControl.maxCredentials})`);
  }
  const workspaceIds = normalizeStrings(input.workspaceIds || [], 200);
  if (!workspaceIds.length) throw new Error('External Runner credentials require at least one explicit workspaceId');
  const id = uniqueCredentialId(config, input.id || input.name);
  const secret = base64url(crypto.randomBytes(32));
  const salt = base64url(crypto.randomBytes(16));
  const timestamp = new Date().toISOString();
  const credential = {
    id,
    name: String(input.name || id).trim().slice(0, 200) || id,
    capabilities: normalizeStrings(input.capabilities || ['core', 'external'], 50).map(value => value.toLowerCase()),
    workspaceIds,
    maxConcurrent: clampInt(input.maxConcurrent, 1, 1, 16),
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
  if (patch.maxConcurrent !== undefined) credential.maxConcurrent = clampInt(patch.maxConcurrent, credential.maxConcurrent || 1, 1, 16);
  if (patch.expiresAt !== undefined) credential.expiresAt = parseExpiry(patch.expiresAt);
  if (patch.disabled !== undefined) credential.disabled = !!patch.disabled;
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
  credential.tokenVersion = (credential.tokenVersion || 1) + 1;
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
  const match = String(token || '').match(/^dmr_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{20,})$/);
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
  const workspaceIds = Array.isArray(credential.workspaceIds) ? [...credential.workspaceIds] : [];
  if (!workspaceIds.length) return null;
  return {
    id: credential.id,
    name: credential.name || credential.id,
    capabilities: Array.isArray(credential.capabilities) ? [...credential.capabilities] : ['core', 'external'],
    workspaceIds,
    maxConcurrent: clampInt(credential.maxConcurrent, 1, 1, 16),
    source: 'runner-token',
    tokenVersion: credential.tokenVersion || 1
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
