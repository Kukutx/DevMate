# Obsidian runtime troubleshooting

DevMate for Obsidian uses the same shared desktop architecture as VS Code: an isolated Node child Gateway, a provider-native public connection, and generation-aware MCP verification.

There is no embedded Gateway Worker path.

## Runtime requirement

The Gateway requires a Gateway-compatible Node.js 24+ runtime. Obsidian uses the same capability-based resolver as VS Code and evaluates candidates in this order:

1. explicitly configured Node executable;
2. standalone `node` from `PATH`;
3. the Obsidian/Electron executable only as a final Electron-as-Node fallback.

There is no separate version-only eligibility probe. Every candidate must execute the packaged Obsidian Gateway entry in side-effect-free runtime-probe mode. The Gateway itself reports the Node version and executable that actually loaded it, and only a candidate that returns the exact versioned `devmate-gateway-runtime-probe` contract with Node 24+ and platform capabilities can be selected.

If no candidate satisfies the Gateway runtime contract, Start fails with `DEVMATE_GATEWAY_RUNTIME_UNAVAILABLE` diagnostics instead of falling back to a renderer Worker, an older compatibility runtime, or an unverified Electron host.

## Expected Start lifecycle

`DevMate: Start` should converge through:

```text
Obsidian bridge/context
→ verified Gateway runtime
→ shared Gateway start/attach
→ configured public connection start/attach
→ authenticated MCP initialize
→ tools/list
→ Ready
```

`Ready` means the current **Gateway + provider session generation** has passed MCP preflight. `Gateway running`, `attached`, or an HTTPS URL by itself is not Ready.

## Startup problem

Use **Copy diagnostics** before repeatedly changing settings. The report includes bounded/redacted runtime information such as:

- DevMate, Node, Electron, platform, and architecture versions;
- selected Gateway port and child-process launch information;
- provider/connection status;
- bounded stdout/stderr/runtime-log tails;
- the most recent startup/recovery failure;
- shared state/config paths.

Diagnostics do not include note bodies, OAuth material, or provider credentials.

## Local log

The plugin keeps a bounded rotating runtime log under the shared DevMate state directory:

```text
<DevMate state directory>/logs/obsidian-runtime.log
```

Credential-shaped values are redacted before persistence.

## Safe recovery order

1. Press **Start** once.
2. If Start fails, copy diagnostics before changing settings.
3. Confirm a Gateway-compatible Node.js 24+ runtime is available; only the real Gateway contract probe determines compatibility.
4. Confirm the plugin package contains the expected Gateway bundle/runtime files.
5. Run connection diagnostics and verify the configured provider/executable/credential requirements.
6. Change the preferred Gateway port only when diagnostics report a real port conflict.
7. If VS Code is using the same desktop state, verify that Obsidian attaches rather than spawning duplicate resources.

Repeated Restart is not a repair strategy for a missing bundle, invalid current config, missing/incompatible Node runtime, provider credential failure, or incompatible shared provider configuration.

## Gateway is healthy but DevMate is not Ready

This is a public-session problem, not evidence that Start succeeded.

Check:

1. the selected provider has a current compatible runtime record;
2. the public HTTPS origin matches shared connection configuration;
3. the live Gateway lock is present and current;
4. MCP `initialize` and `tools/list` succeed for the complete current session generation.

If the Gateway restarted while the provider stayed on the same hostname, old verification is intentionally stale. DevMate must preflight the new Gateway generation before Ready returns.

## Shared VS Code / Obsidian ownership

Both desktop hosts can own or attach to the same Gateway and provider connection.

- An attached Obsidian host does not terminate another host's owned compatible resource.
- An Obsidian-owned Gateway is stopped on unload/Stop even if the public provider is owned elsewhere; another host that still requests the session recovers the missing Gateway through the normal Start lifecycle.
- A provider stop that cannot be confirmed fails closed rather than tearing down a dependent local side blindly.

If ownership appears inconsistent, compare the shared state directory and current owner records in diagnostics rather than manually killing arbitrary Node/provider processes first.

## Plugin package is incomplete

Reinstall the complete current plugin artifact when the bundled Gateway/runtime files are missing or damaged. Do not copy individual files from older plugin versions into a current install; mixed-version runtime files are unsupported.

## Config is rejected

Current hosts accept the current supported instance schema only. Unsupported versions or historical instance fields fail closed rather than being translated during startup.

Restore/replace the config through a supported bootstrap/current-version path. Do not hand-add historical `deployment`, `production`, or `team.enabled` fields to make an old guide work.
