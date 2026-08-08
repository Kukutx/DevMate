'use strict';

const CONNECTION_PROVIDERS = Object.freeze(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
const TEAM_ROLES = Object.freeze(['observer', 'reviewer', 'developer', 'maintainer', 'owner']);

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
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new TypeError('connection.publicUrl must be a string');
  return value.trim();
}

function legacyConnection(config) {
  const deployment = object(config.deployment, 'deployment');
  return {
    provider: deployment.tunnelProvider,
    publicUrl: deployment.publicUrl
  };
}

function legacyRequestPolicy(config) {
  return object(config.production, 'production');
}

function normalizeInstanceConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');

  const previousConnection = object(config.connection, 'connection');
  const oldConnection = legacyConnection(config);
  config.connection = {
    ...previousConnection,
    provider: strictEnum(
      previousConnection.provider === undefined ? oldConnection.provider : previousConnection.provider,
      CONNECTION_PROVIDERS,
      'ngrok',
      'connection provider'
    ),
    publicUrl: cleanPublicUrl(
      previousConnection.publicUrl === undefined ? oldConnection.publicUrl : previousConnection.publicUrl
    )
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
  delete team.enabled;
  config.team = team;

  const oldPolicy = legacyRequestPolicy(config);
  const policy = object(config.requestPolicy, 'requestPolicy');
  config.requestPolicy = {
    maxRequestBytes: strictInteger(
      policy.maxRequestBytes === undefined ? oldPolicy.maxRequestBytes : policy.maxRequestBytes,
      DEFAULT_REQUEST_POLICY.maxRequestBytes,
      64 * 1024,
      32 * 1024 * 1024,
      'requestPolicy.maxRequestBytes'
    ),
    requestsPerMinute: strictInteger(
      policy.requestsPerMinute === undefined ? oldPolicy.requestsPerMinute : policy.requestsPerMinute,
      DEFAULT_REQUEST_POLICY.requestsPerMinute,
      10,
      10000,
      'requestPolicy.requestsPerMinute'
    ),
    maxConcurrentRequests: strictInteger(
      policy.maxConcurrentRequests === undefined ? oldPolicy.maxConcurrentRequests : policy.maxConcurrentRequests,
      DEFAULT_REQUEST_POLICY.maxConcurrentRequests,
      1,
      256,
      'requestPolicy.maxConcurrentRequests'
    ),
    maxConcurrentPerPrincipal: strictInteger(
      policy.maxConcurrentPerPrincipal === undefined ? oldPolicy.maxConcurrentPerPrincipal : policy.maxConcurrentPerPrincipal,
      DEFAULT_REQUEST_POLICY.maxConcurrentPerPrincipal,
      1,
      64,
      'requestPolicy.maxConcurrentPerPrincipal'
    ),
    requestTimeoutMs: strictInteger(
      policy.requestTimeoutMs === undefined ? oldPolicy.requestTimeoutMs : policy.requestTimeoutMs,
      DEFAULT_REQUEST_POLICY.requestTimeoutMs,
      1000,
      60 * 60 * 1000,
      'requestPolicy.requestTimeoutMs'
    ),
    allowedHosts: stringList(
      policy.allowedHosts === undefined ? oldPolicy.allowedHosts : policy.allowedHosts,
      DEFAULT_REQUEST_POLICY.allowedHosts,
      'requestPolicy.allowedHosts'
    ).map(value => value.toLowerCase())
  };

  const runtime = object(config.runtime, 'runtime');
  runtime.maxConcurrentJobs = strictInteger(runtime.maxConcurrentJobs, 2, 1, 8, 'runtime.maxConcurrentJobs');
  config.runtime = runtime;

  const jobs = object(config.jobs, 'jobs');
  jobs.allowJobGitSave = strictBoolean(jobs.allowJobGitSave, true, 'jobs.allowJobGitSave');
  jobs.embeddedRunnerEnabled = strictBoolean(jobs.embeddedRunnerEnabled, true, 'jobs.embeddedRunnerEnabled');
  config.jobs = jobs;

  delete config.deployment;
  delete config.production;
  return config;
}

function connectionState(config) {
  const normalized = normalizeInstanceConfig(config);
  return {
    provider: normalized.connection.provider,
    publicUrl: normalized.connection.publicUrl
  };
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
  TEAM_ROLES,
  accessState,
  connectionState,
  normalizeInstanceConfig,
  strictBoolean,
  strictEnum,
  strictInteger,
  stringList
};