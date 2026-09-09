'use strict';

const fs = require('node:fs');
const constants = require('./runtime/constants.js');
const statePaths = require('./runtime/state-paths.js');
const configStore = require('../shared/config-store.cjs');
const network = require('./runtime/network.js');
const processRuntime = require('./runtime/process-controller.js');
const { ensureDesktopAuthenticationPolicy } = require('../shared/desktop-auth-policy.cjs');
const { ensureDesktopPermissionPolicy } = require('../shared/desktop-permission-policy.cjs');

const DETACHED_DESKTOP_LAUNCH_MODE = 'desktop-detached';
const SHARED_STOP_WAIT_MS = 5000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function desktopSpawn(spawnImpl) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  return function spawnDetachedDesktopGateway(command, args, options = {}) {
    const child = spawnImpl(command, args, {
      ...options,
      detached: true,
      env: {
        ...(options.env || process.env),
        DEVMATE_RUNTIME_LAUNCH_MODE: DETACHED_DESKTOP_LAUNCH_MODE
      }
    });
    if (child && typeof child === 'object') {
      child.devMateDesktopDetached = true;
      child.launchMode = DETACHED_DESKTOP_LAUNCH_MODE;
    }
    return child;
  };
}

class RuntimeController extends processRuntime.RuntimeController {
  constructor(options = {}) {
    const lifecycleFence = options.lifecycleFence !== false;
    super({
      ...options,
      lifecycleFence,
      spawnImpl: lifecycleFence ? desktopSpawn(options.spawnImpl || require('node:child_process').spawn) : options.spawnImpl
    });
  }

  ensureConfig() {
    const fresh = !fs.existsSync(this.configFile);
    super.ensureConfig();
    const auth = ensureDesktopAuthenticationPolicy(this.configFile, { fresh }).config;
    return ensureDesktopPermissionPolicy(this.configFile, {
      fresh,
      defaults: auth.permissions || {}
    }).config;
  }

  async waitForSharedLifecycleStop(timeoutMs = SHARED_STOP_WAIT_MS) {
    const config = this.ensureConfig();
    if (config.lifecycle?.desiredState !== 'stopped') {
      return { stopped: false, reason: 'shared-lifecycle-running' };
    }
    const port = Number(config.server?.port || this.preferredPort);
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || SHARED_STOP_WAIT_MS);
    while (Date.now() <= deadline) {
      const current = this.ensureConfig();
      const health = await network.healthAt(Number(current.server?.port || port), 500);
      if (!network.healthMatches(health, current)) {
        this.phase = 'idle';
        return { stopped: true, attached: false, reason: 'stopped-by-shared-lifecycle' };
      }
      await delay(100);
    }
    return { stopped: false, attached: true, reason: 'shared-lifecycle-stop-timeout' };
  }

  async stop() {
    const result = await super.stop();
    if (
      result?.stopped === false &&
      (result.reason === 'managed-by-another-host' || result.attached === true)
    ) {
      const converged = await this.waitForSharedLifecycleStop();
      if (converged.stopped) return { ...result, ...converged };
    }
    return result;
  }

  detachOwnedGateway() {
    const child = this.activeOwnedChild();
    if (child) {
      try {
        if (child.connected && typeof child.disconnect === 'function') child.disconnect();
      } catch {}
      try { child.unref?.(); } catch {}
    }
    this.child = null;
    this.owned = false;
    this.phase = 'disposed';
    this.disposed = true;
    return {
      disposed: true,
      detached: !!child,
      stop: { stopped: false, detached: !!child, reason: child ? 'host-detached' : 'not-owned' }
    };
  }

  dispose({ stopOwned = true } = {}) {
    if (stopOwned) return super.dispose();
    return this.operations.run('dispose', async () => {
      if (this.disposed) return { disposed: true, alreadyDisposed: true };
      return this.detachOwnedGateway();
    });
  }
}

module.exports = {
  ...constants,
  ...statePaths,
  ...configStore,
  ...network,
  ...processRuntime,
  DETACHED_DESKTOP_LAUNCH_MODE,
  SHARED_STOP_WAIT_MS,
  RuntimeController,
  desktopSpawn
};
