import crypto from 'node:crypto';
import { mutateDurableNamespace, readDurableNamespace } from './durable-state.mjs';

const NAMESPACE = 'oauth';
const STATE_VERSION = 2;
const MAX_FAMILIES = 5000;
const MAX_AUTHORIZATION_CODES = 2000;
const FAMILY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REVOKED_RETENTION_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return { version: STATE_VERSION, authorizationCodes: {}, families: {} };
}

function normalizeState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : emptyState();
  if (state.version !== STATE_VERSION) throw new Error(`Unsupported OAuth runtime-state version: ${String(state.version)}`);
  if (!state.authorizationCodes || typeof state.authorizationCodes !== 'object' || Array.isArray(state.authorizationCodes)) {
    throw new Error('OAuth runtime-state authorization codes are invalid');
  }
  if (!state.families || typeof state.families !== 'object' || Array.isArray(state.families)) {
    throw new Error('OAuth runtime-state families are invalid');
  }
  return state;
}

function prune(state, at = Date.now()) {
  for (const [nonce, record] of Object.entries(state.authorizationCodes)) {
    const expiresAt = Date.parse(record?.expiresAt || '');
    if (!Number.isFinite(expiresAt) || expiresAt <= at) delete state.authorizationCodes[nonce];
  }
  const codes = Object.entries(state.authorizationCodes);
  if (codes.length > MAX_AUTHORIZATION_CODES) {
    codes
      .sort(([, left], [, right]) => Date.parse(left?.createdAt || 0) - Date.parse(right?.createdAt || 0))
      .slice(0, codes.length - MAX_AUTHORIZATION_CODES)
      .forEach(([nonce]) => { delete state.authorizationCodes[nonce]; });
  }

  for (const [id, family] of Object.entries(state.families)) {
    const expiresAt = Date.parse(family?.expiresAt || '');
    const revokedAt = Date.parse(family?.revokedAt || '');
    if ((Number.isFinite(expiresAt) && expiresAt <= at) || (Number.isFinite(revokedAt) && revokedAt + REVOKED_RETENTION_MS <= at)) {
      delete state.families[id];
    }
  }
  const retained = Object.entries(state.families);
  if (retained.length > MAX_FAMILIES) {
    retained
      .sort(([, left], [, right]) => Date.parse(left?.updatedAt || left?.createdAt || 0) - Date.parse(right?.updatedAt || right?.createdAt || 0))
      .slice(0, retained.length - MAX_FAMILIES)
      .forEach(([id]) => { delete state.families[id]; });
  }
  return state;
}

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function registerAuthorizationCode(nonce, expiresAt) {
  const key = requireText(nonce, 'OAuth authorization-code nonce');
  const expiry = new Date(expiresAt).toISOString();
  if (Date.parse(expiry) <= Date.now()) throw new Error('OAuth authorization-code expiry must be in the future');
  mutateDurableNamespace(NAMESPACE, emptyState(), current => {
    const state = prune(normalizeState(current));
    if (Object.keys(state.authorizationCodes).length >= MAX_AUTHORIZATION_CODES) {
      throw new Error('OAuth authorization-code capacity reached');
    }
    if (state.authorizationCodes[key]) throw new Error('OAuth authorization-code nonce collision');
    state.authorizationCodes[key] = { createdAt: nowIso(), expiresAt: expiry };
    return state;
  });
}

export function consumeAuthorizationCode(nonce) {
  const key = String(nonce || '').trim();
  if (!key) return false;
  let consumed = false;
  mutateDurableNamespace(NAMESPACE, emptyState(), current => {
    const state = prune(normalizeState(current));
    const record = state.authorizationCodes[key];
    if (!record || Date.parse(record.expiresAt || '') <= Date.now()) return state;
    delete state.authorizationCodes[key];
    consumed = true;
    return state;
  });
  return consumed;
}

export function createRefreshFamily({ subject, authVersion = null, clientId, audience, scope }) {
  const id = crypto.randomBytes(18).toString('base64url');
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + FAMILY_TTL_MS).toISOString();
  mutateDurableNamespace(NAMESPACE, emptyState(), current => {
    const state = prune(normalizeState(current));
    if (Object.keys(state.families).length >= MAX_FAMILIES) throw new Error('OAuth refresh-family capacity reached');
    state.families[id] = {
      id,
      subject: requireText(subject, 'OAuth subject'),
      authVersion: authVersion == null ? null : Number(authVersion),
      clientId: requireText(clientId, 'OAuth client ID'),
      audience: requireText(audience, 'OAuth audience'),
      scope: requireText(scope, 'OAuth scope'),
      generation: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt,
      revokedAt: null,
      revokeReason: null
    };
    return state;
  });
  return { id, generation: 1, expiresAt };
}

function familyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function consumeRefreshFamily({ familyId, generation, subject, authVersion = null, clientId, audience, scope }) {
  let result = null;
  let failure = null;
  mutateDurableNamespace(NAMESPACE, emptyState(), current => {
    const state = prune(normalizeState(current));
    const family = state.families[String(familyId || '')];
    if (!family || family.revokedAt) {
      failure = familyError('oauth_refresh_invalid', 'OAuth refresh-token family is not active');
      return state;
    }
    if (Date.parse(family.expiresAt || '') <= Date.now()) {
      family.revokedAt = nowIso();
      family.revokeReason = 'expired';
      family.updatedAt = family.revokedAt;
      failure = familyError('oauth_refresh_invalid', 'OAuth refresh-token family has expired');
      return state;
    }
    const matches =
      family.subject === String(subject || '') &&
      Number(family.authVersion ?? 0) === Number(authVersion ?? 0) &&
      family.clientId === String(clientId || '') &&
      family.audience === String(audience || '') &&
      family.scope === String(scope || '');
    if (!matches) {
      family.revokedAt = nowIso();
      family.revokeReason = 'binding_mismatch';
      family.updatedAt = family.revokedAt;
      failure = familyError('oauth_refresh_invalid', 'OAuth refresh-token binding is invalid');
      return state;
    }
    if (Number(generation) !== Number(family.generation)) {
      family.revokedAt = nowIso();
      family.revokeReason = 'reuse_detected';
      family.updatedAt = family.revokedAt;
      failure = familyError('oauth_refresh_reuse', 'OAuth refresh-token reuse detected; the token family was revoked');
      return state;
    }
    family.generation += 1;
    family.updatedAt = nowIso();
    result = { id: family.id, generation: family.generation, expiresAt: family.expiresAt };
    return state;
  });
  if (failure) throw failure;
  return result;
}

export function revokeRefreshFamily(familyId, reason = 'revoked') {
  let revoked = false;
  mutateDurableNamespace(NAMESPACE, emptyState(), current => {
    const state = prune(normalizeState(current));
    const family = state.families[String(familyId || '')];
    if (!family || family.revokedAt) return state;
    family.revokedAt = nowIso();
    family.revokeReason = String(reason || 'revoked').slice(0, 100);
    family.updatedAt = family.revokedAt;
    revoked = true;
    return state;
  });
  return revoked;
}

export function oauthRuntimeStateStatus() {
  const state = prune(normalizeState(readDurableNamespace(NAMESPACE, emptyState())));
  const families = Object.values(state.families);
  return {
    pendingAuthorizationCodes: Object.keys(state.authorizationCodes).length,
    activeRefreshFamilies: families.filter(item => !item.revokedAt && Date.parse(item.expiresAt || '') > Date.now()).length,
    revokedRefreshFamilies: families.filter(item => !!item.revokedAt).length
  };
}
