'use strict';

const {
  AUTH_POLICY_GENERATION_KEY,
  authenticationMode,
  authenticationPolicyGeneration
} = require('./auth-config.cjs');
const { connectionPolicySnapshot } = require('./instance-config.cjs');

function policyInvariantError(message, code, file, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.configFile = file || null;
  Object.assign(error, details);
  return error;
}

function policyGenerationBaseline(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const authGeneration = config?.hostRuntime?.[AUTH_POLICY_GENERATION_KEY];
  const connection = config?.connection && typeof config.connection === 'object' && !Array.isArray(config.connection)
    ? config.connection
    : {};
  return {
    instanceId: config.instanceId,
    auth: config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
      ? { mode: config.auth.mode }
      : undefined,
    hostRuntime: authGeneration === undefined
      ? undefined
      : { [AUTH_POLICY_GENERATION_KEY]: authGeneration },
    connection: {
      provider: connection.provider,
      publicUrl: connection.publicUrl,
      policyGeneration: connection.policyGeneration
    }
  };
}

function sameInstance(before, next) {
  const beforeId = String(before?.instanceId || '').trim();
  const nextId = String(next?.instanceId || '').trim();
  return !!beforeId && !!nextId && beforeId === nextId;
}

function enforceAuthenticationGeneration(before, next, file = '') {
  const beforeMode = authenticationMode(before?.auth?.mode);
  const nextMode = authenticationMode(next?.auth?.mode);
  const beforeGeneration = authenticationPolicyGeneration(before);
  const nextGeneration = authenticationPolicyGeneration(next);
  const changed = beforeMode !== nextMode;

  if (!changed) {
    if (nextGeneration !== beforeGeneration) {
      throw policyInvariantError(
        'Authentication policy generation changed without a committed authentication mode change',
        'authentication_policy_generation_unjustified',
        file,
        { beforeMode, nextMode, beforeGeneration, nextGeneration }
      );
    }
    return { changed: false, generation: beforeGeneration };
  }

  if (beforeGeneration >= Number.MAX_SAFE_INTEGER) {
    throw policyInvariantError(
      'Authentication policy generation is exhausted',
      'authentication_policy_generation_exhausted',
      file,
      { beforeMode, nextMode, beforeGeneration }
    );
  }
  const expected = beforeGeneration + 1;
  if (nextGeneration === beforeGeneration) {
    next.hostRuntime ||= {};
    next.hostRuntime[AUTH_POLICY_GENERATION_KEY] = expected;
    return { changed: true, generation: expected, repaired: true };
  }
  if (nextGeneration !== expected) {
    throw policyInvariantError(
      'Authentication policy generation must advance exactly once for one committed mode change',
      'authentication_policy_generation_invalid_transition',
      file,
      { beforeMode, nextMode, beforeGeneration, nextGeneration, expectedGeneration: expected }
    );
  }
  return { changed: true, generation: expected, repaired: false };
}

function enforceConnectionGeneration(before, next, file = '') {
  const previous = connectionPolicySnapshot(before);
  const current = connectionPolicySnapshot(next);
  const changed = previous.provider !== current.provider || previous.publicUrl !== current.publicUrl;

  if (!changed) {
    if (current.generation !== previous.generation) {
      throw policyInvariantError(
        'Connection policy generation changed without a committed provider or public URL change',
        'connection_policy_generation_unjustified',
        file,
        { beforePolicy: previous, nextPolicy: current }
      );
    }
    return { changed: false, generation: previous.generation };
  }

  if (previous.generation >= Number.MAX_SAFE_INTEGER) {
    throw policyInvariantError(
      'Connection policy generation is exhausted',
      'connection_policy_generation_exhausted',
      file,
      { beforePolicy: previous, nextPolicy: current }
    );
  }
  const expected = previous.generation + 1;
  if (current.generation === previous.generation) {
    next.connection ||= {};
    next.connection.policyGeneration = expected;
    return { changed: true, generation: expected, repaired: true };
  }
  if (current.generation !== expected) {
    throw policyInvariantError(
      'Connection policy generation must advance exactly once for one committed provider or public URL change',
      'connection_policy_generation_invalid_transition',
      file,
      { beforePolicy: previous, nextPolicy: current, expectedGeneration: expected }
    );
  }
  return { changed: true, generation: expected, repaired: false };
}

function enforcePolicyGenerations(before, next, file = '') {
  if (!before || !next || !sameInstance(before, next)) {
    return { sameInstance: false, authentication: null, connection: null };
  }
  return {
    sameInstance: true,
    authentication: enforceAuthenticationGeneration(before, next, file),
    connection: enforceConnectionGeneration(before, next, file)
  };
}

module.exports = {
  enforceAuthenticationGeneration,
  enforceConnectionGeneration,
  enforcePolicyGenerations,
  policyGenerationBaseline,
  policyInvariantError,
  sameInstance
};
