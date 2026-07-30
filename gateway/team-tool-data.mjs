import { readConfig } from './local-shared.mjs';
import { requestContext, requestPrincipal } from './request-context.mjs';
import { activitySnapshot } from './request-guard.mjs';
import { fallbackLocalPrincipal, normalizeDeploymentConfig } from './team-access.mjs';
import { approvalPolicy } from './approvals.mjs';
import { durableStateStatus } from './durable-state.mjs';
import { listRunners } from './job-queue.mjs';
import { normalizeRunnerControlConfig } from './runner-access.mjs';
import { listWorkspaceLeases } from './workspace-leases.mjs';

export function principalNow() {
  return requestPrincipal() || fallbackLocalPrincipal();
}

export function cleanOrigin(value, required = false) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw new Error('A stable public HTTPS URL is required');
    return '';
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new Error('publicUrl must be a clean HTTPS origin');
  }
  return `https://${url.host}`;
}

export function workspaceIds(config, values = []) {
  const map = new Map();
  for (const item of config.workspaces || []) {
    map.set(item.id, item.id);
    map.set(item.name, item.id);
  }
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    .map(value => {
      const id = map.get(value);
      if (!id) throw new Error(`Workspace not found for member scope: ${value}`);
      return id;
    });
}

function runnerSummary(config) {
  normalizeRunnerControlConfig(config);
  const credentials = config.runnerControl.credentials || [];
  const activeCredentials = credentials.filter(item =>
    !item.disabled &&
    !!item.salt &&
    !!item.tokenHash &&
    Array.isArray(item.workspaceIds) &&
    item.workspaceIds.length > 0 &&
    (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const runners = listRunners();
  const external = runners.filter(item =>
    item.labels?.kind === 'external' || item.capabilities?.includes('external')
  );
  const onlineExternal = external.filter(item => item.status === 'online');
  return {
    embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled !== false,
    externalControlEnabled: config.runnerControl.enabled,
    credentialCount: credentials.length,
    activeCredentialCount: activeCredentials.length,
    knownExternalRunners: external.length,
    onlineExternalRunners: onlineExternal.length
  };
}

export function publicDeployment(config = readConfig()) {
  normalizeDeploymentConfig(config);
  normalizeRunnerControlConfig(config);
  const context = requestContext();
  return {
    mode: config.deployment.mode,
    tunnelProvider: config.deployment.tunnelProvider,
    publicUrl: config.deployment.publicUrl || null,
    teamEnabled: config.team.enabled,
    requireWorkspaceLeaseForWrites: config.team.requireWorkspaceLeaseForWrites,
    approvalPolicy: approvalPolicy(config),
    memberCount: config.team.members.length,
    runners: runnerSummary(config),
    production: {
      maxRequestBytes: config.production.maxRequestBytes,
      requestsPerMinute: config.production.requestsPerMinute,
      maxConcurrentRequests: config.production.maxConcurrentRequests,
      maxConcurrentPerPrincipal: config.production.maxConcurrentPerPrincipal,
      requestTimeoutMs: config.production.requestTimeoutMs,
      allowedHosts: config.production.allowedHosts
    },
    principal: principalNow(),
    request: context ? {
      requestId: context.requestId,
      remoteAddress: context.remoteAddress,
      userAgent: context.userAgent,
      startedAt: context.startedAt
    } : null
  };
}

export function readiness(config = readConfig()) {
  normalizeDeploymentConfig(config);
  normalizeRunnerControlConfig(config);
  const checks = [];
  const add = (key, ok, detail) => checks.push({ key, ok: !!ok, detail });
  const activeMembers = config.team.members.filter(member =>
    !member.disabled && (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
  );
  const approvals = approvalPolicy(config);
  const durable = durableStateStatus();
  const runners = runnerSummary(config);

  add(
    'owner-token',
    !!config.auth?.token || config.auth?.required === false,
    config.auth?.token ? 'configured' : 'missing'
  );
  add(
    'public-url',
    config.deployment.mode === 'personal' || !!config.deployment.publicUrl,
    config.deployment.publicUrl || 'not configured'
  );
  add(
    'tunnel-provider',
    !!config.deployment.tunnelProvider &&
      !(config.deployment.mode === 'production' && config.deployment.tunnelProvider === 'cloudflare-quick'),
    config.deployment.tunnelProvider || 'missing'
  );
  add(
    'team-members',
    !config.team.enabled || activeMembers.length > 0,
    `${activeMembers.length} active member(s)`
  );
  add(
    'allowed-hosts',
    config.deployment.mode !== 'production' || config.production.allowedHosts.length > 0,
    config.production.allowedHosts.join(', ') || 'not restricted'
  );
  add(
    'auth-required',
    config.deployment.mode !== 'production' || config.auth?.required !== false,
    config.auth?.required === false ? 'disabled' : 'required'
  );
  add(
    'lease-policy',
    !config.team.enabled || config.team.requireWorkspaceLeaseForWrites,
    config.team.requireWorkspaceLeaseForWrites ? 'enabled' : 'disabled'
  );
  add(
    'approval-policy',
    config.deployment.mode !== 'production' || approvals.enabled,
    approvals.enabled
      ? `enabled for ${approvals.requiredCapabilities.join(', ') || approvals.requiredTools.length + ' tool(s)'}`
      : 'disabled'
  );
  add(
    'durable-state',
    config.deployment.mode === 'personal' || durable.enabled,
    durable.path || 'in-memory only'
  );
  add(
    'runner-execution',
    runners.embeddedRunnerEnabled || runners.externalControlEnabled,
    runners.embeddedRunnerEnabled
      ? 'embedded Runner enabled'
      : runners.externalControlEnabled
        ? 'external control enabled'
        : 'no Runner execution path enabled'
  );
  add(
    'runner-credentials',
    !runners.externalControlEnabled || runners.activeCredentialCount > 0,
    runners.externalControlEnabled
      ? `${runners.activeCredentialCount} active external Runner credential(s)`
      : 'external control disabled'
  );
  add(
    'external-runners-online',
    runners.embeddedRunnerEnabled || runners.onlineExternalRunners > 0,
    runners.embeddedRunnerEnabled
      ? 'not required while embedded Runner is enabled'
      : `${runners.onlineExternalRunners} online external Runner(s)`
  );
  add(
    'audit-retention',
    Number(config.maintenance?.auditRetentionDays || 0) >= 30,
    `${config.maintenance?.auditRetentionDays || 0} day(s)`
  );

  return { ready: checks.every(item => item.ok), checks };
}

export function policyTemplate(provider = 'ngrok') {
  if (provider === 'cloudflare-managed') {
    return {
      provider,
      tunnelCommand: 'cloudflared tunnel run',
      tokenEnvironment: 'TUNNEL_TOKEN',
      accessHeaders: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'],
      note: 'Keep DevMate team and Runner tokens as the application authorization layer.'
    };
  }
  return {
    provider: 'ngrok',
    format: 'yaml',
    fileName: 'devmate-traffic-policy.yml',
    content: [
      'on_http_request:',
      '  - expressions:',
      "      - req.url.path.startsWith('/mcp') || req.url.path.startsWith('/runner/v1')",
      '    actions:',
      '      - type: add-headers',
      '        config:',
      '          headers:',
      '            x-devmate-edge: ngrok',
      '      - type: rate-limit',
      '        config:',
      '          name: devmate-api',
      '          algorithm: sliding_window',
      '          capacity: 120',
      '          rate: 60s',
      ''
    ].join('\n'),
    note: 'Keep DevMate application authentication enabled even when edge identity is configured.'
  };
}

export function teamStatus(config = readConfig()) {
  normalizeDeploymentConfig(config);
  normalizeRunnerControlConfig(config);
  const principal = principalNow();
  let leases = listWorkspaceLeases();
  if (principal.workspaceIds?.length) {
    leases = leases.filter(item => principal.workspaceIds.includes(item.workspaceId));
  }
  const activeMembers = config.team.members.filter(member =>
    !member.disabled && (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
  );
  return {
    enabled: config.team.enabled,
    mode: config.deployment.mode,
    currentPrincipal: principal,
    activeMembers: activeMembers.length,
    totalMembers: config.team.members.length,
    requireWorkspaceLeaseForWrites: config.team.requireWorkspaceLeaseForWrites,
    approvalPolicy: approvalPolicy(config),
    durableState: durableStateStatus(),
    runners: runnerSummary(config),
    activeLeases: leases,
    recentSessions: activitySnapshot({ activeWithinMinutes: 60 }).length,
    readiness: readiness(config)
  };
}

export const __test = { runnerSummary };
