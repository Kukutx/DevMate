import { z } from 'zod';
import {
  assertFullAccess, audit, normalizeTrustedRoot, normalizedTrustedRoots, pathKey,
  permissionProfile, processLimits, publicTrustedRoot, syncTrustedRootsIntoConfig,
  toolText, writeConfig
} from './local-shared.mjs';
import {
  DEFAULT_READ_CHARS, MAX_READ_CHARS, listPersistentProcesses, processPublic, processRecord,
  readPersistentOutput, runningProcesses, sendPersistentInput, shutdownPersistentProcesses,
  startPersistentProcess, stopPersistentProcess
} from './persistent-processes.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';

const REGISTERED = Symbol.for('devmate.localToolsRegistered');

function registerTool(server, name, config, handler) {
  server.registerTool(name, { outputSchema: z.object({}).passthrough(), ...config }, handler);
}
function statusPayload() {
  const config = syncTrustedRootsIntoConfig();
  const limits = processLimits(config);
  const processes = listPersistentProcesses(true);
  return {
    permissionProfile: permissionProfile(config),
    trustedWritableRoots: normalizedTrustedRoots(config).map(publicTrustedRoot),
    persistentProcesses: processes,
    limits: {
      ...limits,
      running: processes.filter(item => item.status === 'running' || item.status === 'stopping').length,
      retained: processes.length
    }
  };
}
export function registerLocalTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;

  registerTool(server, 'local_capabilities_status', {
    title: 'Local capabilities status',
    description: 'Show trusted writable roots, persistent processes, permission profile, and local process limits.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toolText(statusPayload()));

  registerTool(server, 'configure_local_capabilities', {
    title: 'Configure local capabilities',
    description: 'Configure bounded persistent-process count and retained output limits. Requires fullAccess.',
    inputSchema: {
      maxPersistentProcesses: z.number().int().min(1).max(32).optional(),
      persistentProcessOutputBytes: z.number().int().min(65536).max(20971520).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ maxPersistentProcesses, persistentProcessOutputBytes }) => {
    const config = syncTrustedRootsIntoConfig();
    assertFullAccess(config, 'Configuring local capabilities');
    config.runtime ||= {};
    if (maxPersistentProcesses !== undefined) config.runtime.maxPersistentProcesses = maxPersistentProcesses;
    if (persistentProcessOutputBytes !== undefined) config.runtime.persistentProcessOutputBytes = persistentProcessOutputBytes;
    writeConfig(config);
    await audit('configure_local_capabilities', { maxPersistentProcesses, persistentProcessOutputBytes });
    return toolText({ configured: true, status: statusPayload() });
  });

  registerTool(server, 'list_trusted_roots', {
    title: 'List trusted writable roots',
    description: 'List explicit external directories that DevMate may access as writable workspaces.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    const config = syncTrustedRootsIntoConfig();
    return toolText({ roots: normalizedTrustedRoots(config).map(publicTrustedRoot) });
  });

  registerTool(server, 'add_trusted_root', {
    title: 'Add trusted writable root',
    description: 'Grant DevMate writable workspace access to one existing absolute local directory. Requires fullAccess and refuses filesystem roots.',
    inputSchema: { path: z.string().min(1), name: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ path: rootPath, name = '' }) => {
    const config = syncTrustedRootsIntoConfig();
    assertFullAccess(config, 'Adding a trusted writable root');
    const root = normalizeTrustedRoot(rootPath, name);
    const normalWorkspace = (config.workspaces || []).find(item => !item.trusted && pathKey(item.root || '') === pathKey(root.root));
    if (normalWorkspace) {
      return toolText({ added: false, reason: 'already configured as a workspace', root: publicTrustedRoot(root) });
    }
    const trusted = normalizedTrustedRoots(config);
    const existing = trusted.find(item => pathKey(item.root) === pathKey(root.root));
    if (existing) return toolText({ added: false, reason: 'already trusted', root: publicTrustedRoot(existing) });
    config.trustedWritableRoots = [...trusted, root].map(({ id, name, root }) => ({ id, name, root }));
    writeConfig(config);
    const next = syncTrustedRootsIntoConfig();
    await audit('add_trusted_root', { root: root.root, workspace: root.id });
    return toolText({
      added: true,
      root: publicTrustedRoot(normalizedTrustedRoots(next).find(item => item.id === root.id) || root)
    });
  });

  registerTool(server, 'remove_trusted_root', {
    title: 'Remove trusted writable root',
    description: 'Revoke a trusted writable root. Running persistent processes in that root must be stopped first or stopProcesses=true.',
    inputSchema: { id: z.string().optional(), path: z.string().optional(), stopProcesses: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ id, path: rootPath, stopProcesses = false }) => {
    const config = syncTrustedRootsIntoConfig();
    assertFullAccess(config, 'Removing a trusted writable root');
    const trusted = normalizedTrustedRoots(config);
    const target = trusted.find(item => id ? item.id === id : rootPath ? pathKey(item.root) === pathKey(rootPath) : false);
    if (!target) throw new Error('Trusted root not found; provide id or path');
    const attached = runningProcesses().filter(record => record.workspaceId === target.id);
    if (attached.length && !stopProcesses) {
      throw new Error(`Trusted root has running processes: ${attached.map(item => item.id).join(', ')}. Stop them or pass stopProcesses=true.`);
    }
    const stopResults = attached.length
      ? await Promise.all(attached.map(record => stopPersistentProcess(record.id, false, false)))
      : [];
    const unconfirmed = stopResults.filter(result => result.stopped !== true || result.exitConfirmed !== true);
    if (unconfirmed.length) {
      throw new Error(`Trusted root cannot be revoked because process exit was not confirmed: ${unconfirmed.map(result => result.process?.id || 'unknown').join(', ')}`);
    }
    config.trustedWritableRoots = trusted
      .filter(item => item.id !== target.id)
      .map(({ id, name, root }) => ({ id, name, root }));
    writeConfig(config);
    syncTrustedRootsIntoConfig();
    const stoppedProcesses = attached.map(item => item.id);
    await audit('remove_trusted_root', {
      root: target.root, workspace: target.id, stoppedProcesses
    });
    return toolText({ removed: true, root: publicTrustedRoot(target), stoppedProcesses });
  });

  registerTool(server, 'start_process', {
    title: 'Start persistent process',
    description: 'Start a long-running local command with retained output and optional stdin. The process persists across MCP calls until it exits or is stopped.',
    inputSchema: {
      workspaceId: z.string().optional(), command: z.string().min(1), cwd: z.string().optional(),
      label: z.string().optional(), environment: z.record(z.string(), z.string()).optional(),
      autoStopAfterMs: z.number().int().min(1000).max(86400000).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async args => toolText({ started: true, process: await startPersistentProcess(args) }));

  registerTool(server, 'list_processes', {
    title: 'List persistent processes',
    description: 'List running and recently completed DevMate persistent processes.',
    inputSchema: { includeFinished: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ includeFinished = true }) => {
    const processes = listPersistentProcesses(includeFinished);
    return toolText({
      processes,
      running: processes.filter(item => item.status === 'running' || item.status === 'stopping').length
    });
  });

  registerTool(server, 'process_status', {
    title: 'Persistent process status',
    description: 'Show status and output cursor information for one persistent process.',
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => toolText({ process: processPublic(processRecord(id)) }));

  registerTool(server, 'read_process_output', {
    title: 'Read persistent process output',
    description: 'Read retained stdout, stderr, and lifecycle events after a sequence cursor.',
    inputSchema: {
      id: z.string().min(1), afterSequence: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(4096).max(MAX_READ_CHARS).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, afterSequence = 0, maxChars = DEFAULT_READ_CHARS }) =>
    toolText(readPersistentOutput(id, afterSequence, maxChars)));

  registerTool(server, 'send_process_input', {
    title: 'Send persistent process input',
    description: 'Write text to a running persistent process stdin.',
    inputSchema: { id: z.string().min(1), input: z.string(), appendNewline: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ id, input, appendNewline = true }) =>
    toolText({ sent: true, process: await sendPersistentInput(id, input, appendNewline), chars: input.length, appendNewline }));

  registerTool(server, 'stop_process', {
    title: 'Stop persistent process',
    description: 'Stop a persistent process tree gracefully, escalating to force after a short timeout. Optionally forget its retained record.',
    inputSchema: { id: z.string().min(1), force: z.boolean().optional(), forget: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ id, force = false, forget = false }) => toolText(await stopPersistentProcess(id, force, forget)));
}

export function installLocalCapabilities(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.local-tools',
    order: 30,
    initialize(server) {
      syncTrustedRootsIntoConfig();
      registerLocalTools(server);
    }
  });
}

export { shutdownPersistentProcesses };
export const __test = { registerLocalTools, statusPayload };
