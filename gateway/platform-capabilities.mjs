import { installEmbeddedRunnerCapability } from './embedded-runner-capability.mjs';
import { installHostContextCapabilities } from './host-context-capabilities.mjs';
import { installLocalCapabilities } from './local-capabilities.mjs';
import { installObsidianHostCapabilities } from './obsidian-host-capabilities.mjs';
import { installRunnerCapabilities } from './runner-capabilities.mjs';
import {
  registerServerInitializer,
  registerToolDecorator,
  serverExtensionHostStatus
} from './server-extension-host.mjs';
import { installTeamCapabilities } from './team-capabilities.mjs';
import { validateToolRegistration } from './tool-policy.mjs';
import { builtinPlugins } from './plugins/builtins.mjs';
import { registerPluginHost } from './plugins/plugin-host.mjs';

export function installPlatformCapabilities(McpServerClass, plugins = builtinPlugins) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.tool-contract',
    order: 0,
    decorate({ name, config, handler }) {
      const contract = validateToolRegistration(name, config);
      if (!contract.ok) throw new Error(contract.errors.join('; '));
      return { handler };
    }
  });
  installTeamCapabilities(McpServerClass);
  installRunnerCapabilities(McpServerClass);
  installHostContextCapabilities(McpServerClass);
  installObsidianHostCapabilities(McpServerClass);
  installLocalCapabilities(McpServerClass);
  registerServerInitializer(McpServerClass, {
    id: 'devmate.plugin-host',
    order: 40,
    initialize: server => registerPluginHost(server, plugins)
  });
  installEmbeddedRunnerCapability(McpServerClass);
  return serverExtensionHostStatus(McpServerClass);
}

export {
  serverExtensionHostStatus,
  serverExtensionInstanceStatus
} from './server-extension-host.mjs';
