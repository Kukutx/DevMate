'use strict';

const {
  AUTH_POLICY_GENERATION_KEY,
  authenticationMode,
  authenticationPolicyGeneration
} = require('./auth-config.cjs');
const { connectionPolicySnapshot, LIFECYCLE_STATES } = require('./instance-config.cjs');

function policyInvariantError(message, code, file, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.configFile = file || null;
  Object.assign(error, details);
  return error;
}

function lifecyclePolicySnapshot(config) {
  const lifecycle = config?.lifecycle && typeof config.lifecycle === 'object' && !Array.isArray(config.lifecycle)
    ? config.lifecycle
    : {};
  const desiredState = lifecycle.desiredState === undefined ? 'stopped' : lifecycle.desiredState;
  if (typeof desiredState !== 'string' || !LIFECYCLE_STATES.includes(desiredState)) {
    throw policyInvariantError(
      `Invalid DevMate lifecycle desired state: ${String(desiredState)}`,
      'invalid_lifecycle_desired_state',
      '',
      { desiredState }
    );
  }
  const generation = lifecycle.generation === undefined ? 0 : lifecycle.generation;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw policyInvariantError(
      `Invalid DevMate lifecycle generation: ${String(generation)}`,
      'invalid_lifecycle_generation',
      '',
      { generation }
    );
  }
  return Object.freeze({ desiredState, generation });
}

function policyGenerationBaseline(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const authGeneration = config?.hostRuntime?.[AUTH_POLICY_GENERATION_KEY];
  const connection = config?.connection && typeof config.connection === 'object' && !Array.isArray(config.connection)
    ? config.connection
    : {};
  const lifecycle = config?.lifecycle && typeof config.lifecycle === 'object' && !Array.isArray(config.lifecycle)
    ? config.lifecycle
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
    },
    lifecycle: {
      desiredState: lifecycle.desiredState,
      generation: lifecycle.generation
    }
  };
}

function instanceId(value) {
  return String(value?.instanceId || '').trim();
}

function assertInstanceIdentityPreserved(before, next, file = '') {
  const beforeId = instanceId(before);
  const nextId = instanceId(next);
  if (!beforeId) return { established: !!nextId, instanceId: nextId || null };
  if (nextId !== beforeId) {
    throw policyInvariantError(
      'DevMate instance identity cannot change inside an existing config document',
      'config_instance_identity_change_forbidden',
      file,
      { beforeInstanceId: beforeId, nextInstanceId: nextId || null }
    );
  }
  return { established: true, instanceId: beforeId };
}

function sameInstance(before, next) {
  const beforeId = instanceId(before);
  const nextId = instanceId(next);
  return !!beforeId && beforeId === nextId;
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

function enforceLifecycleGeneration(before, next, file = '') {
  const previous = lifecyclePolicySnapshot(before);
  const current = lifecyclePolicySnapshot(next);
  const changed = previous.desiredState !== current.desiredState;

  if (!changed) {
    if (current.generation !== previous.generation) {
      throw policyInvariantError(
        'Lifecycle generation changed without a committed desired-state change',
        'lifecycle_generation_unjustified',
        file,
        { beforeLifecycle: previous, nextLifecycle: current }
      );
    }
    return { changed: false, generation: previous.generation };
  }

  if (previous.generation >= Number.MAX_SAFE_INTEGER) {
    throw policyInvariantError(
      'Lifecycle generation is exhausted',
      'lifecycle_generation_exhausted',
      file,
      { beforeLifecycle: previous, nextLifecycle: current }
    );
  }
  const expected = previous.generation + 1;
  if (current.generation === previous.generation) {
    next.lifecycle ||= {};
    next.lifecycle.generation = expected;
    return { changed: true, generation: expected, repaired: true };
  }
  if (current.generation !== expected) {
    throw policyInvariantError(
      'Lifecycle generation must advance exactly once for one committed desired-state change',
      'lifecycle_generation_invalid_transition',
      file,
      { beforeLifecycle: previous, nextLifecycle: current, expectedGeneration: expected }
    );
  }
  return { changed: true, generation: expected, repaired: false };
}

function enforcePolicyGenerations(before, next, file = '') {
  if (!before || !next) {
    return { sameInstance: false, authentication: null, connection: null, lifecycle: null };
  }
  assertInstanceIdentityPreserved(before, next, file);
  if (!sameInstance(before, next)) {
    return { sameInstance: false, authentication: null, connection: null, lifecycle: null };
  }
  return {
    sameInstance: true,
    authentication: enforceAuthenticationGeneration(before, next, file),
    connection: enforceConnectionGeneration(before, next, file),
    lifecycle: enforceLifecycleGeneration(before, next, file)
  };
}

module.exports = {
  assertInstanceIdentityPreserved,
  enforceAuthenticationGeneration,
  enforceConnectionGeneration,
  enforceLifecycleGeneration,
  enforcePolicyGenerations,
  lifecyclePolicySnapshot,
  policyGenerationBaseline,
  policyInvariantError,
  sameInstance
};
