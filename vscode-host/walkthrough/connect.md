## Give a client the address

**On this computer**: run **DevMate: Add to Claude Code, Codex or Claude Desktop** and pick the client. DevMate is written into that client's own settings and starts by itself when the client needs it. Any other local MCP client takes the copied address (`http://127.0.0.1:8788/mcp`).

**ChatGPT on the web and Claude.ai** reach you from the cloud, so they need a route to this computer. **DevMate: Configure Connection** sets one up. The first choice, a **Cloudflare quick tunnel**, needs no account and no domain and is ready in a minute; its address stays across restarts of DevMate and changes after a stop or a restart of the computer, or when you ask for one with **DevMate: New Quick Tunnel Address** (do that if it got out). For an address that stays: OpenAI's official tunnel, a Cloudflare tunnel on your own domain, your own HTTPS proxy, or SSH. Then add the copied address as a custom MCP connector in the client.

A public address without sign-in works for whoever has it. Keep it private, or choose **Require sign-in** in the same guided setup.

When an agent asks for your approval, you answer here at your computer: VS Code shows a notification, and **DevMate: Open Workbench** shows everything that is waiting.
