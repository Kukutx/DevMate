'use strict';

const path = require('node:path');
const { readLifecycleIntent } = require('../shared/lifecycle-intent.cjs');
const { TunnelController } = require('./tunnel-controller.js');

const DEFAULT_LIFECYCLE_WATCH_MS = 500;

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
    this.lifecycleWatch = null;
    this.lifecycleCleanup = null;
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
  }

  async stop() {
    this.stopLifecycleWatch();
    if (this.lifecycleCleanup) await this.lifecycleCleanup.catch(() => null);
    return super.stop();
  }

  async dispose(options = {}) {
    if (this.lifecycleCleanup) await this.lifecycleCleanup.catch(() => null);
    const result = await super.dispose(options);
    if (result?.disposed === true) {
      this.stopLifecycleWatch();
    } else {
      // A clean host detach may deliberately leave an owned shared provider alive
      // until another host adopts it or this process exits. Keep the lifecycle
      // fence active so a remote explicit Stop still converges immediately.
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
      lifecycleCleanupInFlight: !!this.lifecycleCleanup
    };
  }
}

module.exports = {
  DEFAULT_LIFECYCLE_WATCH_MS,
  DesktopTunnelController,
  lifecycleStoppedError
};
