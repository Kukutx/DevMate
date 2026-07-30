# Production readiness checklist

Before exposing a shared DevMate Gateway:

- Select `production` mode.
- Use a stable ngrok, Cloudflare managed, or external HTTPS ingress.
- Keep DevMate application authentication enabled behind the edge identity layer.
- Configure `publicUrl` and every accepted public Host.
- Ensure the reverse proxy forwards both `/mcp` and `/runner/v1` when external Runners are enabled.
- Create individual member tokens; reserve the Owner token for administration and recovery.
- Scope each principal to the minimum workspace set and role.
- Keep workspace leases enabled for write, execution, Git, and publish operations.
- Keep dual-control approval enabled for `publish` and `admin`; verify two distinct maintainers can complete the flow.
- Put the central config and state directory on persistent, access-controlled storage.
- Confirm `deployment_runtime_state` reports an active instance lock and no recovery warning.
- Ensure only one central DevMate process uses a config/state directory.
- Decide whether the central embedded Runner should remain enabled. Restart after changing `embeddedRunnerEnabled`.
- Create a separate `dmr_` credential for each Runner host with explicit workspace scopes, minimum capabilities, bounded concurrency, and expiry.
- Never reuse Owner/member tokens on Runner hosts and never put a Runner token in `ExecStart`, process arguments, source control, or logs.
- Confirm the Runner Agent strips control-plane variables from its local Gateway environment.
- Ensure central and Runner-local configs use the same `workspaceId` for each routed workspace.
- Verify every critical Runner reports the expected version, platform, architecture, capabilities, scopes, and recent heartbeat.
- Submit a small `external` validation job for each critical capability class before routing production work.
- Treat remote artifacts as metadata only and configure a separate authenticated artifact service when files must be distributed.
- Document at-least-once execution and require idempotent or transaction-protected job targets.
- Test Runner credential rotation, revocation, lease expiry, offline recovery, and duplicate-safe retry behavior.
- Collect `/control/metrics` through a loopback agent or sidecar; never expose it through the public tunnel.
- Alert on repeated Runner authentication failures, stale heartbeats, lease-expiry loops, and prolonged queued/blocked jobs.
- Keep detailed public health disabled.
- Use dedicated OS accounts and isolate unrelated trust domains in separate instances, containers, VMs, or machines.
- Store tunnel credentials in VS Code Secret Storage or service environments and Runner credentials in an approved secret manager or protected file.
- Run `deployment_readiness`, `gateway_self_test`, `deployment_metrics`, `runner_control_status`, `runner_status`, and tunnel diagnostics after changes.
- Verify audit, runtime-state, and backup retention against organizational policy.
- Back up the complete central config/state directory before upgrades and test restoration on an isolated host.
- Revoke published previews immediately after review.
- Test Owner-token recovery, team-token rotation, stale-lock recovery, approval expiry, and control-plane-only startup before relying on the platform operationally.
