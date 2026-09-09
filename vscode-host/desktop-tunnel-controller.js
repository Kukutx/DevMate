'use strict';

const path = require('node:path');
const { readLifecycleIntent } = require('../shared/lifecycle-intent.cjs');
const { withConnectionMutationLease } = require('./connection-mutation-lease.js');
const { TunnelController } = require('./tunnel-controller.js');

const DEFAULT_LIFECYCLE_WATCH_MS = 500;
const SUPERVISOR_HANDOFF_TIMEOUT_MS = 2000;
const REMOTE_STOP_WAIT_MS = 8000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ms) || 1)));
}

function lifecycleStoppedError(intent = null) {
  const error = new Error('Desktop public connection is stopped by the shared DevMate lifecycle');
  error.code = 'DEVMATE_TUNNEL_LIFECYCLE_STOPPED';
  error.generation = intent?.generation ?? null;
  return error;
}

class DesktopTunnelController extends TunnelController {
  constructor(options = {}) {
    super(options);
    this.lifecycleConfigFile = path.join(this.stateDirectory, 'config.json');
    this.lifecycleWatchMs = Math.max(100, Number(options.lifecycleWatchMs) || DEFAULT_LIFECYCLE_WATCH_MS);
    this.connectionMutationTimeoutMs = Math.max(
      2000,
      Number(options.connectionMutationTimeoutMs) || this.startTimeoutMs + this.readyTimeoutMs + 5000
    );
    this.lifecycleWatch = null;
    this.lifecycleCleanup = null;

    // The supervisor receives enough bounded shared-state metadata to become
    // the lease/lifecycle owner before this VS Code host disconnects. The real
    // provider spawn options deliberately do not include this private field.
    const delegate = this.childProcess;
    this.childProcess = {
      spawnSync: delegate.spawnSync.bind(delegate),
      spawn: (command, args = [], spawnOptions = {}) => {
        const match = this.match(this.port);
        return delegate.spawn(command, args, {
          ...spawnOptions,
          devMateSupervisor: {
            stateDirectory: this.stateDirectory,
            ownerId: this.ownerId,
            hostId: this.hostId,
            port: match.port,
            provider: match.provider,
            configurationKey: match.configurationKey,
            leaseMs: this.runtimeLeaseMs
          }
        });
      }
    };
  }

  lifecycleIntent() {
    return readLifecycleIntent(this.lifecycleConfigFile);
  }

  assertLifecycleRunning() {
    const intent = this.lifecycleIntent();
    if (intent.desiredState !== 'running') throw lifecycleStoppedError(intent);
    return intent;
  }

  startLifecycleWatch() {
    if (this.lifecycleWatch || this.disposed) return;
    this.lifecycleWatch = setInterval(() => {
      if (this.disposed || this.lifecycleCleanup) return;
      let intent;
      try { intent = this.lifecycleIntent(); }
      catch (error) {
        this.logger?.(`Desktop tunnel lifecycle check failed: ${error.message || error}`);
        return;
      }
      if (intent.desiredState === 'running') return;
      let cleanup;
      cleanup = super.stop()
        .then(result => {
          this.logger?.(`Released desktop public connection because shared lifecycle is stopped; generation=${intent.generation}.`);
          return result;
        })
        .catch(error => {
          this.logger?.(`Desktop public connection lifecycle cleanup failed: ${error.message || error}`);
          return null;
        })
        .finally(() => {
          if (this.lifecycleCleanup === cleanup) this.lifecycleCleanup = null;
          this.stopLifecycleWatch();
        });
      this.lifecycleCleanup = cleanup;
    }, this.lifecycleWatchMs);
    this.lifecycleWatch.unref?.();
  }

  stopLifecycleWatch() {
    if (!this.lifecycleWatch) return;
    clearInterval(this.lifecycleWatch);
    this.lifecycleWatch = null;
  }

  async start(port) {
    return withConnectionMutationLease({
      stateDirectory: this.stateDirectory,
      hostId: `${this.hostId}-start`,
      timeoutMs: this.connectionMutationTimeoutMs
    }, async () => {
      this.assertLifecycleRunning();
      const result = await super.start(port);
      try {
        this.assertLifecycleRunning();
      } catch (error) {
        await super.stop().catch(() => {});
        throw error;
      }
      this.startLifecycleWatch();
      return result;
    });
  }

  async waitForRemoteLifecycleStop(result, timeoutMs = REMOTE_STOP_WAIT_MS) {
    let intent;
    try { intent = this.lifecycleIntent(); }
    catch { return result; }
    if (intent.desiredState !== 'stopped') return result;
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || REMOTE_STOP_WAIT_MS);
    while (Date.now() <= deadline) {
      try {
        const record = this.store.read();
        if (!record) {
          return { stopped: true, detached: false, reason: 'stopped-by-shared-lifecycle', publicUrl: result?.publicUrl || '' };
        }
      } catch (error) {
        if (error?.code !== 'DEVMATE_TUNNEL_SUPERVISOR_CLEANUP_PENDING') throw error;
      }
      await delay(100);
    }
    return { ...result, reason: 'shared-lifecycle-stop-timeout' };
  }

  async stop() {
    this.stopLifecycleWatch();
    if (this.lifecycleCleanup) await this.lifecycleCleanup.catch(() => null);
    const result = await super.stop();
    if (result?.stopped === false && result?.reason === 'managed-by-another-host') {
      return this.waitForRemoteLifecycleStop(result);
    }
    return result;
  }

  async handoffSupervisor(child, ownerId, timeoutMs = SUPERVISOR_HANDOFF_TIMEOUT_MS) {
    if (!child?.devMateSupervised || !child?.devMateHandoffCapable || !child.connected || typeof child.send !== 'function') return false;
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.off?.('message', onMessage);
        resolve(value);
      };
      const onMessage = message => {
        if (message?.type !== 'devmate:provider-handoff-ready') return;
        if (String(message.ownerId || '') !== String(ownerId || '')) return;
        finish(true);
      };
      child.on?.('message', onMessage);
      timer = setTimeout(() => finish(false), Math.max(250, Number(timeoutMs) || SUPERVISOR_HANDOFF_TIMEOUT_MS));
      try {
        child.send({ type: 'devmate:provider-handoff' }, error => {
          if (error) finish(false);
        });
      } catch {
        finish(false);
      }
    });
  }

  async detachForHostHandoff() {
    this.stopLifecycleWatch();
    if (this.lifecycleCleanup) await this.lifecycleCleanup.catch(() => null);
    const child = this.child;
    const ownerId = this.ownerId;

    if (child && child.devMateSupervised === true && child.devMateHandoffCapable === true && ownerId) {
      // Stop the parent heartbeat before requesting the supervisor write, or the
      // parent could race the ACK and restore its soon-to-die hostPid.
      this.stopHeartbeat();
      const confirmed = await this.handoffSupervisor(child, ownerId);
      if (!confirmed) {
        this.startHeartbeat();
        return { disposed: false, reason: 'supervisor-handoff-unconfirmed' };
      }
      let record = null;
      try { record = this.store.read({ includeStale: true }); } catch {}
      if (!record || record.ownerId !== ownerId || Number(record.hostPid) !== Number(child.pid) || record.childKind !== 'supervisor') {
        this.startHeartbeat();
        return { disposed: false, reason: 'supervisor-ownership-not-persisted' };
      }

      this.child = null;
      this.childReady = false;
      this.clearLocalOwnership(ownerId);
      try { if (child.connected) child.disconnect(); } catch {}
      try { child.unref?.(); } catch {}
      this.disposed = true;
      return {
        disposed: true,
        detached: true,
        stop: { stopped: false, detached: true, reason: 'host-detached', publicUrl: record.publicUrl || '' }
      };
    }

    // Borrowed/external providers are not owned process trees. Removing the
    // local shared record does not terminate their public endpoint and prevents
    // the dead host PID from poisoning later attachment.
    if (!child && ownerId) {
      await super.stop().catch(() => null);
      this.stopHeartbeat();
      this.disposed = true;
      return { disposed: true, detached: true, stop: { stopped: false, detached: true, reason: 'host-detached-nonowned-provider' } };
    }

    if (!child) {
      this.stopHeartbeat();
      this.disposed = true;
      return { disposed: true, detached: true, stop: { stopped: false, detached: true, reason: 'host-detached-attached-provider' } };
    }

    // A custom/legacy unsupervised child has no independent lifecycle fence;
    // fail closed instead of orphaning a provider that cannot clean itself up.
    return super.dispose();
  }

  async dispose({ stopOwned = true } = {}) {
    if (this.disposed) return { disposed: true, alreadyDisposed: true };
    if (!stopOwned) return this.detachForHostHandoff();
    if (this.lifecycleCleanup) await this.lifecycleCleanup.catch(() => null);
    const result = await super.dispose();
    if (result?.disposed === true) {
      this.stopLifecycleWatch();
    } else {
      try {
        if (this.lifecycleIntent().desiredState === 'running') this.startLifecycleWatch();
      } catch {}
    }
    return result;
  }

  diagnosticSnapshot(port = this.port) {
    const snapshot = super.diagnosticSnapshot(port);
    let intent = null;
    try { intent = this.lifecycleIntent(); } catch {}
    return {
      ...snapshot,
      desktopLifecycle: intent,
      lifecycleWatchMs: this.lifecycleWatchMs,
      lifecycleCleanupInFlight: !!this.lifecycleCleanup,
      connectionMutationTimeoutMs: this.connectionMutationTimeoutMs
    };
  }
}

module.exports = {
  DEFAULT_LIFECYCLE_WATCH_MS,
  REMOTE_STOP_WAIT_MS,
  SUPERVISOR_HANDOFF_TIMEOUT_MS,
  DesktopTunnelController,
  lifecycleStoppedError
};
