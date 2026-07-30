# Production readiness checklist

Before exposing a shared DevMate gateway:

- Select `production` mode.
- Use a stable ngrok, Cloudflare managed, or external HTTPS ingress.
- Keep DevMate bearer authentication enabled behind the edge identity layer.
- Configure `publicUrl` and every accepted public Host.
- Create individual member tokens; reserve the owner token for administration and recovery.
- Scope each principal to the minimum workspace set and role.
- Keep workspace leases enabled for write, execution, Git, and publish operations.
- Keep detailed public health disabled.
- Use a dedicated OS account and isolate unrelated trust domains in separate instances, containers, VMs, or machines.
- Store tunnel credentials in VS Code Secret Storage or service environment variables.
- Run `deployment_readiness`, `gateway_self_test`, and tunnel diagnostics after changes.
- Verify audit and backup retention against organizational policy.
- Revoke published previews immediately after review.
- Test owner-token recovery and team-token rotation before relying on the gateway operationally.
