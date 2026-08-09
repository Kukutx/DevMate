# Maintainability contracts

This document defines the rules for extending DevMate without recreating duplicated policy, hidden lifecycle chains, retired compatibility layers, or manual CI drift.

## Core invariants

1. `server-extension-host.mjs` is the only MCP class interception layer.
2. `tool-policy.mjs` is the only authorization and durable-target policy catalog.
3. Every tool registration has complete metadata and a unique name.
4. Optional features are plugins, not conditionals spread through the core server.
5. Plugin layers use `extendPlugin()` rather than manually calling another plugin lifecycle.
6. Durable Job execution invokes the same registered handler used by synchronous MCP calls.
7. Workspace paths are realpath-contained; credentials never belong in Job arguments or artifacts.
8. Config and durable state writes are atomic.
9. Future durable-state versions are never silently normalized backwards.
10. Source and test discovery is automatic; adding a file must not require editing a CI filename list.
11. Current product contracts are preserved during refactors; retired implementation entry points are removed rather than kept as indefinite compatibility shims.

## Adding an MCP tool

Register the tool at the capability that owns the behavior. Do not add tools directly from unrelated modules.

Required registration shape:

```js
server.registerTool('example_status', {
  title: 'Example status',
  description: 'Inspect the example without changing it.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}, handler);
```

Then update `tool-policy.mjs` only when the annotations are not sufficient or the tool belongs to one of these explicit groups:

- Owner/Admin operation;
- publish operation;
- bounded validation that creates temporary/artifact outputs;
- general execution;
- explicit workspace mutation;
- global/non-workspace operation;
- durable Job target.

Add a policy test for security-sensitive classification changes.

The registration contract rejects missing title, description, input schema, incomplete annotation booleans and duplicate names.

## Adding a durable Job target

A tool is not queueable merely because it is safe synchronously. Add it to `JOB_TARGET_POLICIES` only after reviewing:

- arguments are bounded and credential-free;
- execution can tolerate MCP disconnects;
- retry behavior is safe or the operation is idempotent;
- artifact paths remain inside the workspace;
- external side effects use operation IDs or are not retried;
- required Runner capabilities are explicit;
- the owning optional plugin is declared.

Example:

```js
example_check: jobPolicy(['core', 'example-runtime'], 'devmate.example')
```

Do not infer capabilities only from a tool prefix. A browser-driven Godot operation and a native Godot operation have different scheduling requirements even though both begin with `godot_`.

The policy contract test verifies that every Job policy names a literal registered tool.

## Adding or extending a plugin

Create a base plugin with `definePlugin()`. Extend an existing plugin with `extendPlugin()`:

```js
export const advancedPlugin = extendPlugin(basePlugin, {
  version: '1.1.0',
  description: 'Base behavior plus advanced checks.',
  capabilities: ['advanced-checks'],
  async activate(context) {
    // Register only this layer's tools.
  },
  async diagnose(context, baseResult) {
    return { ...baseResult, advanced: true };
  }
});
```

Do not:

- spread the base manifest manually;
- call `base.activate()` yourself;
- copy base settings into the extension;
- reuse a different plugin ID;
- change the plugin API version in an extension.

`extendPlugin()` merges manifest collections, composes diagnostics, activates base first and deactivates extensions first.

The built-in catalog should export only the final composed plugin for a stable plugin ID.

## Capability Host ordering

Orders are architectural contracts:

| Order | Extension |
|---:|---|
| 0 | registration contract |
| 10 | team authorization decorator |
| 20 | team/Job registration and capture |
| 30 | Runner management |
| 35 | trusted roots and persistent processes |
| 40 | plugin host |

A new decorator or initializer needs an explicit order and an explanation in `ARCHITECTURE.md`. It must not patch `McpServer.prototype` independently.

## State changes

### Config

Use the shared config-store/read-write boundary. Do not write `config.json` directly from Gateway or host modules.

The current instance schema is current-only: unsupported historical instance fields fail closed instead of being translated during ordinary startup. Do not add same-version shape adapters, old field aliases, or fallback readers merely to keep retired implementation shapes alive.

Keep plaintext credentials out of config. Hash scoped team/Runner tokens; store host-managed provider tokens in the host's secure credential store.

### Durable state

When a durable document version genuinely changes across a release boundary:

1. increment the durable document version;
2. decide explicitly whether that release owns a bounded one-way migration from the immediately previous supported version;
3. if a migration is required, isolate it at the version boundary and test it directly;
4. never retain the migration as a permanent alternate runtime path after the supported transition window;
5. retain rejection of unknown future versions;
6. document downgrade behavior.

Never reinterpret a future-version document as the current version. Never quarantine a syntactically valid future document as corruption. A durable-state migration is a release/version transition mechanism, not permission to maintain indefinite compatibility shims throughout runtime code.

## Filesystem changes

All user-supplied paths must resolve through the workspace runtime. Validate both lexical containment and existing-parent realpath containment. Generated reports and artifacts follow the same rule.

Mutations that replace reviewed project files should:

- create a backup when appropriate;
- write a sibling temporary file;
- rename atomically;
- return workspace-relative paths;
- include artifact paths only for intended outputs.

## Tests

Normal tests are named:

```text
tests/**/*.test.js
tests/**/*.test.mjs
tests/**/*.test.cjs
```

They are discovered automatically by `scripts/run-tests.mjs`. Files beginning with `godot-real-` are reserved for the dedicated real-engine CI job and are excluded from normal unit batches.

JavaScript source is discovered automatically by `scripts/check-repository.mjs`. Generated bundles, dependencies, build outputs and real-engine caches are excluded.

For a new capability, cover at least:

- success;
- invalid input;
- containment/security failure;
- permission classification;
- restart/persistence behavior when stateful;
- preservation of the current public/product contract when replacing an implementation.

When replacing an implementation, tests should assert the intended current behavior and safety invariants. Do not keep tests whose only purpose is proving that a retired internal interface, field alias, file path, or implementation name is still understood.

Avoid tests whose success depends on random token characters or host-specific path aliases.

## Documentation ownership

- `README.md`: first-run path and product-level capability summary.
- `ARCHITECTURE.md`: current runtime boundaries and data flow.
- `MAINTAINABILITY.md`: extension rules and invariants.
- `MCP_TOOLS.md`: public tool surface.
- `SECURITY.md`: threat/trust boundary.
- focused workflow documents: detailed operational use.
- `CHANGELOG.md`: historical release-visible behavior, migrations and compatibility.

Current architecture/workflow documents describe only current supported behavior. Historical terminology belongs in `CHANGELOG.md`, not in current operational guidance.

When implementation changes an architectural statement, update the architecture document in the same change.

## Release checklist

Before release/merge:

1. review the diff for unexpected whole-file rewrites and accidental compatibility paths;
2. run `npm run check`;
3. run `npm run test:unit`;
4. run Gateway smoke tests;
5. package and smoke-test the VSIX and Obsidian artifacts;
6. run real Godot CI when Godot code or generated GDScript changes;
7. verify the exact head SHA matches the successful workflow;
8. publish only artifacts built from that verified head.

## Deliberate non-goals

Do not blur these boundaries without a separate architecture proposal:

- multiple active central Gateways sharing JSON state;
- hostile multi-tenancy inside one OS account;
- implicit platform signing or store publication;
- arbitrary external Runner shell execution;
- automatic performance-baseline replacement;
- automatic release-gate remediation.

Those require transactional external state, stronger sandboxing, organization credentials or product-specific release workflows rather than additional generic MCP tools.
