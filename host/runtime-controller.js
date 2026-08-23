'use strict';

const fs = require('node:fs');
const constants = require('./runtime/constants.js');
const statePaths = require('./runtime/state-paths.js');
const configStore = require('../shared/config-store.cjs');
const network = require('./runtime/network.js');
const processRuntime = require('./runtime/process-controller.js');
const tunnelRuntime = require('../vscode-host/tunnel-controller.js');
const { ensureDesktopAuthenticationPolicy } = require('../shared/desktop-auth-policy.cjs');

class RuntimeController extends processRuntime.RuntimeController {
  ensureConfig() {
    const fresh = !fs.existsSync(this.configFile);
    const config = super.ensureConfig();
    return ensureDesktopAuthenticationPolicy(this.configFile, { fresh }).config;
  }

  async dispose(_options = {}) {
    if (this.disposed) return { disposed: true, alreadyDisposed: true };
    const stopped = await this.stop();
    const result = await super.dispose({ stopOwned: false });
    return result?.disposed === false ? { ...result, stop: stopped } : { ...result, stop: stopped };
  }
}

class DesktopTunnelController extends tunnelRuntime.TunnelController {
  async dispose(_options = {}) {
    if (this.disposed) return { disposed: true, alreadyDisposed: true };
    const stopped = await this.stop();
    const result = await super.dispose({ stopOwned: false });
    return result?.disposed === false ? { ...result, stop: stopped } : { ...result, stop: stopped };
  }
}

// Both desktop hosts load runtime-controller before importing tunnel-controller.
// Replace the cached export once so every desktop TunnelController follows the
// same non-orphaning disposal invariant without duplicating teardown logic.
if (tunnelRuntime.TunnelController !== DesktopTunnelController) {
  tunnelRuntime.TunnelController = DesktopTunnelController;
}

module.exports = {
  ...constants,
  ...statePaths,
  ...configStore,
  ...network,
  ...processRuntime,
  RuntimeController,
  DesktopTunnelController
};
