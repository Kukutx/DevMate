# Authentication policy

This policy is a product constraint for DevMate. It prevents future changes from replacing the intended desktop experience with generic hosted-service assumptions.

## Default: direct private use

- DevMate starts with `auth.mode: "none"`.
- ChatGPT is configured with **No authentication**.
- Start, Stop, Restart, automatic ngrok recovery, URL copy, VS Code, and Obsidian must work without a token, OAuth prompt, or secondary setup flow.
- The default must remain short: open a workspace, start DevMate, add the verified MCP URL.

## Optional: shared or published app

- OAuth is the only public-app authentication mode: set `devMate.authenticationMode` to `oauth` in VS Code, or select OAuth in Obsidian settings.
- OAuth follows current MCP OAuth discovery, PKCE, authorization-code, access-token, and refresh-token conventions.
- The Gateway creates a single-use local OAuth approval code only when OAuth is enabled. Use **DevMate: Copy OAuth Approval Code** in VS Code or Obsidian only when the DevMate authorization page asks for it. A successful authorization rotates it automatically. It is never placed in an MCP URL or configured as a static connector Bearer token.
- OAuth must not alter the no-auth default, add controls to the primary Start/Stop panel, or block normal private use.

## Explicitly retired for MCP ingress

- Static owner Bearer tokens.
- `x-devmate-token`.
- Copy Bearer Token commands.
- `devMate.requireAuthToken` and any default-required-auth behavior.

Internal process credentials and explicitly enabled advanced Runner/team capabilities are separate from the desktop MCP default. They must not reappear as an ordinary ChatGPT setup step.
