'use strict';

const fs = require('node:fs');
const path = require('node:path');
const defaultChildProcess = require('node:child_process');

function supervisorCandidates() {
  return [
    path.join(__dirname, 'provider-supervisor.js'),
    path.join(__dirname, 'provider-supervisor.cjs')
  ];
}

function resolveProviderSupervisorEntry(explicit = '') {
  const requested = String(explicit || '').trim();
  const candidates = requested ? [path.resolve(requested)] : supervisorCandidates();
  const entry = candidates.find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
  if (!entry) {
    const error = new Error(`DevMate provider supervisor is missing: ${candidates.join(', ')}`);
    error.code = 'DEVMATE_PROVIDER_SUPERVISOR_MISSING';
    throw error;
  }
  return entry;
}

function serializableSpawnOptions(options = {}) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const next = { windowsHide: source.windowsHide !== false };
  if (source.cwd) next.cwd = String(source.cwd);
  if (source.env && typeof source.env === 'object' && !Array.isArray(source.env)) {
    next.env = Object.fromEntries(Object.entries(source.env).map(([key, value]) => [String(key), String(value)]));
  }
  return next;
}

function createSupervisedChildProcess({
  childProcess = defaultChildProcess,
  nodeExecutable = process.execPath,
  supervisorEntry = ''
} = {}) {
  if (!childProcess?.spawn || !childProcess?.spawnSync) throw new TypeError('A child_process-compatible module is required');
  return {
    spawnSync: childProcess.spawnSync.bind(childProcess),
    spawn(command, args = [], options = {}) {
      const entry = resolveProviderSupervisorEntry(supervisorEntry);
      const supervisor = childProcess.spawn(nodeExecutable, [entry], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DEVMATE_PROVIDER_SUPERVISOR: '1'
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      supervisor.devMateSupervised = true;
      supervisor.devMateSupervisorEntry = entry;
      const payload = {
        type: 'devmate:provider-start',
        command: String(command || ''),
        args: Array.isArray(args) ? args.map(value => String(value)) : [],
        options: serializableSpawnOptions(options)
      };
      const send = () => {
        if (!supervisor.connected || typeof supervisor.send !== 'function') return false;
        try {
          supervisor.send(payload, error => {
            if (!error) return;
            try { supervisor.kill(); } catch {}
          });
          return true;
        } catch {
          try { supervisor.kill(); } catch {}
          return false;
        }
      };
      // Generic RuntimeController escalation calls forceTerminate() before it
      // would otherwise SIGKILL a child. A provider supervisor must never be
      // SIGKILLed merely because its provider tree has not yet been confirmed
      // dead; keeping the supervisor alive preserves the fail-closed ownership
      // fence and lets it continue cleanup retries.
      supervisor.forceTerminate = () => {
        if (supervisor.connected && typeof supervisor.send === 'function') {
          try { supervisor.send({ type: 'devmate:provider-stop' }); } catch {}
        }
        try { supervisor.kill('SIGTERM'); } catch {}
      };
      if (supervisor.pid) send();
      else supervisor.once?.('spawn', send);
      return supervisor;
    }
  };
}

module.exports = {
  createSupervisedChildProcess,
  resolveProviderSupervisorEntry,
  serializableSpawnOptions,
  supervisorCandidates
};