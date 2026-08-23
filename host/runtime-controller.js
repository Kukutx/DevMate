'use strict';

const fs = require('node:fs');
const constants = require('./runtime/constants.js');
const statePaths = require('./runtime/state-paths.js');
const configStore = require('../shared/config-store.cjs');
const network = require('./runtime/network.js');
const processRuntime = require('./runtime/process-controller.js');
const { ensureDesktopAuthenticationPolicy } = require('../shared/desktop-auth-policy.cjs');

class RuntimeController extends processRuntime.RuntimeController {
  constructor(options = {}) {
    super({ ...options, lifecycleFence: options.lifecycleFence !== false });
  }

  ensureConfig() {
    const fresh = !fs.existsSync(this.configFile);
    super.ensureConfig();
    return ensureDesktopAuthenticationPolicy(this.configFile, { fresh }).config;
  }
}

module.exports = {
  ...constants,
  ...statePaths,
  ...configStore,
  ...network,
  ...processRuntime,
  RuntimeController
};
