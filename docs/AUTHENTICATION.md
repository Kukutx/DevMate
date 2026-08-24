# Authentication policy

DevMate supports two current MCP 2026 authentication modes: OAuth by default, plus an explicit loopback-only `none` mode. There is no static MCP credential mode.

## Security boundary

- `auth.mode: "oauth"` is the default and is required for remote/public MCP ingress.
- `auth.mode: "none"` is limited to trusted loopback MCP access.
- Loopback requests remain frictionless and receive the local owner principal.
- Remote requests are never promoted to owner because authentication is disabled; a remote request without valid OAuth authorization is rejected.
- When OAuth is enabled, access tokens use the standard `Authorization: Bearer <access-token>` header. DevMate does not expose a user-configured static MCP Bearer credential.
- Host allowlisting, ingress provider configuration, TLS, and authentication are separate controls; none substitutes for another.

## OAuth 2026 flow

DevMate implements the current MCP OAuth profile directly:

1. The MCP client discovers `/.well-known/oauth-protected-resource/mcp`.
2. The resource metadata identifies the DevMate authorization server and MCP resource.
3. The client uses an HTTPS Client ID Metadata Document (CIMD) as its `client_id`.
4. DevMate fetches that document only from public HTTPS destinations, validates all resolved addresses before connecting, pins the request to a validated address, enforces TLS hostname verification, follows no redirects, and applies response size/time bounds.
5. Authorization Code + PKCE S256 is mandatory.
6. Authorization and token requests bind to the exact `/mcp` `resource`.
7. Authorization responses include `iss`, and authorization-server metadata declares issuer-response support.
8. Access tokens are short-lived and bound to issuer and MCP resource audience.
9. `offline_access` is an authorization-server capability, not a protected-resource requirement.
10. Refresh tokens belong to a durable token family. Every successful refresh advances the family generation.
11. Replay of an older generation, binding mismatch, or expiration persistently revokes the family.
12. `/oauth/revoke` can revoke an active refresh family.

Dynamic Client Registration and OpenID-provider aliases are not implemented. DevMate has one client-registration model: CIMD.

## Owner authorization

When OAuth is enabled, the host creates a high-entropy owner approval code in the instance's protected state directory. The code is never stored in `config.json`.

Use **DevMate: Copy OAuth Approval Code** only when the DevMate authorization page asks for it. A successful owner authorization rotates that code immediately. Authorization-code redemption is one-time and durably tracked, so a Gateway restart cannot make an issued code reusable.

Desktop public preflight does not expose this code to MCP. It creates a short-lived owner access token from private instance state and uses that token only to verify the current public Gateway/provider generation.

## Member authorization and RBAC

A DevMate member receives an OAuth login code with the `dmc_` prefix. The login code is an authorization-page credential; it is never accepted directly by `/mcp`.

Successful member authorization issues normal OAuth access/refresh tokens whose subject is `member:<id>`. On every MCP request DevMate resolves that subject against current member state and rechecks:

- member existence and enabled state;
- expiration;
- current role;
- current workspace scope;
- current `authVersion`.

Rotating a member login code increments `authVersion`, immediately invalidating existing member OAuth credentials. Disabling, revoking, expiring, changing scope, or changing authorization version also makes stale authorization unusable.

Standalone `member-create` and `member-rotate` do not silently weaken the selected authentication mode. Public-capable configurations should retain OAuth.

## Secret storage

`config.json` contains only the authentication mode and non-plaintext identity metadata. OAuth signing material and the owner approval code live under the instance state directory with restrictive permissions, file locking, bounded reads, crash-safe replacement recovery, and atomic replacement.

Member login-code verifiers and Runner credential verifiers remain one-way stored in configuration. Plaintext member login codes and Runner credentials are returned only at creation/rotation boundaries and must not be committed to a repository or placed in MCP URLs.

## Invariants

- Credentials are never accepted from URL query parameters.
- Public/remote MCP requires OAuth.
- No-auth is trusted-loopback-only and cannot authorize a remote request.
- Active shared member identity uses OAuth, never a static MCP credential.
- Unsupported authentication fields fail closed.
- OAuth tokens are issuer- and resource-bound.
- Member authorization always resolves through current RBAC state.
- Refresh-token replay or binding mismatch revokes the entire family.
- The Gateway fails startup when OAuth is configured but protected secret state is unavailable.
