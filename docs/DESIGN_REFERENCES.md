# DevMate design references

Reviewed on 2026-10-06, 2026-10-07 and 2026-10-09. The current implementation is the DevMate 4 local runtime, fresh SQLite state, explicit capability composition and shared workbench described in the [README](../README.md). What was audited, fixed and left unverified is recorded in [AUDIT-4.0.md](AUDIT-4.0.md).

## Official protocols and UI

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): use the official client, server and Node transports. Preserve native tool schemas, structured results, resources, content blocks, cancellation and form elicitation. DevMate's own HTTP endpoint uses the current protocol; configured third-party clients negotiate through the official SDK.
- [MCP Apps specification and SDK](https://github.com/modelcontextprotocol/ext-apps): the workbench imports the official App implementation. It uses the standard UI tool and context channels. The reviewed production dependency addition is exactly `@modelcontextprotocol/ext-apps@2.0.3`.
- [OpenAI plugin extensions](https://developers.openai.com/plugins/build/extensions): declare global and thread entrypoints on the workbench tool and serve the registered MCP App resource. This supports the sidebar/fullscreen product shape requested for DevMate. Actual installation and availability depend on the user's ChatGPT account and a reachable MCP connection.
- [OpenAI secure MCP tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [official tunnel-client](https://github.com/openai/tunnel-client): own only the explicitly configured native tunnel process. Use a real tunnel ID and an environment reference for its runtime credential. Local relay readiness and successful remote MCP verification remain distinct facts.

## Native execution and communication

The execution interfaces are [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code structured CLI](https://code.claude.com/docs/en/cli-reference), [Gemini ACP](https://geminicli.com/docs/cli/acp-mode/) and [Grok ACP](https://docs.x.ai/build/cli/headless-scripting). [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) was also reviewed as an official reference for explicit peers and message delivery.

DevMate provides scoped MCP communication tools to the native sessions it owns. Messages, per-recipient deliveries and native execution jobs are separate records. A durable inbox alone does not establish successful delivery. Requests return the actual provider outcome, approval or question; unresolved outcomes are not automatically replayed.

The adapters preserve the providers' different capabilities. A missing steering or attachment mechanism is reported as unavailable. Daily use of one provider does not establish a preferred DevMate provider, and credentials or subscription entitlements are not translated between vendors.

## WebCodex

[Repository](https://github.com/yyjeqhc/webcodex)

Reviewed its workbench, workflow/session separation, durable delivery and handoff patterns. DevMate adopts explicit project/workflow selection, separate task and execution records, bounded reference/context selection, exact session correlations and visible delivery outcomes.

The DevMate 4 implementation uses its own service, SQLite records and native adapters. It does not embed WebCodex source or promise feature parity with its changing development branch.

## ThreadCrew

[Repository](https://github.com/ryan-eziar/ThreadCrew)

Reviewed cross-agent rooms, message coordination and workflow limits. DevMate applies scoped peers, visible turn budgets, per-agent serialized delivery and explicit pause/resume controls. Shared writes and autonomous message loops require observable execution state.

Private desktop process injection is outside the selected implementation. A transport must have a documented native entrypoint before DevMate uses it.

## Desktop Commander MCP

[Repository](https://github.com/wonderwhy-er/DesktopCommanderMCP)

Reviewed its filesystem/search tools, incremental command output, process/session handling, file preview/editor UI and remote MCP setup. Its public documentation describes both local MCP use and remote access from AI web clients; remote use includes its own device/account connection.

DevMate can compose a separately installed Desktop Commander or another configured MCP server through its standard external MCP client. This is optional owner configuration; the third-party server is not bundled into DevMate, silently installed, or treated as a provider-native executor. The external client's protocol behavior was tested with real official MCP transports; an actual Desktop Commander installation was not part of this validation.

A configured server has its own credentials and resource scope. DevMate therefore restricts external discovery and calls to the owner. Project IDs and a child working directory cannot constrain an independently privileged third-party server to one project. Desktop Commander's own [security policy](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/SECURITY.md) also distinguishes tool guardrails from an operating-system sandbox.

## Glama MCP Proxy

[Repository](https://github.com/punkpeye/mcp-proxy)

The current project supports `--tunnel` as well as stdio-to-HTTP proxying. It is incorrect to dismiss it as having no tunnelling capability.

Its documented shared-upstream behavior and server-to-client request limitations matter to per-session approvals, form elicitation and identity. DevMate uses direct official SDK connections and owned native sessions for those responsibilities. A public tunnel feature by itself does not establish unlimited traffic, independent hosting, per-user authorization or correct agent scheduling.

## Self-hosted connection components

[OpenSSH client](https://man.openbsd.org/ssh.1) and [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

For a user with their own server and domain, DevMate can launch native OpenSSH reverse forwarding to a loopback listener on that server, with Caddy providing HTTPS. DevMate owns the specific child process and uses strict host-key checking, non-interactive authentication and an explicit forwarding destination.

This reuses maintained system tools and keeps self-hosting optional. The local configuration, native SSH argument parsing and owned-process lifecycle were tested. A real VPS, TLS deployment and remote ChatGPT connection have not been supplied or verified. Self-hosting changes who operates the network; it does not remove model account quotas.

## Obsidian knowledge capabilities

[Official sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin), [Obsidian API](https://github.com/obsidianmd/obsidian-api), [Dataview](https://github.com/blacksmithgu/obsidian-dataview) and [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) informed the retained native Vault tools.

Use public Vault, MetadataCache, FileManager and workspace events. Keep Markdown and Properties as the source data; maintain an incremental query projection; preview large mutation batches and persist their operation records before applying them. DevMate does not embed Dataview or depend on its query language. Its SQLite operation records belong to the DevMate runtime and do not replace the user's vault.

## Following upstream

Keep SDK versions explicit, monitor official releases through the repository dependency workflow, and run protocol, authorization, UI and native-process regressions before accepting an update. Report the exact local CLI versions actually checked. A new upstream release, installed executable or connected transport alone is not proof that an account can execute a model turn.

If an official extension surface later covers a DevMate responsibility with the same required behavior, replace that responsibility with the supported integration. Retain the small project/workflow domain layer only where it provides an actual missing capability.
