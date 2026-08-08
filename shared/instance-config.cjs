'use strict';

const CONNECTION_PROVIDERS = Object.freeze(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
const TEAM_ROLES = Object.freeze(['observer', 'reviewer', 'developer', 'maintainer', 'owner']);
const LIFECYCLE_STATES = Object.freeze(['running', 'stopped']);

const REQUEST_POLICY_LIMITS = Object.freeze({
  maxRequestBytes: Object.freeze([64 * 1024, 32 * 1024 * 1024]),
  requestsPerMinute: Object.freeze([10, 10000]),
  maxConcurrentRequests: Object.freeze([1, 256]),
  maxConcurrentPerPrincipal: Object.freeze([1, 64]),
  requestTimeoutMs: Object.freeze([1000, 60 * 60 * 1000])
});

const DEFAULT_REQUEST_POLICY = Object.freeze({
  maxRequestBytes: 2 * 1024 * 1024,
  requestsPerMinute: 600,
  maxConcurrentRequests: 64,
  maxConcurrentPerPrincipal: 16,
  requestTimeoutMs: 15 * 60 * 1000,
  allowedHosts: Object.freeze([])
});

function object(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function strictBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function strictInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function strictEnum(value, allowed, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'string' || !allowed.includes(candidate)) {
    throw new Error(`Unknown ${label}: ${String(candidate)}`);
  }
  return candidate;
}

function stringList(value, fallback, label) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source)) throw new TypeError(`${label} must be an array`);
  return [...new Set(source.map(item => {
    if (typeof item !== 'string') throw new TypeError(`${label} must contain only strings`);
    return item.trim();
  }).filter(Boolean))];
}

function cleanPublicUrl(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new TypeError('connection.publicUrl must be a string');
  return value.trim();
}

function retiredShapePresent(config) {
  return Object.hasOwn(config, 'deployment')
    || Object.hasOwn(config, 'production')
    || Object.hasOwn(object(config.team, 'team'), 'enabled');
}

function upgradeLegacyInstanceShape(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  if (!retiredShapePresent(config)) return config;

  const deployment = object(config.deployment, 'deployment');
  const production = object(config.production, 'production');
  const connection = object(config.connection, 'connection');
  const requestPolicy = object(config.requestPolicy, 'requestPolicy');
  const team = object(config.team, 'team');

  config.connection = {
    ...connection,
    provider: connection.provider === undefined ? deployment.tunnelProvider : connection.provider,
    publicUrl: connection.publicUrl === undefined ? deployment.publicUrl : connection.publicUrl
  };

  config.requestPolicy = {
    ...requestPolicy,
    maxRequestBytes: requestPolicy.maxRequestBytes === undefined ? production.maxRequestBytes : requestPolicy.maxRequestBytes,
    requestsPerMinute: requestPolicy.requestsPerMinute === undefined ? production.requestsPerMinute : requestPolicy.requestsPerMinute,
    maxConcurrentRequests: requestPolicy.maxConcurrentRequests === undefined ? production.maxConcurrentRequests : requestPolicy.maxConcurrentRequests,
    maxConcurrentPerPrincipal: requestPolicy.maxConcurrentPerPrincipal === undefined ? production.maxConcurrentPerPrincipal : requestPolicy.maxConcurrentPerPrincipal,
    requestTimeoutMs: requestPolicy.requestTimeoutMs === undefined ? production.requestTimeoutMs : requestPolicy.requestTimeoutMs,
    allowedHosts: requestPolicy.allowedHosts === undefined ? production.allowedHosts : requestPolicy.allowedHosts
  };

  delete team.enabled;
  config.team = team;
  delete config.deployment;
  delete config.production;
  return config;
}

function assertCurrentInstanceShape(config) {
  if (retiredShapePresent(config)) {
    const error = new Error('Retired deployment-mode fields must be upgraded before runtime normalization');
    error.code = 'retired_instance_shape';
    throw error;
  }
  return config;
}

function normalizeLifecycle(config) {
  const lifecycle = object(config.lifecycle, 'lifecycle');
  lifecycle.desiredState = strictEnum(lifecycle.desiredState, LIFECYCLE_STATES, 'stopped', 'lifecycle state');
  lifecycle.generation = strictInteger(lifecycle.generation, 0, 0, Number.MAX_SAFE_INTEGER, 'lifecycle.generation');
  lifecycle.updatedAt = lifecycle.updatedAt == null ? null : String(lifecycle.updatedAt);
  lifecycle.requestedBy = lifecycle.requestedBy == null ? null : String(lifecycle.requestedBy).slice(0, 256);
  lifecycle.reason = lifecycle.reason == null ? '' : String(lifecycle.reason).slice(0, 500);
  config.lifecycle = lifecycle;
  return lifecycle;
}

function normalizeInstanceConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  assertCurrentInstanceShape(config);
  normalizeLifecycle(config);

  const previousConnection = object(config.connection, 'connection');
  config.connection = {
    ...previousConnection,
    provider: strictEnum(previousConnection.provider, CONNECTION_PROVIDERS, 'ngrok', 'connection provider'),
    publicUrl: cleanPublicUrl(previousConnection.publicUrl)
  };

  const team = object(config.team, 'team');
  team.members = Array.isArray(team.members) ? team.members : [];
  team.requireWorkspaceLeaseForWrites = strictBoolean(
    team.requireWorkspaceLeaseForWrites,
    false,
    'team.requireWorkspaceLeaseForWrites'
  );
  team.defaultMemberRole = strictEnum(team.defaultMemberRole, TEAM_ROLES, 'developer', 'team role');
  team.maxMembers = strictInteger(team.maxMembers, 100, 1, 500, 'team.maxMembers');
  config.team = team;

  const policy = object(config.requestPolicy, 'requestPolicy');
  config.requestPolicy = {
    maxRequestBytes: strictInteger(policy.maxRequestBytes, DEFAULT_REQUEST_POLICY.maxRequestBytes, ...REQUEST_POLICY_LIMITS.maxRequestBytes, 'requestPolicy.maxRequestBytes'),
    requestsPerMinute: strictInteger(policy.requestsPerMinute, DEFAULT_REQUEST_POLICY.requestsPerMinute, ...REQUEST_POLICY_LIMITS.requestsPerMinute, 'requestPolicy.requestsPerMinute'),
    maxConcurrentRequests: strictInteger(policy.maxConcurrentRequests, DEFAULT_REQUEST_POLICY.maxConcurrentRequests, ...REQUEST_POLICY_LIMITS.maxConcurrentRequests, 'requestPolicy.maxConcurrentRequests'),
    maxConcurrentPerPrincipal: strictInteger(policy.maxConcurrentPerPrincipal, DEFAULT_REQUEST_POLICY.maxConcurrentPerPrincipal, ...REQUEST_POLICY_LIMITS.maxConcurrentPerPrincipal, 'requestPolicy.maxConcurrentPerPrincipal'),
    requestTimeoutMs: strictInteger(policy.requestTimeoutMs, DEFAULT_REQUEST_POLICY.requestTimeoutMs, ...REQUEST_POLICY_LIMITS.requestTimeoutMs, 'requestPolicy.requestTimeoutMs'),
    allowedHosts: stringList(policy.allowedHosts, DEFAULT_REQUEST_POLICY.allowedHosts, 'requestPolicy.allowedHosts').map(value => value.toLowerCase())
  };

  const runtime = object(config.runtime, 'runtime');
  runtime.maxConcurrentJobs = strictInteger(runtime.maxConcurrentJobs, 2, 1, 8, 'runtime.maxConcurrentJobs');
  config.runtime = runtime;

  const jobs = object(config.jobs, 'jobs');
  jobs.allowJobGitSave = strictBoolean(jobs.allowJobGitSave, true, 'jobs.allowJobGitSave');
  jobs.embeddedRunnerEnabled = strictBoolean(jobs.embeddedRunnerEnabled, true, 'jobs.embeddedRunnerEnabled');
  config.jobs = jobs;
  return config;
}

function connectionState(config) {
  const normalized = normalizeInstanceConfig(config);
  return { provider: normalized.connection.provider, publicUrl: normalized.connection.publicUrl };
}

function accessState(config) {
  const normalized = normalizeInstanceConfig(config);
  return {
    memberCount: normalized.team.members.length,
    requireWorkspaceLeaseForWrites: normalized.team.requireWorkspaceLeaseForWrites,
    defaultMemberRole: normalized.team.defaultMemberRole,
    maxMembers: normalized.team.maxMembers
  };
}

module.exports = {
  CONNECTION_PROVIDERS,
  DEFAULT_REQUEST_POLICY,
  LIFECYCLE_STATES,
  REQUEST_POLICY_LIMITS,
  TEAM_ROLES,
  accessState,
  assertCurrentInstanceShape,
  connectionState,
  normalizeInstanceConfig,
  normalizeLifecycle,
  retiredShapePresent,
  strictBoolean,
  strictEnum,
  strictInteger,
  stringList,
  upgradeLegacyInstanceShape
};
