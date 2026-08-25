from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    source = p.read_text(encoding='utf-8')
    found = source.count(old)
    if found != count:
        raise SystemExit(f'{path}: expected {count} matches, found {found}: {old[:160]!r}')
    p.write_text(source.replace(old, new), encoding='utf-8')


replace(
    'tests/config-policy-invariants.test.cjs',
    "    assert.equal(before.auth.mode, 'oauth');\n    assert.equal(authenticationPolicyGeneration(before), 0, 'establishing the default OAuth policy must not manufacture a transition');",
    "    assert.equal(before.auth.mode, 'none');\n    assert.equal(authenticationPolicyGeneration(before), 0, 'establishing the default single-owner no-auth policy must not manufacture a transition');",
)
replace(
    'tests/config-policy-invariants.test.cjs',
    "      configureAuthentication(config, 'none', { replace: true });",
    "      configureAuthentication(config, 'oauth', { replace: true });",
)
replace(
    'tests/config-policy-invariants.test.cjs',
    "    assert.equal(authenticationPolicyGeneration(updated), 1, 'one OAuth -> none transition advances exactly once');",
    "    assert.equal(authenticationPolicyGeneration(updated), 1, 'one none -> OAuth transition advances exactly once');",
)

# Obsidian documentation: personal/single-owner is none everywhere; OAuth is only the team/member identity mode.
replace('obsidian-plugin/README.md', '  → MCP server/discover verified with OAuth for public ingress', '  → MCP server/discover verified for the configured authentication mode')
replace('obsidian-plugin/README.md', 'Public MCP defaults to OAuth; no-auth is limited to trusted loopback access.', 'Single-owner MCP defaults to no authentication for both local and public ingress; OAuth is for team/member identity.')
replace('obsidian-plugin/README.md', '- `auth.mode: "oauth"` is the desktop/public default.', '- `auth.mode: "oauth"` is opt-in for team/shared member identity.')
replace('obsidian-plugin/README.md', '- `auth.mode: "none"` is an explicit loopback-only option; remote requests are rejected rather than promoted to owner.', '- `auth.mode: "none"` is the default single-owner mode for both local and public MCP ingress.')
replace('obsidian-plugin/README.md', 'External is for an existing reverse proxy, load balancer, VPN endpoint, or separately managed tunnel. DevMate does not spawn an ingress child process, but it still coordinates shared connection ownership and requires MCP 2026 verification with OAuth before public Ready.', 'External is for an existing reverse proxy, load balancer, VPN endpoint, or separately managed tunnel. DevMate does not spawn an ingress child process, but it still coordinates shared connection ownership and requires current MCP 2026 verification before public Ready.')
replace('obsidian-plugin/README.md', '- **Authentication mode** — OAuth is the public default; `none` is loopback-only', '- **Authentication mode** — `none` is the single-owner default; OAuth is for team/shared identity')

# Host integration contract.
replace('docs/HOST_INTEGRATION.md', '  → MCP server/discover succeeds with OAuth on public ingress', '  → MCP server/discover succeeds under the configured authentication mode')
replace('docs/HOST_INTEGRATION.md', '    "mode": "oauth"', '    "mode": "none"')
replace('docs/HOST_INTEGRATION.md', 'Desktop public MCP defaults to OAuth. `auth.mode: "none"` is an explicit trusted-loopback-only option and does not authorize remote requests. OAuth signing material and owner approval codes are host-private state, not public config fields.', 'Desktop MCP defaults to `auth.mode: "none"` for the single owner on both local and public ingress. `auth.mode: "oauth"` is opt-in for team/shared member identity. OAuth signing material and owner approval codes are host-private state, not public config fields.')
replace('docs/HOST_INTEGRATION.md', '6. Obtain a short-lived OAuth owner access token from private state for public preflight.', '6. When `auth.mode: "oauth"` is enabled, obtain a short-lived OAuth owner access token from private state for public preflight; `none` requires no token.')
replace('docs/HOST_INTEGRATION.md', 'Trusted loopback requests may use explicit `auth.mode: "none"`, but that local convenience is not the public desktop connection path. No normal Start requires the user to manually start a tunnel, copy an internal Gateway URL, or run a separate verification command.', 'Single-owner local and public MCP requests use `auth.mode: "none"` by default. OAuth is only required when team/shared member identity is enabled. No normal Start requires the user to manually start a tunnel, copy an internal Gateway URL, or run a separate verification command.')
replace('docs/HOST_INTEGRATION.md', '`Restart` operates on the complete product lifecycle, not only the Gateway. It returns to Ready only after the current complete generation passes MCP 2026 preflight with OAuth on public ingress.', '`Restart` operates on the complete product lifecycle, not only the Gateway. It returns to Ready only after the current complete generation passes MCP 2026 preflight under the configured authentication mode.')
replace('docs/HOST_INTEGRATION.md', 'The copied URL contains no credential. Public ChatGPT connections authenticate with OAuth against the DevMate authorization server. `auth.mode: "none"` remains available only for trusted loopback MCP and cannot authorize a remote request. Static owner/member Bearer tokens and credential query parameters are not supported.', 'The copied URL contains no credential. Single-owner public ChatGPT connections use `auth.mode: "none"` without a token; OAuth is used only for team/shared member identity. Static owner/member Bearer tokens and credential query parameters are not supported.')
replace('docs/HOST_INTEGRATION.md', '4. Start is Gateway → public connection → MCP 2026 preflight with OAuth → Ready.\n5. Public Ready requires OAuth; no-auth is limited to trusted loopback access.', '4. Start is Gateway → public connection → MCP 2026 preflight → Ready.\n5. Single-owner public MCP defaults to `auth.mode: "none"`; OAuth is required only for team/shared member identity.')

# Public connection / tunnel contract.
replace('docs/TUNNELS.md', 'Public MCP defaults to OAuth. `auth.mode: "none"` is a trusted-loopback-only option and does not authorize requests arriving through ngrok, Cloudflare, external HTTPS ingress, or another remote/public path.', 'Single-owner public MCP defaults to `auth.mode: "none"` and accepts the owner through ngrok, Cloudflare, external HTTPS ingress, or another configured public path. OAuth is opt-in for team/shared member identity.')
replace('docs/TUNNELS.md', 'Desktop and standalone public-capable configurations default to OAuth. Provider selection never weakens the authentication boundary.', 'Desktop and standalone personal configurations default to `none`; team/member identity uses OAuth. Provider selection does not silently change the authentication mode.')
replace('docs/TUNNELS.md', '  → obtain short-lived OAuth verification token', '  → obtain authentication material only when the configured mode requires it')
replace('docs/TUNNELS.md', '1. Obtain a short-lived OAuth owner access token from protected local state.\n2. Send `server/discover` with protocol pin `2026-07-28`.', '1. If `auth.mode: "oauth"` is enabled, obtain a short-lived OAuth owner access token from protected local state; `none` uses no token.\n2. Send `server/discover` with protocol pin `2026-07-28`.')
replace('docs/TUNNELS.md', 'Explicit `auth.mode: "none"` remains valid for trusted loopback-only MCP workflows, but those local calls are not public-generation verification and cannot authorize a remote request.', '`auth.mode: "none"` is valid for both local and public single-owner MCP workflows. Public-generation verification uses the same mode configured for the instance.')
replace('docs/TUNNELS.md', 'The endpoint is dynamic and has no stable shared `publicUrl`. A new provider generation therefore requires a fresh OAuth-authenticated MCP 2026 preflight and may produce a new hostname.', 'The endpoint is dynamic and has no stable shared `publicUrl`. A new provider generation therefore requires a fresh MCP 2026 preflight under the configured authentication mode and may produce a new hostname.')
replace('docs/TUNNELS.md', 'DevMate does not spawn an ingress process for this provider. It still creates and owns/attaches the same shared connection record and requires OAuth-authenticated current MCP preflight before Ready.', 'DevMate does not spawn an ingress process for this provider. It still creates and owns/attaches the same shared connection record and requires current MCP preflight under the configured authentication mode before Ready.')

# Documentation test now locks the intended product rule instead of the 3.6.0 regression.
p = Path('tests/desktop-public-mcp-doc-contract.test.cjs')
p.write_text("""'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('desktop documentation describes one complete provider-neutral MCP 2026 lifecycle with single-owner public no-auth', () => {
  const obsidian = source('obsidian-plugin/README.md');
  const host = source('docs/HOST_INTEGRATION.md');
  const tunnels = source('docs/TUNNELS.md');

  assert.match(obsidian, /Gateway started or attached[\\s\\S]*public connection started or attached[\\s\\S]*MCP server\\/discover verified for the configured authentication mode[\\s\\S]*tools\\/list verified[\\s\\S]*gateway_status tools\\/call verified[\\s\\S]*Ready/i);
  assert.match(obsidian, /Both hosts are first-class owners or attachers/i);
  assert.match(obsidian, /complete.*runtime generation/i);
  assert.match(obsidian, /Copy MCP URL.*current complete runtime generation/is);
  assert.match(obsidian, /MCP 2026 verification is stateless/i);
  assert.match(obsidian, /Single-owner MCP defaults to no authentication for both local and public ingress; OAuth is for team\\/member identity/i);
  assert.doesNotMatch(obsidian, /OAuth is the public default|loopback-only option; remote requests are rejected/i);
  assert.doesNotMatch(obsidian, /MCP\\s+`?initialize`?|MCP-Session-Id|mcp-session-id/i);

  assert.match(host, /Both VS Code and Obsidian can own or attach/i);
  assert.match(host, /Start is Gateway → public connection → MCP 2026 preflight → Ready/i);
  assert.match(host, /Ready is complete-generation scoped, never URL-only or tunnel-only/i);
  assert.match(host, /Gateway restart[\\s\\S]*provider restart/i);
  assert.match(host, /MCP 2026 verification is stateless/i);
  assert.match(host, /Single-owner public MCP defaults to `auth.mode: "none"`; OAuth is required only for team\\/shared member identity/i);
  assert.match(host, /Desktop MCP defaults to `auth.mode: "none"` for the single owner on both local and public ingress/i);
  for (const provider of ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']) {
    assert.match(host, new RegExp(provider.replace('-', '\\\\-')));
  }

  assert.match(tunnels, /one shared public connection capability/i);
  assert.match(tunnels, /shared instance selects exactly one provider/i);
  assert.match(tunnels, /Both desktop hosts can own or attach/i);
  assert.match(tunnels, /complete desktop generation/i);
  assert.match(tunnels, /Gateway \\+ provider generation/i);
  assert.match(tunnels, /The MCP transport is stateless/i);
  assert.match(tunnels, /Single-owner public MCP defaults to `auth.mode: "none"`/i);
  assert.match(tunnels, /team\\/shared member identity/i);
  assert.match(tunnels, /current local Agent endpoint API/i);
  assert.match(tunnels, /web_addr/);
});
""", encoding='utf-8')

print('final 3.6.1 policy invariants and docs aligned')
