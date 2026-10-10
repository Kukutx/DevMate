## Give a client the address

**On this computer** (Claude Code, Codex, any local MCP client) the copied address is all it takes:

```
claude mcp add --transport http devmate http://127.0.0.1:8788/mcp
```

**ChatGPT on the web and Claude.ai** reach you from the cloud, so they need a route to this computer. **DevMate: Configure Connection** sets one up: a Cloudflare tunnel on your own domain, OpenAI's official tunnel, your own HTTPS proxy, or SSH. Then add the copied address as a custom MCP connector in the client.

A public address without sign-in works for whoever has it. Keep it private, or choose **Require sign-in** in the same guided setup.

When an agent asks for your approval, you answer here at your computer: VS Code shows a notification, and **DevMate: Open Workbench** shows everything that is waiting.
