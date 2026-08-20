import { readConfig } from './local-shared.mjs';
import { startJobRuntime } from './job-runtime.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';

export function installEmbeddedRunnerCapability(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.embedded-runner',
    order: 100,
    initialize() {
      const config = readConfig();
      if (config.jobs?.embeddedRunnerEnabled === true) startJobRuntime();
    }
  });
}
