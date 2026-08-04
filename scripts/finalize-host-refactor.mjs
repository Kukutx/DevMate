#!/usr/bin/env node
import fs from 'node:fs';

function insertBefore(file, marker, heading, insertion) {
  const current = fs.readFileSync(file, 'utf8');
  if (current.includes(heading)) return;
  const index = current.indexOf(marker);
  if (index < 0) throw new Error(`Missing marker ${marker} in ${file}`);
  fs.writeFileSync(file, `${current.slice(0, index)}${insertion}\n${current.slice(index)}`, 'utf8');
}

const changelogFile = 'CHANGELOG.md';
let changelog = fs.readFileSync(changelogFile, 'utf8');
if (!changelog.includes('\n## 3.0.0\n')) {
  const release = `## 3.0.0

- Refactored the shared desktop host runtime into focused state-path, configuration, network, and process-controller modules while preserving the existing compatibility entry point.
- Refactored the Obsidian plugin into lifecycle, settings, context, view, bridge server, index, operation, plan, path-policy, and note-action modules.
- Added an incremental bounded vault index with note queries, tag/Property/date selectors, deterministic pagination, link metrics, and Property schema diagnostics.
- Added transaction-style batch Property workflows with preview plans, per-note content hashes, expiry, all-note preflight, automatic failure rollback, explicit reverse rollback, and bounded operation history.
- Added workspace-bound Host Bridge protocol and capability negotiation, timing-safe loopback authentication, stronger request lifecycle handling, and .obsidian mutation blocking.
- Added Obsidian release metadata and bundle contracts, versions.json, deterministic required assets, expanded policy/unit coverage, and refreshed host integration documentation.

`;
  if (!changelog.startsWith('# Changelog\n\n')) throw new Error('Unexpected changelog header');
  changelog = `# Changelog\n\n${release}${changelog.slice('# Changelog\n\n'.length)}`;
  fs.writeFileSync(changelogFile, changelog, 'utf8');
}

insertBefore('README.md', '## Deployment shapes', '## Obsidian setup', `## Obsidian setup

DevMate also ships a desktop-only Obsidian host. Build it with \`npm run build:obsidian\`, copy \`obsidian-plugin/dist\` into \`<Vault>/.obsidian/plugins/devmate/\`, and enable it under Community Plugins. The host provides incremental note queries, Property schema audits, public-API note mutations, and preview/apply/rollback Property batches while sharing one Gateway with VS Code.

See [\`docs/HOST_INTEGRATION.md\`](docs/HOST_INTEGRATION.md) and [\`docs/OBSIDIAN_DATA_WORKFLOWS.md\`](docs/OBSIDIAN_DATA_WORKFLOWS.md).
`);

insertBefore('docs/MCP_TOOLS.md', '## Capability plugins and automation', '## Obsidian knowledge tools', `## Obsidian knowledge tools

Generic host context:

- \`host_context_list\`
- \`host_context\`

Indexed read and audit operations:

- \`obsidian_status\`
- \`obsidian_note_query\`
- \`obsidian_schema_audit\`
- \`obsidian_vault_audit\`
- \`obsidian_properties_batch_list\`
- \`obsidian_operation_list\`

Public-API note mutations:

- \`obsidian_note_create\`
- \`obsidian_properties_update\`
- \`obsidian_note_move\`
- \`obsidian_note_trash\`
- \`obsidian_operation_rollback\`

Transaction-style Property batches:

- \`obsidian_properties_batch_preview\`
- \`obsidian_properties_batch_apply\`
- \`obsidian_properties_batch_rollback\`

Preview is a bounded validation operation; apply and rollback require write permission and remain workspace-scoped. See \`OBSIDIAN_DATA_WORKFLOWS.md\`.
`);

insertBefore('docs/ARCHITECTURE.md', '## State and configuration', '## Desktop host platform', `## Desktop host platform

VS Code and Obsidian share a workspace-derived state directory and one Gateway instance. The shared runtime separates state paths, locked config persistence, loopback discovery, and process ownership. Host adapters publish bounded context; Obsidian additionally exposes a workspace-bound authenticated loopback bridge for public-API note operations.

The Obsidian host maintains an incremental read-oriented metadata index and separates queries from transaction-style mutation plans. Batch Property changes require preview, expiry, content-hash preflight, bounded operation records, and reverse rollback.
`);

process.stdout.write('Finalized DevMate 3.0.0 release documentation.\n');
