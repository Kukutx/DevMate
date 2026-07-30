# Production readiness checklist

Before exposing a shared DevMate gateway:

- Select `production` mode.
- Use a stable ngrok, Cloudflare managed, or external HTTPS ingress.
- Keep DevMate bearer authentication enabled behind the edge identity layer.
- Configure `publicUrl` and every accepted public Host.
- Create individual member tokens; reserve the owner token for administration and recovery.
- Scope each principal to the minimum workspace set and role.
- Keep workspace leases enabled for write, execution, Git, and publish operations.
- Keep dual-control approval enabled for `publish` and `admin`; verify two distinct maintainers can complete the flow.
- Put the config and state directory on persistent, access-controlled storage.
- Confirm `deployment_runtime_state` reports an active instance lock and no recovery warning.
- Ensure only one DevMate process uses a config/state directory.
- Collect `/control/metrics` through a loopback agent or sidecar; never expose it through the public tunnel.
- Keep detailed public health disabled.
- Use a dedicated OS account and isolate unrelated trust domains in separate instances, containers, VMs, or machines.
- Store tunnel credentials in VS Code Secret Storage or service environment variables.
- Run `deployment_readiness`, `gateway_self_test`, `deployment_metrics`, and tunnel diagnostics after changes.
- Verify audit, runtime-state, and backup retention against organizational policy.
- Back up the complete config/state directory before upgrades and test restoration on an isolated host.
- Revoke published previews immediately after review.
- Test owner-token recovery, team-token rotation, stale-lock recovery, and approval expiry before relying on the gateway operationally.
