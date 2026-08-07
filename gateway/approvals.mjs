import crypto from 'node:crypto';
import { redactSensitiveString } from './local-shared.mjs';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';
import { defaultedArray, defaultedBoolean, defaultedInteger } from './strict-config.mjs';

const NAMESPACE = 'approvals';
const FINAL_STATUSES = new Set(['rejected', 'cancelled', 'consumed', 'expired']);
const APPROVAL_CAPABILITIES = new Set(['read', 'validate', 'write', 'execute', 'git', 'publish', 'admin']);
const APPROVAL_POLICY_KEYS = new Set([
  'enabled',
  'requiredCapabilities',
  'requiredTools',
  'ttlSeconds',
  'separationOfDuties',
  'ownerBypass'
]);

function nowIso() { return new Date().toISOString(); }

function canonical(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readStore() {
  const value = readDurableNamespace(NAMESPACE, { version: 1, requests: [] });
  if (!value || typeof value !== 'object' || !Array.isArray(value.requests)) return { version: 1, requests: [] };
  return { version: 1, requests: value.requests };
}

function writeStore(store) {
  return writeDurableNamespace(NAMESPACE, { version: 1, requests: store.requests });
}

function publicRequest(request) {
  return {
    id: request.id,
    status: request.status,
    tool: request.tool,
    capability: request.capability,
    workspaceId: request.workspaceId || null,
    requestedBy: request.requestedBy,
    requestedByName: request.requestedByName,
    requestedByRole: request.requestedByRole,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    argumentDigest: request.argumentDigest,
    argumentSummary: request.argumentSummary,
    decidedBy: request.decidedBy || null,
    decidedByName: request.decidedByName || null,
    decidedAt: request.decidedAt || null,
    decisionNote: request.decisionNote || '',
    consumedAt: request.consumedAt || null,
    cancelledAt: request.cancelledAt || null
  };
}

function summarize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactSensitiveString(value).slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => summarize(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = /token|secret|password|authorization|api[_-]?key/i.test(key)
        ? 'redacted'
        : summarize(item, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 200);
}

function policyObject(config) {
  const raw = config?.team?.approvals;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('team.approvals must be an object');
  }
  const unknown = Object.keys(raw).filter(key => !APPROVAL_POLICY_KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown team.approvals setting: ${unknown[0]}`);
  return raw;
}

function capabilityList(value, fallback) {
  const items = defaultedArray(value, fallback, 'team.approvals.requiredCapabilities');
  const output = [];
  for (const item of items) {
    if (typeof item !== 'string' || !APPROVAL_CAPABILITIES.has(item)) {
      throw new Error(`Invalid approval capability: ${String(item)}`);
    }
    if (!output.includes(item)) output.push(item);
  }
  return output;
}

function toolList(value) {
  const items = defaultedArray(value, [], 'team.approvals.requiredTools');
  const output = [];
  for (const item of items) {
    if (typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,199}$/.test(item)) {
      throw new Error(`Invalid approval tool name: ${String(item)}`);
    }
    if (!output.includes(item)) output.push(item);
  }
  return output;
}

export function approvalPolicy(config) {
  const raw = policyObject(config);
  const production = config?.deployment?.mode === 'production';
  return {
    enabled: defaultedBoolean(raw.enabled, production, 'team.approvals.enabled'),
    requiredCapabilities: capabilityList(raw.requiredCapabilities, production ? ['publish', 'admin'] : []),
    requiredTools: toolList(raw.requiredTools),
    ttlSeconds: defaultedInteger(raw.ttlSeconds, 3600, 300, 86400, 'team.approvals.ttlSeconds'),
    separationOfDuties: defaultedBoolean(raw.separationOfDuties, true, 'team.approvals.separationOfDuties'),
    ownerBypass: defaultedBoolean(raw.ownerBypass, true, 'team.approvals.ownerBypass')
  };
}

export function toolNeedsApproval({ config, principal, tool, capability }) {
  const policy = approvalPolicy(config);
  if (String(tool || '').startsWith('team_approval_')) return false;
  if (!config?.team?.enabled || !policy.enabled) return false;
  if (!principal || principal.source !== 'team-token') return false;
  if (principal.role === 'owner' && policy.ownerBypass) return false;
  return policy.requiredTools.includes(tool) || policy.requiredCapabilities.includes(capability);
}

export function approvalDigest({ principal, tool, workspaceId, args }) {
  return crypto.createHash('sha256').update(canonical({
    principalId: principal?.id || '',
    tool: String(tool || ''),
    workspaceId: workspaceId || null,
    args: args || {}
  })).digest('base64url');
}

function prune(store, now = Date.now()) {
  let changed = false;
  for (const request of store.requests) {
    if (!FINAL_STATUSES.has(request.status) && Date.parse(request.expiresAt || 0) <= now) {
      request.status = 'expired';
      request.decidedAt = nowIso();
      changed = true;
    }
  }
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const next = store.requests.filter(item => !FINAL_STATUSES.has(item.status) || Date.parse(item.decidedAt || item.consumedAt || item.cancelledAt || item.expiresAt || 0) >= cutoff);
  if (next.length !== store.requests.length) changed = true;
  store.requests = next;
  if (changed) writeStore(store);
  return store;
}

function approvalError(request) {
  const error = new Error(`Approval required before ${request.tool}. Request ${request.id} is pending until ${request.expiresAt}. A different maintainer or owner must approve it, then retry the identical tool call.`);
  error.code = 'approval_required';
  error.approvalRequest = publicRequest(request);
  return error;
}

export function ensureToolApproval({ config, principal, tool, capability, workspaceId, args }) {
  if (!toolNeedsApproval({ config, principal, tool, capability })) return { required: false };
  const policy = approvalPolicy(config);
  const store = prune(readStore());
  const digest = approvalDigest({ principal, tool, workspaceId, args });
  const approved = store.requests.find(item =>
    item.status === 'approved' &&
    item.requestedBy === principal.id &&
    item.argumentDigest === digest &&
    Date.parse(item.expiresAt) > Date.now()
  );
  if (approved) {
    approved.status = 'consumed';
    approved.consumedAt = nowIso();
    writeStore(store);
    return { required: true, approved: true, request: publicRequest(approved) };
  }
  const pending = store.requests.find(item =>
    item.status === 'pending' &&
    item.requestedBy === principal.id &&
    item.argumentDigest === digest &&
    Date.parse(item.expiresAt) > Date.now()
  );
  if (pending) throw approvalError(pending);

  const request = {
    id: `approval-${crypto.randomBytes(8).toString('hex')}`,
    status: 'pending',
    tool,
    capability,
    workspaceId: workspaceId || null,
    requestedBy: principal.id,
    requestedByName: principal.name || principal.id,
    requestedByRole: principal.role,
    requestedAt: nowIso(),
    expiresAt: new Date(Date.now() + policy.ttlSeconds * 1000).toISOString(),
    argumentDigest: digest,
    argumentSummary: summarize(args || {}),
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: '',
    consumedAt: null,
    cancelledAt: null
  };
  store.requests.push(request);
  writeStore(store);
  throw approvalError(request);
}

function scopeAllows(principal, workspaceId) {
  return !principal?.workspaceIds?.length || !workspaceId || principal.workspaceIds.includes(workspaceId);
}

export function listApprovalRequests({ principal, status, workspaceId, limit = 100 } = {}) {
  const store = prune(readStore());
  const canReview = principal?.role === 'owner' || principal?.role === 'maintainer';
  return store.requests
    .filter(item => !status || item.status === status)
    .filter(item => !workspaceId || item.workspaceId === workspaceId)
    .filter(item => scopeAllows(principal, item.workspaceId))
    .filter(item => canReview || item.requestedBy === principal?.id)
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)))
    .map(publicRequest);
}

export function approvalRequest(id, principal) {
  const request = prune(readStore()).requests.find(item => item.id === id);
  if (!request || !scopeAllows(principal, request.workspaceId)) return null;
  const canReview = principal?.role === 'owner' || principal?.role === 'maintainer';
  if (!canReview && request.requestedBy !== principal?.id) return null;
  return publicRequest(request);
}

export function decideApprovalRequest({ id, principal, decision, note = '', config }) {
  if (!['owner', 'maintainer'].includes(principal?.role)) throw new Error('Approval decisions require maintainer or owner role');
  if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
  const policy = approvalPolicy(config);
  const store = prune(readStore());
  const request = store.requests.find(item => item.id === id);
  if (!request) throw new Error(`Approval request not found: ${id}`);
  if (!scopeAllows(principal, request.workspaceId)) throw new Error(`Principal ${principal.id} is not allowed to review workspace ${request.workspaceId}`);
  if (request.status !== 'pending') throw new Error(`Approval request ${id} is ${request.status}`);
  if (policy.separationOfDuties && request.requestedBy === principal.id) {
    throw new Error('Separation of duties requires a different principal to approve this request');
  }
  request.status = decision === 'approve' ? 'approved' : 'rejected';
  request.decidedBy = principal.id;
  request.decidedByName = principal.name || principal.id;
  request.decidedAt = nowIso();
  request.decisionNote = String(note || '').trim().slice(0, 1000);
  writeStore(store);
  return publicRequest(request);
}

export function cancelApprovalRequest({ id, principal, note = '' }) {
  const store = prune(readStore());
  const request = store.requests.find(item => item.id === id);
  if (!request) return { cancelled: false, id, reason: 'not found or expired' };
  if (!scopeAllows(principal, request.workspaceId)) throw new Error(`Principal ${principal.id} is not allowed to access workspace ${request.workspaceId}`);
  const canManage = principal?.role === 'owner' || principal?.role === 'maintainer';
  if (request.requestedBy !== principal?.id && !canManage) throw new Error(`Approval request ${id} belongs to ${request.requestedByName || request.requestedBy}`);
  if (!['pending', 'approved'].includes(request.status)) return { cancelled: false, request: publicRequest(request), reason: request.status };
  request.status = 'cancelled';
  request.cancelledAt = nowIso();
  request.decidedBy = principal.id;
  request.decidedByName = principal.name || principal.id;
  request.decisionNote = String(note || '').trim().slice(0, 1000);
  writeStore(store);
  return { cancelled: true, request: publicRequest(request) };
}

export function clearApprovalRequests() {
  writeStore({ version: 1, requests: [] });
}

export const __test = { canonical, capabilityList, policyObject, prune, publicRequest, summarize, toolList };
