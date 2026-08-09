# Hardened deployment readiness checklist

Before exposing a shared DevMate Gateway for long-lived remote use:

- Use an intentional public connection: stable ngrok, Cloudflare managed, or an existing external HTTPS ingress when a stable endpoint is required.
- Keep DevMate application authentication enabled behind any edge identity layer.
- Configure `connection.publicUrl` where the selected provider requires a stable origin.
- Configure `requestPolicy.allowedHosts` when the deployment requires an explicit public Host policy.
- Ensure the reverse proxy forwards only the routes you intentionally expose, including `/runner/v1` only when external Runners are enabled.
- Create individual member tokens; reserve the Owner token for administration and recovery.
- Scope every member to the minimum role and workspace set.
- Enable `team.requireWorkspaceLeaseForWrites` when multiple remote principals can mutate the same checkout.
- Configure dual-control approval only where organizational policy requires it, then verify two distinct authorized principals can complete the flow.
- Put the central config and state directory on persistent, access-controlled storage.
- Confirm `deployment_runtime_state` reports an active current instance lock and no recovery warning.
- Ensure only one central DevMate Gateway owns a config/state directory at a time.
- Decide whether embedded execution should remain enabled; verify desired and live Runner state after configuration changes.
- Create a separate `dmr_` credential for every external Runner with explicit workspace scopes, minimum capabilities, bounded concurrency and expiry.
- Never reuse Owner/member tokens on Runner hosts or put a Runner token in `ExecStart`, process arguments, source control or logs.
- Confirm the Runner Agent strips central control-plane secrets from its local Gateway environment.
- Ensure central and Runner-local configs use matching `workspaceId` values for routed workspaces.
- Verify every critical Runner reports the expected version, platform, architecture, capabilities, scopes and recent heartbeat.
- Submit a small external validation job for each critical capability class before routing important work to that Runner.
- Treat remote artifacts as metadata only and use a separate authenticated artifact channel when files must be distributed.
- Document at-least-once execution and require idempotent or transaction-protected job targets.
- Test Runner credential rotation, revocation, lease expiry, offline recovery and duplicate-safe retry behavior.
- Collect `/control/metrics` through a loopback agent or sidecar; never expose it through the public connection.
- Alert on repeated Runner authentication failures, stale heartbeats, lease-expiry loops and prolonged queued/blocked jobs.
- Keep detailed public health output disabled.
- Use dedicated OS accounts and isolate unrelated trust domains in separate instances, containers, VMs or machines.
- Store provider credentials in host-local secure storage or provider configuration and Runner credentials in an approved secret manager or protected file.
- Run `deployment_readiness`, `gateway_self_test`, `deployment_metrics`, `runner_control_status`, `runner_status` and connection diagnostics after changes.
- Verify the public MCP endpoint has passed preflight for the **current complete Gateway + provider session generation**.
- Verify audit, runtime-state and backup retention against organizational policy.
- Back up the complete central config/state directory before upgrades and test restoration on an isolated host.
- Revoke published previews immediately after review.
- Test Owner-token recovery, member-token rotation, stale-lock recovery, approval expiry when approvals are enabled, and control-plane-only startup before relying on the platform operationally.

This checklist hardens a capability composition. There is no `production` runtime mode to select.
