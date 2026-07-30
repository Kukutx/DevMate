import { z } from 'zod';
import { audit, readConfig, toolText, writeConfig } from './local-shared.mjs';
import { listRunners } from './job-queue.mjs';
import {
  createRunnerCredential,
  normalizeRunnerControlConfig,
  revokeRunnerCredential,
  rotateRunnerCredentialToken,
  runnerCredentialPublic,
  updateRunnerCredential
} from './runner-access.mjs';
import { principalNow, workspaceIds } from './team-tool-data.mjs';

function maintainerNow() {
  const principal = principalNow();
  if (!['owner', 'maintainer'].includes(principal.role)) {
    throw new Error('Runner topology status requires maintainer or owner role');
  }
  return principal;
}

function ownerNow() {
  const principal = principalNow();
  if (principal.role !== 'owner') throw new Error('External Runner credential administration requires the owner role');
  return principal;
}

function publicRuntime(config) {
  return {
    embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled !== false,
    externalControlEnabled: config.runnerControl.enabled,
    path: config.runnerControl.path,
    maxRequestBytes: config.runnerControl.maxRequestBytes,
    requestsPerMinute: config.runnerControl.requestsPerMinute,
    maxCredentials: config.runnerControl.maxCredentials,
    credentialCount: config.runnerControl.credentials.length,
    activeCredentials: config.runnerControl.credentials.filter(item =>
      !item.disabled && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
    ).length
  };
}

export function registerRunnerTools(register, annotations) {
  const { ro, rw } = annotations;

  register('runner_control_status', {
    title: 'External runner control status',
    description: 'Show embedded/external Runner state, credential count, limits, and currently known runners. Requires maintainer or owner.',
    inputSchema: {},
    annotations: ro
  }, async () => {
    maintainerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    return toolText({ ...publicRuntime(config), runners: listRunners() });
  });

  register('runner_control_configure', {
    title: 'Configure Runner control',
    description: 'Enable or disable the external Runner API, enable or disable the embedded Runner, and change bounded request limits. Requires owner.',
    inputSchema: {
      enabled: z.boolean().optional(),
      embeddedRunnerEnabled: z.boolean().optional(),
      maxRequestBytes: z.number().int().min(65536).max(16777216).optional(),
      requestsPerMinute: z.number().int().min(30).max(10000).optional(),
      maxCredentials: z.number().int().min(1).max(500).optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async patch => {
    const principal = ownerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    config.jobs ||= {};
    for (const key of ['enabled', 'maxRequestBytes', 'requestsPerMinute', 'maxCredentials']) {
      if (patch[key] !== undefined) config.runnerControl[key] = patch[key];
    }
    if (patch.embeddedRunnerEnabled !== undefined) config.jobs.embeddedRunnerEnabled = patch.embeddedRunnerEnabled;
    normalizeRunnerControlConfig(config);
    writeConfig(config);
    await audit('runner_control_configure', { principalId: principal.id, ...patch });
    return toolText({
      configured: true,
      runnerControl: publicRuntime(config),
      restartRequired: patch.embeddedRunnerEnabled !== undefined,
      note: patch.embeddedRunnerEnabled !== undefined
        ? 'Restart the Gateway to apply the embedded Runner lifecycle change.'
        : 'External Runner API limit changes apply immediately.'
    });
  });

  register('runner_credential_list', {
    title: 'List external runner credentials',
    description: 'List Runner identities, capabilities, workspace scopes, expiry, and token versions without hashes. Requires owner.',
    inputSchema: {},
    annotations: ro
  }, async () => {
    ownerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    return toolText({ credentials: config.runnerControl.credentials.map(runnerCredentialPublic) });
  });

  register('runner_credential_create', {
    title: 'Create external runner credential',
    description: 'Create an explicitly workspace-scoped Runner identity and return its token once. Requires owner.',
    inputSchema: {
      id: z.string().max(120).optional(),
      name: z.string().min(1).max(200),
      capabilities: z.array(z.string().min(1).max(100)).max(50).optional(),
      workspaceIds: z.array(z.string().min(1).max(300)).min(1).max(200),
      maxConcurrent: z.number().int().min(1).max(16).optional(),
      expiresAt: z.string().datetime().optional()
    },
    annotations: rw
  }, async input => {
    const principal = ownerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    const result = createRunnerCredential(config, {
      ...input,
      workspaceIds: workspaceIds(config, input.workspaceIds)
    });
    writeConfig(config);
    await audit('runner_credential_create', {
      principalId: principal.id,
      runnerId: result.credential.id,
      capabilities: result.credential.capabilities,
      workspaceIds: result.credential.workspaceIds
    });
    return toolText({
      ...result,
      warning: 'The dmr_ token is shown once. Store it in the Runner host secret manager or environment and never place it in command-line arguments, source control, or logs.'
    });
  });

  register('runner_credential_update', {
    title: 'Update external runner credential',
    description: 'Update Runner name, capabilities, explicit workspace scopes, concurrency, expiry, or enabled state. Requires owner.',
    inputSchema: {
      id: z.string().min(1),
      name: z.string().max(200).optional(),
      capabilities: z.array(z.string().min(1).max(100)).max(50).optional(),
      workspaceIds: z.array(z.string().min(1).max(300)).min(1).max(200).optional(),
      maxConcurrent: z.number().int().min(1).max(16).optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      disabled: z.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, ...patch }) => {
    const principal = ownerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    if (patch.workspaceIds !== undefined) patch.workspaceIds = workspaceIds(config, patch.workspaceIds);
    const credential = updateRunnerCredential(config, id, patch);
    writeConfig(config);
    await audit('runner_credential_update', {
      principalId: principal.id,
      runnerId: id,
      keys: Object.keys(patch)
    });
    return toolText({ credential });
  });

  register('runner_credential_rotate', {
    title: 'Rotate external runner token',
    description: 'Invalidate the old Runner token and return a replacement once. Requires owner.',
    inputSchema: { id: z.string().min(1) },
    annotations: rw
  }, async ({ id }) => {
    const principal = ownerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    const result = rotateRunnerCredentialToken(config, id);
    writeConfig(config);
    await audit('runner_credential_rotate', { principalId: principal.id, runnerId: id });
    return toolText({
      ...result,
      warning: 'The replacement token is shown once. Update the Runner secret before restarting it and remove old copies.'
    });
  });

  register('runner_credential_revoke', {
    title: 'Revoke external runner credential',
    description: 'Disable a Runner identity immediately. New Runner API requests are rejected; currently owned jobs recover through lease expiry if the Runner can no longer report completion. Requires owner.',
    inputSchema: { id: z.string().min(1) },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const principal = ownerNow();
    const config = normalizeRunnerControlConfig(readConfig());
    const credential = revokeRunnerCredential(config, id);
    writeConfig(config);
    await audit('runner_credential_revoke', { principalId: principal.id, runnerId: id });
    return toolText({ credential });
  });
}

export const __test = { maintainerNow, ownerNow, publicRuntime };
