import { readConfig } from './local-shared.mjs';
import { requestContext, requestPrincipal } from './request-context.mjs';
import { activitySnapshot } from './request-guard.mjs';
import { fallbackLocalPrincipal, normalizeDeploymentConfig } from './team-access.mjs';
import { approvalPolicy } from './approvals.mjs';
import { durableStateStatus } from './durable-state.mjs';
import { listRunners } from './job-queue.mjs';
import { jobRuntimeStatus } from './job-runtime.mjs';
import { effectivePublicIngress, runtimePublicIngress } from './public-ingress-state.mjs';
import { normalizeRunnerControlConfig } from './runner-access.mjs';
import { listWorkspaceLeases } from './workspace-leases.mjs';
import { resolveWorkspaceId } from './workspace-resolver.mjs';

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
  return [...new Set(
    values
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .map(value => resolveWorkspaceId(config, value))
  )];
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
  const runtime = jobRuntimeStatus();
  return {
    embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled !== false,
    embeddedRunnerRunning: runtime.started && !runtime.stopping,
    externalControlEnabled: config.runnerControl.enabled,
    credentialCount: credentials.length,
    activeCredentialCount: activeCredentials.length,
    knownExternalRunners: external.length,
    onlineExternalRunners: onlineExternal.length
  };
}

function allowedPublicHost(config, ingress = effectivePublicIngress(config)) {
  const mode = config.deployment.mode;
  if (mode === 'personal') return true;
  const allowed = new Set((config.production.allowedHosts || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  if (!allowed.size) return mode !== 'production';
  if (!ingress?.publicUrl) return false;
  try {
    const url = new URL(ingress.publicUrl);
    return allowed.has(url.host.toLowerCase()) || allowed.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function publicDeployment(config = readConfig()) {
  normalizeDeploymentConfig(config);
  normalizeRunnerControlConfig(config);
  const context = requestContext();
  const runtimeIngress = runtimePublicIngress(config);
  const effectiveIngress = effectivePublicIngress(config);
  return {
    mode: config.deployment.mode,
    tunnelProvider: config.deployment.tunnelProvider,
    publicUrl: config.deployment.publicUrl || null,
    effectivePublicUrl: effectiveIngress.publicUrl || null,
    publicIngress: {
      source: effectiveIngress.source,
      provider: effectiveIngress.provider || null,
      verifiedRuntime: effectiveIngress.source === 'runtime' && effectiveIngress.verified,
      runtime: runtimeIngress
    },
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
  const sharedDeployment = config.deployment.mode !== 'personal';
  const publicIngress = effectivePublicIngress(config);
  const publicHostAllowed = allowedPublicHost(config, publicIngress);
  const hostPolicyActive = config.deployment.mode === 'production' || config.production.allowedHosts.length > 0;
  const publicIngressRequired = config.deployment.mode !== 'personal';

  add(
    'owner-token',
    !!config.auth?.token || config.auth?.required === false,
    config.auth?.token ? 'configured' : 'missing'
  );
  add(
    'public-url',
    !publicIngressRequired || publicIngress.available,
    !publicIngressRequired
      ? 'not required in personal mode'
      : publicIngress.available
        ? `${publicIngress.source}: ${publicIngress.publicUrl}`
        : publicIngress.reason || 'no effective public ingress'
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
    !hostPolicyActive || publicHostAllowed,
    !hostPolicyActive
      ? 'not restricted'
      : publicHostAllowed
        ? config.production.allowedHosts.join(', ')
        : `effective public URL host is not allowed by: ${config.production.allowedHosts.join(', ') || 'no configured hosts'}`
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
    !sharedDeployment || (durable.enabled && !durable.recovery),
    durable.recovery
      ? `recovery warning: ${durable.recovery.error || 'state recovery occurred'}`
      : durable.path || 'in-memory only'
  );
  add(
    'instance-lock',
    !sharedDeployment || !!durable.instanceLock,
    durable.instanceLock
      ? `held by pid ${durable.instanceLock.pid}`
      : sharedDeployment ? 'no active Gateway instance lock' : 'not required'
  );
  add(
    'runner-execution',
    runners.embeddedRunnerRunning || runners.externalControlEnabled,
    runners.embeddedRunnerRunning
      ? 'embedded Runner running'
      : runners.embeddedRunnerEnabled
        ? 'embedded Runner configured but not running; restart the Gateway'
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
    runners.embeddedRunnerRunning || runners.onlineExternalRunners > 0,
    runners.embeddedRunnerRunning
      ? 'not required while embedded Runner is running'
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

export const __test = { allowedPublicHost, runnerSummary };
