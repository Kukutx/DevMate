import { installLocalCapabilities } from './local-capabilities.mjs';
import { installRunnerCapabilities } from './runner-capabilities.mjs';
import { registerServerInitializer, serverExtensionHostStatus } from './server-extension-host.mjs';
import { installTeamCapabilities } from './team-capabilities.mjs';
import { builtinPlugins } from './plugins/builtins.mjs';
import { registerPluginHost } from './plugins/plugin-host.mjs';

export function installPlatformCapabilities(McpServerClass, plugins = builtinPlugins) {
  installTeamCapabilities(McpServerClass);
  installRunnerCapabilities(McpServerClass);
  installLocalCapabilities(McpServerClass);
  registerServerInitializer(McpServerClass, {
    id: 'devmate.plugin-host',
    order: 40,
    initialize: server => registerPluginHost(server, plugins)
  });
  return serverExtensionHostStatus(McpServerClass);
}

export { serverExtensionHostStatus } from './server-extension-host.mjs';
