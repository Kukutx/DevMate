# Authentication policy

DevMate uses one current authentication model for MCP 2026. Local operating-system trust and remote OAuth are separate boundaries; there is no static MCP credential mode.

## Security boundary

- Requests arriving from a verified loopback socket are the local owner and do not need OAuth.
- Any non-loopback `/mcp` request requires `auth.mode: "oauth"` and a valid OAuth access token.
- `auth.mode: "none"` means **loopback-only MCP**. It never means unauthenticated public MCP.
- OAuth is the default authentication setting for VS Code, Obsidian, standalone initialization, and new instance configuration.
- OAuth access tokens are carried in the standard `Authorization: Bearer <access-token>` header. DevMate does not expose a user-configured static Bearer credential.

## OAuth 2026 flow

DevMate implements the current MCP OAuth profile directly:

1. The MCP client discovers `/.well-known/oauth-protected-resource/mcp`.
2. The resource metadata identifies the DevMate authorization server and the `devmate` resource scope.
3. The client uses an HTTPS Client ID Metadata Document (CIMD) as its `client_id`.
4. DevMate fetches that document only from public HTTPS destinations, validates all resolved addresses before connecting, pins the request to a validated address, enforces TLS hostname verification, follows no redirects, and applies response size/time bounds.
5. Authorization Code + PKCE S256 is mandatory.
6. Both authorization and token requests must bind to the exact `/mcp` `resource`.
7. Authorization responses include `iss`, and authorization-server metadata declares issuer-response support.
8. Access tokens are short-lived and bound to both issuer and MCP resource audience.
9. `offline_access` is an authorization-server capability. It is not advertised as a protected-resource requirement.
10. Refresh tokens belong to a durable token family. Every refresh advances the family generation; replay of an older generation revokes the family.
11. `/oauth/revoke` can revoke an active refresh family.

Dynamic Client Registration and OpenID-provider aliases are not implemented. DevMate has one client-registration model: CIMD.

## Owner authorization

When OAuth is enabled, the host creates a high-entropy owner approval code in the instance's protected state directory. The code is never stored in `config.json`.

Use **DevMate: Copy OAuth Approval Code** only when the DevMate authorization page asks for it. A successful owner authorization rotates that code immediately. Authorization-code redemption is also one-time and durably tracked, so a Gateway restart cannot make an issued code reusable.

## Member authorization and RBAC

A DevMate member receives an OAuth login code with the `dmc_` prefix. The login code is an authorization-page credential; it is never accepted directly by `/mcp`.

Successful member authorization issues normal OAuth access/refresh tokens whose subject is `member:<id>`. On every MCP request DevMate resolves that subject against current member state and rechecks:

- member existence and enabled state;
- expiration;
- current role;
- current workspace scope;
- current authorization version.

Rotating a member login code increments the authorization version, immediately invalidating existing member OAuth tokens. Disabling, deleting, expiring, or removing all workspace scope from a member also makes existing authorization unusable.

## Secret storage

`config.json` contains only the authentication mode. OAuth signing material and the owner approval code live under the instance state directory with restrictive permissions, file locking, bounded reads, and atomic replacement.

Team/member login-code hashes and Runner credential hashes remain one-way stored in configuration. Plaintext credentials are returned only at creation/rotation boundaries and must not be committed to a repository or placed in MCP URLs.

## Invariants

- Credentials are never accepted from URL query parameters.
- Remote MCP never falls back to local-owner access.
- Unsupported authentication fields fail closed.
- OAuth tokens are issuer- and resource-bound.
- Member authorization always resolves through current RBAC state.
- A refresh-token replay revokes its entire family.
- The Gateway fails startup when OAuth is configured but its protected secret state is unavailable.
