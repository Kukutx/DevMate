'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('runtime depends only on current MCP v2 packages', () => {
  const pkg = JSON.parse(source('package.json'));
  assert.equal(pkg.dependencies['@modelcontextprotocol/server'], '2.0.0');
  assert.equal(pkg.dependencies['@modelcontextprotocol/client'], '2.0.0');
  assert.equal(pkg.dependencies['@modelcontextprotocol/node'], '2.0.0');
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], undefined);
  assert.equal(pkg.dependencies['@modelcontextprotocol/server-legacy'], undefined);
});

test('Gateway is MCP 2026 stateless-only', () => {
  const server = source('gateway/server.mjs');
  const requestGuard = source('gateway/request-guard.mjs');
  assert.match(server, /createMcpHandler/);
  assert.match(server, /legacy:\s*['"]reject['"]/);
  assert.doesNotMatch(server, /NodeStreamableHTTPServerTransport|Mcp-Session-Id|mcp-session-id/i);
  assert.doesNotMatch(requestGuard, /Mcp-Session-Id|mcp-session-id/i);
});

test('Runner and public verifier pin MCP 2026 without downgrade', () => {
  const runner = source('scripts/devmate-runner.mjs');
  const preflight = source('host/public-mcp.js');
  assert.match(runner, /pin:\s*['"]2026-07-28['"]/);
  assert.doesNotMatch(runner, /versionNegotiation:\s*\{\s*mode:\s*['"]auto['"]/);
  assert.match(preflight, /MCP_PROTOCOL_VERSION\s*=\s*['"]2026-07-28['"]/);
  assert.match(preflight, /server\/discover/);
  assert.match(preflight, /io\.modelcontextprotocol\/protocolVersion/);
  assert.match(preflight, /io\.modelcontextprotocol\/clientCapabilities/);
  assert.doesNotMatch(preflight, /['"]initialize['"]|Mcp-Session-Id|mcp-session-id|2025-03-26/i);
});

test('OAuth is CIMD-only and resource/issuer bound', () => {
  const oauth = source('gateway/oauth.mjs');
  const authConfig = source('shared/auth-config.cjs');
  const tokens = source('shared/oauth-tokens.cjs');
  assert.match(oauth, /client_id_metadata_document_supported:\s*true/);
  assert.match(oauth, /authorization_response_iss_parameter_supported:\s*true/);
  assert.match(oauth, /parameters\.get\(['"]resource['"]\)/);
  assert.match(oauth, /PKCE S256 is required/);
  assert.doesNotMatch(oauth, /\/oauth\/register|registration_endpoint|openid-configuration/);
  assert.doesNotMatch(authConfig, /signingKey|approvalCode/);
  assert.match(tokens, /payload\.aud !== expectedAudience \|\| payload\.iss !== expectedIssuer/);
});

test('remote member identity exists only behind OAuth and current RBAC', () => {
  const team = source('gateway/team-access.mjs');
  const guard = source('gateway/request-guard.mjs');
  assert.match(team, /dmc_/);
  assert.match(team, /principalFromOAuthClaims/);
  assert.match(team, /source:\s*['"]oauth-member['"]/);
  assert.match(team, /authVersion/);
  assert.doesNotMatch(team, /dmt_|team-token|tokenVersion|parseTeamToken|verifyAccessToken/);
  assert.match(guard, /principalFromOAuthClaims\(access, config\)/);
  assert.match(guard, /if \(isLocalRequest\(req\)\) return fallbackLocalPrincipal\(\)/);
  assert.match(guard, /config\.auth\?\.mode !== ['"]oauth['"]/);
});

test('OAuth secrets and refresh replay state use dedicated boundaries', () => {
  const secrets = source('shared/oauth-secrets.cjs');
  const state = source('gateway/oauth-state.mjs');
  const runtime = source('gateway/server-runtime.mjs');
  assert.match(secrets, /oauth-secrets\.json/);
  assert.match(secrets, /withFileLockSync/);
  assert.match(secrets, /atomicWrite/);
  assert.match(state, /reuse_detected/);
  assert.match(state, /authorizationCodes/);
  assert.match(state, /families/);
  assert.match(runtime, /readOAuthSecrets\(process\.env\.DEVMATE_CONFIG\)/);
});

test('Capability Host remains the only MCP prototype interception layer', () => {
  const pluginHost = source('gateway/plugins/plugin-host.mjs');
  const extensionHost = source('gateway/server-extension-host.mjs');
  assert.doesNotMatch(pluginHost, /installPluginHost|prototype\.connect|pluginHostInstalled/);
  assert.match(extensionHost, /prototype/);
});
