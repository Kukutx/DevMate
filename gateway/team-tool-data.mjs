import { readConfig } from './local-shared.mjs';
import { requestContext, requestPrincipal } from './request-context.mjs';
import { activitySnapshot } from './request-guard.mjs';
import { fallbackLocalPrincipal, normalizeInstanceConfig } from './team-access.mjs';
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
    embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled === true,
    embeddedRunnerRunning: runtime.started && !runtime.stopping,
    externalControlEnabled: config.runnerControl.enabled,
    credentialCount: credentials.length,
    activeCredentialCount: activeCredentials.length,
    knownExternalRunners: external.length,
    onlineExternalRunners: onlineExternal.length
  };
}

function allowedPublicHost(config, ingress = effectivePublicIngress(config)) {
  const allowed = new Set((config.requestPolicy.allowedHosts || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  if (!allowed.size) return true;
  if (!ingress?.publicUrl) return false;
  try {
    const url = new URL(ingress.publicUrl);
    return allowed.has(url.host.toLowerCase()) || allowed.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function publicDeployment(config = readConfig()) {
  normalizeInstanceConfig(config);
  normalizeRunnerControlConfig(config);
  const context = requestContext();
  const runtimeIngress = runtimePublicIngress(config);
  const effectiveIngress = effectivePublicIngress(config);
  return {
    connection: {
      provider: config.connection.provider,
      publicUrl: config.connection.publicUrl || null,
      effectivePublicUrl: effectiveIngress.publicUrl || null,
      source: effectiveIngress.source,
      verifiedRuntime: effectiveIngress.source === 'runtime' && effectiveIngress.verified,
      runtime: runtimeIngress
    },
    access: {
      memberCount: config.team.members.length,
      requireWorkspaceLeaseForWrites: config.team.requireWorkspaceLeaseForWrites,
      approvalPolicy: approvalPolicy(config)
    },
    runners: runnerSummary(config),
    requestPolicy: { ...config.requestPolicy },
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
  normalizeInstanceConfig(config);
  normalizeRunnerControlConfig(config);
  const checks = [];
  const add = (key, ok, detail, { required = true } = {}) => checks.push({ key, ok: !!ok, required, detail });
  const activeMembers = config.team.members.filter(member =>
    !member.disabled && (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
  );
  const approvals = approvalPolicy(config);
  const durable = durableStateStatus();
  const runners = runnerSummary(config);
  const publicIngress = effectivePublicIngress(config);
  const publicHostAllowed = allowedPublicHost(config, publicIngress);
  const hostPolicyActive = config.requestPolicy.allowedHosts.length > 0;
  const membersConfigured = config.team.members.length > 0;
  const leasesConfigured = config.team.requireWorkspaceLeaseForWrites;
  const externalRunnersConfigured = config.runnerControl.enabled;
  const runnerExecutionConfigured = runners.embeddedRunnerEnabled || externalRunnersConfigured;

  add(
    'mcp-authentication',
    config.auth?.mode === 'none' || config.auth?.mode === 'oauth',
    config.auth?.mode === 'oauth' ? 'OAuth' : 'none'
  );
  add(
    'public-connection',
    publicIngress.available,
    publicIngress.available
      ? `${publicIngress.provider || config.connection.provider}: ${publicIngress.publicUrl}`
      : publicIngress.reason || 'no verified/effective public HTTPS connection'
  );
  add(
    'connection-provider',
    !!config.connection.provider,
    config.connection.provider || 'missing'
  );
  add(
    'stable-public-url',
    config.connection.provider === 'cloudflare-quick' || !!config.connection.publicUrl || publicIngress.available,
    config.connection.provider === 'cloudflare-quick'
      ? 'temporary provider; stable URL is not expected'
      : config.connection.publicUrl || publicIngress.publicUrl || 'provider has not published a stable URL',
    { required: false }
  );
  add(
    'members',
    !membersConfigured || activeMembers.length > 0,
    membersConfigured ? `${activeMembers.length}/${config.team.members.length} active member(s)` : 'owner-only access',
    { required: membersConfigured }
  );
  add(
    'allowed-hosts',
    !hostPolicyActive || publicHostAllowed,
    !hostPolicyActive
      ? 'not restricted'
      : publicHostAllowed
        ? config.requestPolicy.allowedHosts.join(', ')
        : `effective public URL host is not allowed by: ${config.requestPolicy.allowedHosts.join(', ')}`,
    { required: hostPolicyActive }
  );
  add(
    'lease-policy',
    !leasesConfigured || membersConfigured,
    leasesConfigured
      ? membersConfigured ? 'enabled for non-owner write operations' : 'enabled but no members are configured'
      : 'disabled',
    { required: leasesConfigured }
  );
  add(
    'approval-policy',
    !approvals.enabled || membersConfigured,
    approvals.enabled
      ? `enabled for ${approvals.requiredCapabilities.join(', ') || approvals.requiredTools.length + ' tool(s)'}`
      : 'disabled',
    { required: approvals.enabled }
  );
  add(
    'durable-state',
    durable.enabled && !durable.recovery,
    durable.recovery
      ? `recovery warning: ${durable.recovery.error || 'state recovery occurred'}`
      : durable.path || 'durable state unavailable'
  );
  add(
    'runner-execution',
    !runnerExecutionConfigured || runners.embeddedRunnerRunning || externalRunnersConfigured,
    runners.embeddedRunnerRunning
      ? 'embedded Runner running'
      : runners.embeddedRunnerEnabled
        ? 'embedded Runner configured but not running; Gateway may be offline'
        : externalRunnersConfigured
          ? 'external Runner control enabled'
          : 'background Runner execution not configured',
    { required: runnerExecutionConfigured }
  );
  add(
    'runner-credentials',
    !externalRunnersConfigured || runners.activeCredentialCount > 0,
    externalRunnersConfigured
      ? `${runners.activeCredentialCount} active external Runner credential(s)`
      : 'external Runner control disabled',
    { required: externalRunnersConfigured }
  );
  add(
    'external-runners-online',
    !externalRunnersConfigured || runners.onlineExternalRunners > 0 || runners.embeddedRunnerRunning,
    externalRunnersConfigured
      ? `${runners.onlineExternalRunners} online external Runner(s)`
      : 'not configured',
    { required: externalRunnersConfigured && !runners.embeddedRunnerRunning }
  );
  add(
    'audit-retention',
    Number(config.maintenance?.auditRetentionDays || 0) >= 30,
    `${config.maintenance?.auditRetentionDays || 0} day(s)`
  );

  return {
    ready: checks.filter(item => item.required).every(item => item.ok),
    checks
  };
}

export function policyTemplate(provider = 'ngrok') {
  if (provider === 'cloudflare-managed') {
    return {
      provider,
      tunnelCommand: 'cloudflared tunnel run',
      tokenEnvironment: 'TUNNEL_TOKEN',
      accessHeaders: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'],
      note: 'Keep DevMate member and Runner tokens as the application authorization layer.'
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
  normalizeInstanceConfig(config);
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
    currentPrincipal: principal,
    ownerOnly: config.team.members.length === 0,
    activeMembers: activeMembers.length,
    totalMembers: config.team.members.length,
    requireWorkspaceLeaseForWrites: config.team.requireWorkspaceLeaseForWrites,
    approvalPolicy: approvalPolicy(config),
    durableState: durableStateStatus(),
    connection: {
      provider: config.connection.provider,
      publicUrl: config.connection.publicUrl || null
    },
    requestPolicy: { ...config.requestPolicy },
    runners: runnerSummary(config),
    activeLeases: leases,
    recentSessions: activitySnapshot({ activeWithinMinutes: 60 }).length,
    readiness: readiness(config)
  };
}

export const __test = { allowedPublicHost, runnerSummary };
