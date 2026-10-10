import { VERSION } from './version.mjs';
import { writeAtomic } from './platform/atomic-write.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configuredClientId, usableRedirect } from './auth-client.mjs';
import { normalizeConnectionConfig } from './connection.mjs';
import { normalizeExternalServers } from './capabilities.mjs';
import { DomainError } from './store.mjs';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const command = z.object({ file: z.string().min(1), args: z.array(z.string()).default([]) }).strict();
const provider = z.object({
  command: command.optional(), authMethod: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(1800000).optional(),
  // Variables for the agent process, each read from the named variable of the runtime.
  environment: z.record(envName, envName).default({}),
  // Pass the provider's own API-key variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) on to the agent.
  inheritApiKeys: z.boolean().default(false),
  // Codex and Claude: let a delegated session use the owner's own MCP servers besides DevMate's channel.
  inheritMcpServers: z.boolean().default(false),
  // Keep raw native protocol messages (tool inputs and outputs) in the event journal.
  recordNativeEvents: z.boolean().default(false),
  // A turn is cancelled after this much working time (default 60 min), or after this long
  // without any native progress (default 15 min, 0 = off). Waiting for a person does not count.
  turnTimeoutMs: z.number().int().min(1000).max(86400000).optional(),
  turnIdleTimeoutMs: z.number().int().min(0).max(86400000).optional(),
  // An idle session is disconnected after this long (default 30 min, 0 = never); it stays resumable.
  sessionIdleMs: z.number().int().min(0).max(604800000).optional(),
  // Sessions of this provider that may be connected at once (default 8).
  maxSessions: z.number().int().min(1).max(64).optional()
}).strict();
const claudeProvider = provider.extend({
  nativePeerMessaging: z.boolean().default(false),
  nativeAgentTeams: z.boolean().default(false),
  // Claude Code settings files a delegated session loads (--setting-sources).
  settingSources: z.array(z.enum(['user', 'project', 'local'])).min(1).max(3).default(['user'])
}).strict();
const origin = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password;
}, 'Use an exact HTTP or HTTPS origin without a path.');
const external = z.discriminatedUnion('transport', [
  z.object({ id: z.string(), transport: z.literal('http'), url: z.string(), bearerTokenEnv: envName.optional() }).strict(),
  z.object({ id: z.string(), transport: z.literal('stdio'), command: z.string(), args: z.array(z.string()).default([]),
    environment: z.record(envName, envName).default({}) }).strict()
]);
// A client the owner registers for sign-in because it publishes no metadata document.
// It is a public client: there is no secret to configure, and PKCE stays required.
const oauthClient = z.object({
  clientId: z.string().refine(configuredClientId, 'Use a plain name of at most 200 letters, digits, ".", "_" or "-", starting with a letter or digit. A URL is not a name: such a client publishes its own metadata document and is not listed here.'),
  name: z.string().trim().min(1, 'Give the client a name.').max(100, 'Use a name of at most 100 characters.'),
  // Matched exactly at sign-in; only an http: loopback redirect may arrive on another port.
  redirectUris: z.array(z.string().refine(usableRedirect, 'Use an absolute https: URL, or an http: URL to 127.0.0.1, localhost or [::1], without fragment or credentials.'))
    .min(1, 'List at least one redirect URI.').max(10, 'List at most 10 redirect URIs.')
}).strict();
export const configSchema = z.object({
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }).strict(),
    z.object({ mode: z.literal('oauth'), issuer: origin.refine(value => value.startsWith('https:'), 'OAuth requires HTTPS.'),
      clients: z.array(oauthClient).max(32).refine(clients => new Set(clients.map(client => client.clientId)).size === clients.length, 'Each clientId may be listed once.').optional() }).strict()
  ]).default({ mode: 'none' }),
  connection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }).strict(),
    z.object({ kind: z.literal('external-https'), url: z.string().url(),
      command: z.object({ executable: z.string().min(1).max(1000), args: z.array(z.string().max(2000)).max(40).optional(), env: z.array(z.string().max(100)).max(20).optional() }).strict().optional() }).strict(),
    z.object({ kind: z.literal('ssh'), publicUrl: z.string().url(), executable: z.string(), host: z.string(), user: z.string(),
      sshPort: z.number().int().optional(), remotePort: z.number().int().optional(), identityFile: z.string().optional() }).strict(),
    z.object({ kind: z.literal('openai-tunnel'), tunnelId: z.string(), executable: z.string(), runtimeKeyEnv: envName.optional() }).strict(),
    z.object({ kind: z.literal('cloudflare'), publicUrl: z.string().url(), executable: z.string(), tokenEnv: envName.optional() }).strict(),
    z.object({ kind: z.literal('cloudflare-quick'), executable: z.string() }).strict()
  ]).default({ kind: 'local' }),
  // Loopback port that tunnels and reverse proxies target. It serves only MCP and OAuth.
  ingressPort: z.number().int().min(1024).max(65535).optional(),
  // Days of event journal, idempotency receipts and restorable file versions to keep.
  retentionDays: z.number().int().min(1).max(3650).default(30),
  // The DevMate that last saved this file, so that an older one can say why it does not understand it.
  writtenBy: z.string().max(40).optional(),
  providers: z.object({ codex: provider.optional(), claude: claudeProvider.optional(), gemini: provider.optional(), grok: provider.optional() }).strict().default({}),
  externalServers: z.array(external).max(32).default([]),
  engineSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  allowedOrigins: z.array(origin).max(32).default([])
}).strict();

export function normalizeConfig(input = {}) {
  const config = configSchema.parse(input);
  config.connection = normalizeConnectionConfig(config.connection);
  config.externalServers = normalizeExternalServers(config.externalServers);
  for (const settings of Object.values(config.providers)) {
    if (settings.command && (!path.isAbsolute(settings.command.file) || /\.(cmd|bat|ps1)$/i.test(settings.command.file))) {
      throw new DomainError('invalid_executable', 'Provider command.file must be an absolute native executable. Pass a Node entry point in args.');
    }
  }
  if (config.connection.kind === 'cloudflare-quick' && config.auth.mode === 'oauth') {
    throw new DomainError('invalid_issuer', 'A quick tunnel gets a new address each time it starts, so nobody can sign in at it. Use it without sign-in, or use a tunnel with a hostname of your own.');
  }
  const publicUrl = publicMcpUrl(config);
  if (config.auth.mode === 'oauth' && publicUrl && new URL(publicUrl).origin !== config.auth.issuer) {
    throw new DomainError('invalid_issuer', 'The external MCP URL and OAuth issuer must use the same origin.');
  }
  if (config.connection.kind === 'external-https' && new URL(config.connection.url).pathname !== '/mcp') {
    throw new DomainError('invalid_mcp_url', 'Expose the configured HTTPS origin at /mcp.');
  }
  return config;
}
export function publicMcpUrl(config) {
  const connection = config.connection || {};
  return ['ssh', 'cloudflare'].includes(connection.kind) ? connection.publicUrl : connection.kind === 'external-https' ? connection.url : null;
}
export function readConfig(instanceRoot) {
  const filename = path.join(instanceRoot, 'config.json');
  if (!fs.existsSync(filename)) return normalizeConfig();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { throw new DomainError('invalid_config', filename + ' is not valid JSON (' + error.message + '). Fix it, or delete it to start from the defaults.'); }
  try { return normalizeConfig(raw); }
  catch (error) {
    if (error.name !== 'ZodError') throw error;
    const problems = error.issues.slice(0, 6).map(issue => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; ');
    // Hosts of different versions share one instance; an older one meets settings a newer one saved.
    const newer = typeof raw?.writtenBy === 'string' && newerVersion(raw.writtenBy, VERSION);
    throw new DomainError('invalid_config', filename + (newer
      ? ' was saved by DevMate ' + raw.writtenBy + ' and has settings this DevMate ' + VERSION + ' does not know (' + problems + '). Update this DevMate.'
      : ' has settings DevMate does not accept (' + problems + '). Fix them, or delete the file to start from the defaults.'));
  }
}
function newerVersion(a, b) {
  const parts = value => String(value).split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}
export function saveConfig(instanceRoot, input) {
  const config = normalizeConfig({ ...input, writtenBy: VERSION });
  const filename = path.join(instanceRoot, 'config.json');
  writeAtomic(filename, JSON.stringify(config, null, 2) + '\n');
  return config;
}
export function resolveProviderSettings(settings = {}, env = process.env) {
  const { environment = {}, ...options } = settings;
  return { ...options, env: { ...options.env, ...Object.fromEntries(Object.entries(environment).map(([key, reference]) => {
    if (typeof env[reference] !== 'string' || !env[reference]) throw new DomainError('missing_credential', 'A configured provider environment variable is unavailable.');
    return [key, env[reference]];
  })) } };
}
