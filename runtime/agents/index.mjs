import { CodexAdapter } from './codex.mjs';
import { ClaudeAdapter, CLAUDE_MINIMUM_VERSION } from './claude.mjs';
import { AcpAdapter } from './acp.mjs';
import { agentVersion, compareVersions, fail, resolveAgentCommand, textInput } from './common.mjs';
export { AgentAdapterError, resolveAgentCommand } from './common.mjs';
export const AGENT_PROVIDERS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);
const MINIMUM_VERSIONS = Object.freeze({ claude: CLAUDE_MINIMUM_VERSION });
/**
 * Owns only the processes it starts. command/env/mcpServers are trusted host configuration,
 * never agent-provided arguments. Native session/model identifiers remain provider-specific.
 * send resolves on confirmed completion; busy sends reject; only explicit steer changes a turn.
 */
export function createAgentAdapter(options) {
  if (!options || !AGENT_PROVIDERS.includes(options.provider)) throw fail('unsupported_provider', 'Choose codex, claude, gemini, or grok');
  const names = new Set();
  for (const server of options.mcpServers || []) {
    if (!server || !/^[A-Za-z0-9_-]+$/.test(server.name || '') || names.has(server.name)) throw fail('invalid_input', 'MCP server names must be unique');
    names.add(server.name); textInput(server.command, 'MCP command');
    if (server.args && (!Array.isArray(server.args) || server.args.some(x => typeof x !== 'string' || x.includes('\0')))) throw fail('invalid_input', 'Invalid MCP args');
    if (server.env && (typeof server.env !== 'object' || Object.values(server.env).some(x => typeof x !== 'string' || x.includes('\0')))) throw fail('invalid_input', 'Invalid MCP environment');
  }
  const ownedOptions = { ...options, mcpServers: structuredClone(options.mcpServers || []) };
  if (options.provider === 'codex') return new CodexAdapter(ownedOptions);
  if (options.provider === 'claude') return new ClaudeAdapter(ownedOptions);
  return new AcpAdapter(ownedOptions);
}
// Whether a provider's CLI is installed and which version it reports. Runs `--version`
// at most once every few minutes and never a model request.
export async function inspectAgentProvider(provider, { command } = {}) {
  const base = { id: provider, provider, authenticated: 'not_checked' };
  try {
    const probe = await agentVersion(await resolveAgentCommand(provider, command));
    // A configured command that cannot even be started is not an installed provider.
    if (probe.error?.code === 'process_error') return { ...base, status: 'unavailable', version: null, error: probe.error };
    const minimumVersion = MINIMUM_VERSIONS[provider];
    const outdated = !!(minimumVersion && probe.version && compareVersions(probe.version, minimumVersion) < 0);
    return { ...base, status: outdated ? 'unsupported' : 'installed', version: probe.version, ...(minimumVersion ? { minimumVersion } : {}),
      ...(outdated ? { error: { code: 'unsupported_version', message: provider + ' ' + probe.version + ' is older than the required ' + minimumVersion + '.' } }
        : probe.error ? { error: probe.error } : {}) };
  } catch (error) {
    return { ...base, status: 'unavailable', version: null, error: { code: error.code, message: error.message } };
  }
}
