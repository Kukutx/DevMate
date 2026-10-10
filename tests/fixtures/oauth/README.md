# OAuth client metadata fixtures

Client ID Metadata Documents published by real MCP clients, saved byte for byte.
Fetched on 2026-10-10 with `GET`, `Accept: application/json`, redirects not followed; every response was `200`.

| File | `client_id` (the URL fetched) | `Cache-Control` |
| --- | --- | --- |
| `chatgpt.client.json` | `https://chatgpt.com/oauth/client.json` | `public, max-age=300` |
| `claude-hosted.client.json` | `https://claude.ai/oauth/mcp-oauth-client-metadata` | `public, max-age=300` |
| `claude-code.client.json` | `https://claude.ai/oauth/claude-code-client-metadata` | `public, max-age=300` |
| `codex-cli.client.json` | `https://chatgpt.com/oauth/codex/client.json` | `public, max-age=300` |
| `vscode.client.json` | `https://vscode.dev/oauth/client-metadata.json` | `no-store,no-cache,max-age=0` |

`tests/runtime-auth-real-clients.test.mjs` signs each of these clients in against the authorization server.
Do not edit the files: when a client changes its document, fetch it again and update the date above.
