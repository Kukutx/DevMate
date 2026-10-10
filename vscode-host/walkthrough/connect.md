## Give a client the address

**On this computer** (Claude Code, Codex, any local MCP client) the copied address is all it takes:

```
claude mcp add --transport http devmate http://127.0.0.1:8788/mcp
```

**ChatGPT on the web and Claude.ai** reach you from the cloud, so they need a route to this computer. **DevMate: Configure Connection** sets one up. The first choice, a **Cloudflare quick tunnel**, needs no account and no domain and is ready in a minute; its address changes when it starts again. For an address that stays: OpenAI's official tunnel, a Cloudflare tunnel on your own domain, your own HTTPS proxy, or SSH. Then add the copied address as a custom MCP connector in the client.

A public address without sign-in works for whoever has it. Keep it private, or choose **Require sign-in** in the same guided setup.

When an agent asks for your approval, you answer here at your computer: VS Code shows a notification, and **DevMate: Open Workbench** shows everything that is waiting.
