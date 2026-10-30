# DevMate

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Kukutx/DevMate/ci.yml?branch=main&label=CI)](https://github.com/Kukutx/DevMate/actions/workflows/ci.yml) [![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kukutx.devmate-agent?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=kukutx.devmate-agent) [![Release](https://img.shields.io/github/v/release/Kukutx/DevMate?label=release)](https://github.com/Kukutx/DevMate/releases) [![License: MIT](https://img.shields.io/github/license/Kukutx/DevMate)](LICENSE)

DevMate lets the model in your chat window work directly on your own computer: read, search and edit project files, run commands and tests, use Git, see the errors your editor already reports, and hand whole tasks to the coding agents installed on your machine. It is a local runtime that offers these capabilities through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

The main use is connecting the chat window you already use (ChatGPT on the web, Claude) to your machine and developing from there. It is not tied to one of them: every MCP client connects to the same runtime. [What your plan allows](#what-your-plan-allows) says which ChatGPT and Claude plans can change files and run commands through a connector, and which can only read.

- **Your machine, your route.** Nothing is relayed through a service of ours. Cloud clients reach you through a tunnel you own (Cloudflare, OpenAI's official tunnel, your reverse proxy, or SSH), and DevMate proves the route end to end.
- **You decide what is shared, at your computer.** Which folders, read only or read and write, credential files protected. A connected client can narrow these and never widen them.
- **One runtime for every entry.** Any number of VS Code windows, Obsidian and the command line share one runtime per machine, guaranteed by the operating system.
- **It knows what your editor knows.** Compiler, type and lint errors come straight from VS Code, without running a build.

```
 ChatGPT web · Claude.ai                    Claude Code · Codex · any local MCP client
          │  HTTPS through your own tunnel                 │  http://127.0.0.1:8788/mcp
          ▼                                                ▼          or `devmate mcp` (stdio)
   ingress port 8789 ───────────────┐      ┌─────────────── control port 8788
   MCP and OAuth only               ▼      ▼                owner only: CLI, editors, workbench
                              ┌──────────────────┐
                              │  DevMate runtime │  one per instance directory
                              │  every call is   │  files · search · Git · shell
                              │  authorised here │  editor diagnostics · agents
                              └──────────────────┘
                                 ▲      ▲      ▲
                         VS Code windows · Obsidian · `devmate` command line
```

![The DevMate workbench showing the uncommitted changes of a project](docs/media/workbench.png)

## Install

**Requirements:** Node.js 24 or newer, and Git 2.41 or newer (the Git that ships with the macOS developer tools is older: `brew install git`). The command line and Obsidian also need `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)); the VS Code extension brings its own.

| Entry | Install |
| --- | --- |
| VS Code extension | Search for **DevMate** in the Extensions view, or run `ext install kukutx.devmate-agent`. Offline: download `devmate-<version>.vsix` from [Releases](https://github.com/Kukutx/DevMate/releases) and run `code --install-extension devmate-<version>.vsix` |
| Obsidian plugin | **Settings → Community plugins → Browse → DevMate**. Manually: unpack `devmate-obsidian-<version>.zip` from Releases into `<vault>/.obsidian/plugins/devmate/` and enable it. Desktop only |
| Command line | Download `devmate-cli-<version>.tgz` from Releases and run `npm install -g ./devmate-cli-<version>.tgz`. It has no dependencies and installs offline. Remove it with `npm uninstall -g devmate-agent` |

`devmate doctor` (or **DevMate: Doctor** in an editor) checks everything this installation needs and prints the exact command to fix each item for your system.

## The first five minutes

New to DevMate and want ChatGPT on the web or Claude.ai working on your computer? [Getting started](docs/GETTING_STARTED.md) walks through it step by step, with what you should see after each one. The short form:

With VS Code:

1. Open a project folder and run **DevMate: Start DevMate Runtime** from the Command Palette. The folder is shared, read and write, and the window tells you so once.
2. Run **DevMate: Copy MCP URL**. For a client on the same computer that is all: `claude mcp add --transport http devmate http://127.0.0.1:8788/mcp`.
3. For ChatGPT on the web or Claude.ai, run **DevMate: Configure Connection** once (see [Connecting a client](#connecting-a-client)), then add the copied address as a custom MCP connector.
4. Ask the model for "an overview of my project". It calls `project_overview` and you are working.

With the command line only:

```powershell
devmate start                          # start the background runtime, or join the one that runs
devmate project add C:\Projects\Example
devmate doctor
devmate mcp-url                        # the address to give a client
devmate ui --open                      # the workbench in your browser
```

## Four entries, one runtime

| Entry | For | Adds |
| --- | --- | --- |
| `devmate` command line | Working without an editor | Everything: start, share folders, configure the connection, open the workbench, call any operation. `devmate mcp` serves MCP on standard input and output for clients that start their servers as a program |
| VS Code extension | Everyday development | The editor's diagnostics, active file and selection; a status bar item |
| Obsidian plugin | A knowledge base | Note search, properties, graph and vault operations |
| Chrome and Edge extension | The browser itself | Bookmarks, tabs and windows, history, downloads, the reading list and the pages in its tabs |

One instance directory (default `~/.devmate/runtime`) has exactly one runtime process at a time.

- Several VS Code windows, Obsidian and the command line can run together. Pressing Start in all of them starts one runtime; the others join it.
- Each editor window works on its own folders. Closing a window affects neither the runtime nor the other windows.
- **The runtime keeps running after you close the editor**, with its public connection if you configured one, until you stop it: `devmate stop`, or **Stop DevMate Runtime** in an editor. Stopping affects every entry, so the editors ask first.
- After a crash the next start simply works. VS Code with `devMate.autoStart` brings a crashed runtime back; one you stopped stays stopped.
- **Update the entries together.** A runtime is the release of the entry that started it. After an update the command line says when an older runtime is still the one that runs (`devmate restart` starts the new one). And once a newer release has used the instance, an entry that is still older can no longer start the runtime: it says which releases are involved, and it still joins a runtime that is running. So an editor that was left on the old release cannot quietly bring back a runtime that does not know what the new one was told, such as asking you before a client's task runs. For the same reason an instance that a release after 4.0.5 has used cannot go back to 4.0.5.

## Command line

| Command | Purpose |
| --- | --- |
| `devmate start` / `stop` / `restart` / `status` | The background runtime |
| `devmate serve` | Run in the foreground until Ctrl+C |
| `devmate doctor` | Check the installation. Works when nothing is running and says what to do next |
| Start at sign-in, without an editor | Have your system run `devmate start` when you sign in: a Task Scheduler task on Windows, a systemd user unit on Linux, a launchd agent on macOS |
| `devmate logs [--lines N]` | Recent runtime log |
| `devmate project add [directory] [--name N] [--read-only]` / `list` / `remove` | What is shared. Without a directory, the current one |
| `devmate access [guarded \| full]` | The permission profile: what a connected client may decide (see [Who may do what](#who-may-do-what)) |
| `devmate delegation [ask \| allow \| off]` | Whether a connected client may hand tasks to the coding agents here, which run on your account with them. `ask` (the default): you allow each task at this computer first |
| `devmate mcp-url` | The address for a client |
| `devmate mcp` | MCP over standard input and output; starts the runtime when needed |
| `devmate connect local \| quick \| cloudflare \| openai-tunnel \| https \| ssh …` | How cloud clients reach this computer. `--auth oauth` requires sign-in; `--openai-tunnel <id>` runs OpenAI's tunnel beside a route that has an address; `connect beside --openai-tunnel <id> \| none` adds it to the route there is, or takes it away |
| `devmate secret set <NAME>` / `list` / `remove <NAME>` | Connection credentials. The value is read from standard input and never appears in shell history |
| `devmate login-code` | A one-time sign-in code (when sign-in is on) |
| `devmate ui [--open]` | A single-use link to the workbench |
| `devmate operations` / `help <operation>` | Every operation, and one with its exact input |
| `devmate <operation> --json '{…}'` | Call any operation; also `--file <input.json>` or `--stdin`. On Windows use `--file`: Windows PowerShell 5.1 and cmd take the double quotes out of what follows `--json` |

Every command accepts `--instance <directory>` to use another instance. The command line can do everything the workbench and the extensions can.

Commands run in PowerShell on Windows: PowerShell 7 when it is installed, otherwise the built-in 5.1. Version 5.1 has no `&&` and `||`, which models use by habit, so installing PowerShell 7 is recommended (`winget install Microsoft.PowerShell`). On macOS and Linux commands run in bash, or `sh` when there is no bash.

## VS Code extension

Commands (all under **DevMate:** in the Command Palette):

| Command | Does |
| --- | --- |
| Start / Stop / Restart DevMate Runtime | The shared runtime |
| Change Folder Sharing | Read and write, read only, or not shared, per folder |
| Select This Window Workspace | Which shared folder this window works in, when it shares several |
| Configure Connection | The guided setup for cloud clients, and whether they must sign in |
| Copy MCP URL · Copy One-Time Sign-In Code | What a client needs |
| Open Workbench · Doctor · Show Menu · Show Runtime Status | Seeing what is going on |
| Discover Operations · Call Operation | Looking into a problem |

Settings (user settings only: a repository's `.vscode/settings.json` cannot change them):

| Setting | Default | Meaning |
| --- | --- | --- |
| `devMate.shareFolders` | `readWrite` | What connected clients may do in a trusted folder you open: `readWrite`, `readOnly`, `ask`, `never`. Folders of an untrusted workspace are never shared |
| `devMate.shareEditorContext` | `true` | Whether clients see the active file, selection, open files and diagnostics |
| `devMate.autoStart` | `true` | Start the runtime with the editor, and again after a crash. One you stopped stays stopped |
| `devMate.runtimePort` | (empty) | The local port when this editor starts the runtime. Empty: the port the runtime ran on last (8788 the first time) |
| `devMate.nodeCommandPath` | empty | A Node.js 24+ executable, when it is not found on its own |
| `devMate.runtimeInstanceDirectory` | empty | Another instance directory than `~/.devmate/runtime` |

- An opened folder is shared read and write by default, and the window says so once with a **Change…** button. A folder you take out stays out until you share it again.
- No separate ripgrep is needed: when PATH has no `rg`, the runtime uses the copy VS Code ships and remembers it for use without the editor.
- Editors with built-in MCP support discover the local endpoint on their own.
- The extension needs VS Code 1.101 or newer and is tested in a real editor on 1.101 and 1.133.
- **Remote windows (SSH, WSL, Dev Containers):** the extension runs on the remote side, so DevMate, Node.js and the shared folders are those of the remote computer, and "local" addresses are local to it. This setup is not tested yet.

## Obsidian plugin

- **DevMate: Start runtime** starts the runtime; the status bar shows its state and opens the sidebar.
- **DevMate: Attach this vault** shares the vault and offers the note tools (search, properties, graph, move, trash). The first time it asks: read and write, read only, or not now. The whole vault folder is shared, so connected clients also reach it with the file tools.
- **DevMate: Change how this vault is shared** changes that at any time. **Detach** only stops the note tools; sharing is unchanged.
- **DevMate: Stop shared runtime** and **Restart shared runtime** ask first, because they affect every entry.
- When an agent waits for your approval or an answer, Obsidian tells you; **DevMate: Open workbench** is where you answer.

**Disclosures.** The plugin is desktop only and needs Node.js 24 installed separately (set its path in the plugin settings when it is not found; ripgrep must be installed too). It starts the DevMate runtime as a background process that keeps running after Obsidian closes, until you run **Stop shared runtime**. The runtime listens on `127.0.0.1` only (ports 8788 and 8789, and one more loopback port for vault operations). Its state, credentials and its own program files are kept in `~/.devmate/runtime`, outside the vault. The plugin carries those program files inside `main.js` as plain, readable text (nothing is encoded), writes them there and checks each against its hash on every start. It makes no network connection unless you configure a public connection (Cloudflare Tunnel, OpenAI Secure MCP Tunnel, SSH or your own HTTPS proxy). No telemetry, no account, no payment.

The plugin has been loaded and driven in a real Obsidian 1.12.7 on Windows: loading, starting the runtime, sharing the vault read only and read and write, the note tools, stopping and disabling. Obsidian on macOS and Linux has not been tried. Please report what you find.

## Chrome and Edge extension

DevMate can drive a browser of its own (the browser control engine), but that browser is not yours: it has none of your bookmarks, tabs, history or sign-ins. The extension gives your client the browser you actually use.

```powershell
devmate chrome install        # tell Chrome and Edge which program the extension may talk to (your account only), and put the extension where the browser loads it from
```

Then load the extension: open `chrome://extensions` (`edge://extensions` in Edge), switch on **Developer mode**, choose **Load unpacked** and pick the folder `devmate chrome` names: `chrome/extension` in DevMate's instance directory (`~/.devmate/runtime/chrome/extension` unless you chose another). `devmate chrome` says whether the browser is registered and connected, and so does `devmate doctor`.

Leave **Developer mode** on, and that is all there is to do, updates included. The folder stays where it is and DevMate keeps it current: every start of the runtime makes it the extension of the DevMate that runs (a newer one that is already there is left alone), whichever entry was updated, and makes the program the browser starts that same DevMate. The extension notices within about two minutes that its files changed and loads itself again, with nothing to click. With Developer mode off, Chrome switches an unpacked extension off at that moment.

- **An entry like the editors.** The extension's panel says in one sentence how things stand and the one thing to do about it, with the browser's own words when it cannot reach DevMate. It starts DevMate, opens the workbench, copies the address a client in the cloud needs (the public one where you have a route, otherwise this computer's) and counts what waits for your answer.
- **Two switches, both yours.** **Let DevMate use this browser**: switched off, every request is refused and your client is told that you paused it. **Start DevMate with the browser**: off until you turn it on; like an editor it starts the runtime and never stops it.
- **What DevMate did in this browser** is listed in the panel: the last calls with their time and outcome, never their content. The panel is in English and Chinese.
- **What your client can do with the browser** (through `capability_list {engine:"chrome"}`, `capability_query` for what only reads and `capability_call` for changes; no project is needed):

  | | Read | Change |
  | --- | --- | --- |
  | Bookmarks | the tree, search | create, rename, move, remove |
  | Tabs and windows | list tabs, windows and tab groups | open, go to an address, bring to front, reload, close, move, group, ungroup; open and close windows |
  | History | search by words and time | delete an address or a time range |
  | Downloads | list | start a download |
  | Recently closed | list | bring back |
  | Reading list, most visited | list | add, remove |
  | A tab's page | title, address and text; a picture of what it shows or of the whole page | go back, go forward |
  | Debugging a page | the console and uncaught errors, the network requests and one of them in full, the page as its elements, one element in detail (attributes, box, styles), what the page stores, wait for an element or a text | click, type, press a key, choose from a list, hover, scroll, run a script, answer a dialog, reload, emulate a screen, a color scheme or being offline |

- **Debugging works like DevTools, on the tab you name or the one in front.** The first call puts Chrome's debugger on that tab; Chrome shows its own bar on the tab while it is there, and it comes off after five minutes without a call or with `chrome.page.debugStop`. The console and the network are recorded from that moment: `chrome.page.reload` shows a page loading from the start. `chrome.page.snapshot` gives every element a number, and click, type, hover, scroll and inspect take that number, a CSS selector, or the text the element shows or is called by (its aria-label, title or alt, or what a text field holds or asks for; what a password field holds is never looked at). A tab behind another, or in a minimized window, is clicked, typed into, scrolled and pictured where it is: nothing is brought to the front of your screen. For that the page is told that it has the focus. After the mouse or the keys were used on it, it believes it is being looked at for as long as it is debugged (a site may mark messages as read, or go on playing), and it is drawn at full rate until the debugger comes off. A picture does this only while it is taken, and leaves the tab as it was; reading a page in any other way does not do it at all.
- The values a page stores (its cookies among them) are credentials. `chrome.page.storage` gives names only; the values come only with `includeValues` through `capability_call`, which your client asks you about.
- Text read from a web page (its text, its console, its requests, its elements, what a script returns) is marked as untrusted: it is data for the model, never instructions.
- The browser talks to DevMate through a native messaging host, a small program the browser itself starts for this one extension. Nothing listens for it and it works with no public connection. `devmate chrome uninstall` takes the registration away.
- On Windows the registration is written through the system's own management service, so that it lands where browsers read it whichever terminal the command is run from. A terminal inside a packaged app has a registry of its own that no browser sees; `devmate chrome` says so when it finds a registration only there.

The runtime's side has been run end to end with the browser's own message framing against a real runtime. [STATUS](docs/STATUS.md) says what has been tried in a real browser.

## Connecting a client

### On the same computer

No tunnel and no sign-in:

```
http://127.0.0.1:8788/mcp
```

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http devmate http://127.0.0.1:8788/mcp` |
| Codex CLI | `codex mcp add devmate --url http://127.0.0.1:8788/mcp` |
| VS Code's own MCP support | Found automatically once the extension is installed |
| A client that only starts programs | Command `devmate`, argument `mcp`, for example `{ "command": "devmate", "args": ["mcp"] }` |

Any other client: add an HTTP (Streamable HTTP) MCP server with this address. A browser-based client on another origin is refused until you add its origin to `allowedOrigins` in the DevMate configuration; add only clients you run yourself.

### ChatGPT on the web and Claude.ai

They reach your MCP server from the cloud, so they need a route from outside to your machine. DevMate offers six. Two of them have nothing of a third party in between: a relay on a server of your own, and for ChatGPT OpenAI's own tunnel.

| Route | For | Notes |
| --- | --- | --- |
| `relay` | Any client | A public Linux server of yours becomes the way in: `devmate relay setup user@host`. An address that stays, answers that stream, no limits but the server's own |
| `quick` | Any client | A Cloudflare quick tunnel, for trying DevMate out. No account, no domain, nothing to set up; the address changes whenever it starts again |
| `openai-tunnel` | ChatGPT, Codex | OpenAI's own tunnel, spoken by DevMate itself: outbound only, no public address, no domain, no server, nothing to install, and an id that stays |
| `cloudflare` | ChatGPT, Claude, any client | A named Cloudflare tunnel on your own domain; DevMate runs `cloudflared`. Free |
| `https` | Any client | A reverse proxy you already run |
| `ssh` | Any client | OpenSSH reverse forwarding to a server of yours that already provides HTTPS (the relay without the setup) |

**A relay of your own: an address that stays**

With a public Linux server you control (a small rented one is enough) and key login to it over SSH:

```powershell
devmate relay setup root@203.0.113.7 --domain devmate.example.com
devmate restart
devmate mcp-url
```

`relay setup` installs [Caddy](https://caddyserver.com) on the server from the system's own packages, lets it get the certificate for that name, and forwards one path nobody can guess to a loopback port there. This computer holds that port open from the inside with OpenSSH, so nothing has to be opened on your router. Answers stream as they do locally, and there is no request count, size limit or changing address: the only limits are the server's own.

- By default the relay answers only to the addresses ChatGPT and Claude connect from (their published ranges, fetched again every six hours) and to this computer. `--any-address` leaves the protection to the key in the path.
- A relay asks for no sign-in and cannot: it forwards that one path and nothing else, so the pages of a sign-in would not be reachable. What keeps strangers out is the key and the list of addresses; `--auth oauth` together with a relay is refused when you set it.
- Without `--domain` the relay is reached by the server's IP address and asks for a certificate for that address, which needs Caddy 2.10 or newer on the server. Where the system's own package is older or missing (Debian, Ubuntu, Fedora, RHEL), `relay setup` takes Caddy from Caddy's own package repository. A Caddy that was on the server before is never replaced: the setup stops and prints the commands that would do it.
- It needs root on the server, or a login that may use `sudo` without a password. No password is ever asked for or stored: authentication is your SSH key.
- Running it again changes nothing and keeps the address. `devmate relay remove root@203.0.113.7` takes the relay off the server, and Caddy and its package repository too if this had installed them.

The server script and the forwarding are tested; a relay on a real public server has not been tried yet. [STATUS](docs/STATUS.md) says exactly what is unverified.

**Quick tunnel: connected in a minute**

With `cloudflared` installed (Windows: `winget install Cloudflare.cloudflared`; macOS: `brew install cloudflared`), three commands give you an address for ChatGPT or Claude:

```powershell
devmate connect quick
devmate restart
devmate mcp-url
```

Nothing is registered anywhere: Cloudflare hands out a random `trycloudflare.com` host name while the tunnel runs, and DevMate checks that it reaches this runtime. There is no sign-in. The address ends in a key that DevMate makes anew at every start (`https://<name>.trycloudflare.com/mcp/<key>`), and only the whole address opens anything: the host name alone, which anyone watching DNS can see, answers "not found". Whoever has the whole address can do what you can, so give it to your own client only and do not paste it anywhere else; `devmate doctor` prints it without the key. It changes whenever DevMate or the tunnel starts again; the client then gets the new one from `devmate mcp-url`.

A quick tunnel is what Cloudflare [offers for testing and development](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/): no uptime guarantee, at most 200 requests at once, and no event streams. DevMate therefore answers through it in plain JSON, without progress messages while a call runs. For daily use take an address that stays, with one of the routes below.

**Cloudflare tunnel**

1. In Cloudflare Zero Trust create a tunnel with a public hostname such as `devmate.example.com`, and set its service to `http://127.0.0.1:8789`.
2. Configure it and store the token:

```powershell
devmate connect cloudflare --url https://devmate.example.com/mcp --executable "C:\Program Files (x86)\cloudflared\cloudflared.exe"
devmate secret set CLOUDFLARE_TUNNEL_TOKEN      # paste the token and press Enter, or pipe it in
devmate restart
devmate doctor
```

3. Give the address printed by `devmate mcp-url` to ChatGPT or Claude as a custom MCP connector.

**OpenAI tunnel**

Create a tunnel in the organisation settings of the OpenAI Platform (Settings → Tunnels). It gives you a tunnel id and a runtime key:

```powershell
devmate connect openai-tunnel --tunnel-id tunnel_xxxxxxxx
devmate secret set CONTROL_PLANE_API_KEY      # paste the runtime key and press Enter
devmate restart
```

`devmate mcp-url` prints the tunnel ID; choose the Tunnel connection type in ChatGPT and enter it. It stays the same across restarts.

This computer only reaches out, to `api.openai.com`, and asks for work: nothing listens for the outside, no router setting and no server are needed, and the only party that can limit the route is OpenAI. DevMate speaks the tunnel's [published protocol](https://github.com/openai/tunnel-client/blob/master/docs/protocol.md) itself, so there is no second program to download and keep current, and it serves up to 32 calls at once (`maxConcurrentRequests` in the connection settings, 1 to 256). To use OpenAI's own `tunnel-client` program instead, add `--executable <its path>`. `devmate doctor` says which of the two is in use, and counts the calls that have arrived: a call that came through is the proof that the route works.

When OpenAI refuses the key or the tunnel, `devmate doctor` repeats OpenAI's answer and says what to do about it. For a key OpenAI wants the tunnel's organisation named with, that is `--organization <org-…>` on the `connect` command.

If ChatGPT does not offer the tunnel although the doctor shows it connected, the cause is in the OpenAI account and not in DevMate: the tunnel has to include the ChatGPT workspace you use, not only a Platform organisation, and your account needs the Tunnels permissions Read and Use ("Troubleshooting" in [OpenAI's guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)). Whether your ChatGPT plan offers the Tunnel connection type is decided by OpenAI; the free plan of a personal account did when it was tried in October 2026.

A tunnel of a personal account serves the ChatGPT of that same account. OpenAI does not take the workspace of another personal account into it (its settings page cannot verify that the workspace belongs to the organisation), and that account's ChatGPT is refused by OpenAI before a request reaches DevMate. A second account needs one of the routes with a public address.

The tunnel and a route with a public address can run at once: name the tunnel on that route's `connect` command.

```powershell
devmate connect quick --openai-tunnel tunnel_xxxxxxxx
devmate secret set CONTROL_PLANE_API_KEY      # the runtime key of the tunnel
devmate restart
```

ChatGPT of the account the tunnel belongs to then comes through the tunnel, and every other client (a second account, Claude) through the address. `devmate mcp-url` prints the address and names the tunnel ID with it; `devmate doctor` shows the two separately, as `connection.*` and `tunnel.*`; and a client that asks (`connection_status`) is told that the tunnel runs beside the address and which of the two it came through itself (`via`). Beside an address the tunnel is always spoken by DevMate itself. A `connect` command that does not name the tunnel sets the connection up alone, and says how to have the tunnel again.

The tunnel is put beside the connection there is, or taken away, without that connection being named again. That is the way for a relay, whose address you never typed:

```powershell
devmate connect beside --openai-tunnel tunnel_xxxxxxxx
devmate connect beside --openai-tunnel none
```

`devmate relay setup` leaves a tunnel that runs beside the connection beside the relay. Where the tunnel was the connection itself, the relay takes its place, and the command says how to put the tunnel beside it.

With an address this computer can be reached from outside again, whether the tunnel runs or not. Sign-in belongs to the address: what comes through the tunnel is served without it, because OpenAI decides who may use a tunnel ([SECURITY.md](SECURITY.md)); the doctor says so in a line of its own, `security.tunnel`. A quick tunnel and OpenAI's tunnel together were tried in October 2026 with two real accounts, each account's ChatGPT through its own way into the same runtime. An address that asks for sign-in beside the tunnel, and a relay beside it, have been tried against a stand-in for OpenAI's service only.

**Is it really connected?**

A running tunnel process is not a working route. DevMate connects back through the public address as a real MCP client, lists the tools and calls one, and the answer must come from this very runtime; it repeats the check periodically and says so when the route breaks. The route works when `connection.public` is `ok` in `devmate doctor`. The OpenAI tunnel has no public address to connect back through: there the doctor shows that OpenAI accepts the runtime key, and how many calls have arrived.

A connector that cannot start does not take local work down and is never hidden: `doctor` and `connection.status` give the reason. After storing a new credential, restart only the connector: `devmate connection.restart`.

### What your plan allows

Whether a chat product lets a connector you add yourself change things is decided by that product and your plan, not by DevMate. As their own documentation states it:

| Product | Custom MCP connectors |
| --- | --- |
| ChatGPT Business, Enterprise, Edu | Read and write, in developer mode on the web (a beta). An admin or owner switches developer mode on |
| ChatGPT Pro | Read only, in developer mode, by OpenAI's documentation as it read in October 2026. DevMate marks its reading tools as read-only (files, search, Git, diagnostics, `operations_query`, `capability_query`); editing, commands and delegation need, by that documentation, a plan that allows writing. Whether a write from a Pro account is carried out was not verified by us: in October 2026 the authorization setting of a plugin in a Pro account offered "allow all tools", which says only that the choice is there |
| ChatGPT Plus, Go, Free | Not named in OpenAI's documentation for custom MCP connectors |
| Claude (claude.ai, desktop, mobile) | Custom connectors by URL; a tool call may take 240 seconds and return about 150,000 characters |
| Claude Code, Codex and other local clients | No plan limits of this kind: they connect on this computer |

Sources: [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), [Build an MCP server for Claude](https://claude.com/docs/connectors/building). Both change; check them for your plan. DevMate's own tools stay inside the tighter of these limits: a command or a delegated task is waited for at most 50 seconds per call (it keeps running and is asked about again), and a text result stays under 140,000 characters. A capability that runs longer by nature (a browser navigation, a game-engine run) is better started as a job with `job.start` and read later.

## Who may do what

- **Two ports, two levels of trust.** The control port (default `127.0.0.1:8788`) is yours alone: workbench, command line, editors, MCP clients on this computer. The ingress port (default `8789`) serves only MCP and OAuth and is the only thing a tunnel or proxy points at; the control port refuses anything that arrived through a proxy.
- **What is shared is decided at your computer.** Folders are shared from an editor, with `devmate project add`, or in the local workbench. A connected client cannot share a folder, widen read-only access, lift the protection of credential files or bring back a folder you took out; it can only narrow.
- **Write access is full access.** In a writable project a client can run commands, and commands run as your operating-system account. With at least one writable project the limits on other folders keep a well-behaved model in place; they are not a wall against a hostile one. For a client you do not fully trust, share read only: then there are no commands and the limits hold. DevMate is not a sandbox.
- **`auth.mode` is `none` by default.** Whoever reaches the MCP address is you. Treat a public address like a password, or require sign-in.
- **Optional sign-in (OAuth).** `devmate connect … --auth oauth` makes clients of the public address sign in: on first connection they are sent to DevMate's authorisation page, where you enter a one-time code from `devmate login-code`. Signing in proves the client is you: DevMate has one owner and no other accounts. A client that publishes no description of itself (a client metadata document) is registered by you under `auth.clients` in the configuration, with its name and redirect addresses. Clients on your own computer never need to sign in.
- **Approvals and questions are answered by you, at your computer.** When an agent asks for permission, you answer in the editor or the local workbench. No connected client can answer, including the model that started the agent.
- **Full access, when you want none of that in your way.** The default profile is *guarded*: everything above. If you drive your work from a chat client and do not want to walk to the computer, switch on *full access* there: `devmate access full`, **DevMate: Change Permission Profile** in VS Code, or **Permissions…** in Obsidian. A client connected as you can then share folders, widen access, read credential files, set up capability engines, answer what an agent asks and run the doctor, and what an agent you delegated to asks permission for is granted automatically (each grant stays on record). It takes effect at once and only you, at your computer, can switch it on; `devmate access guarded` takes it back. With full access, whoever reaches your MCP address acts as you without asking: keep the address private or require sign-in.
- **A task for a coding agent is spent on your account, so you are asked first.** What Codex, Claude Code or another agent does runs on your account with its provider. When a connected client hands one a task (`agents_delegate`, or a message or a task for an agent), nothing runs and no agent is started until you allow it at your computer: from the notification in your editor or in the local workbench (`devmate ui --open`), which shows what you agree to: the task as the agent will be given it (of a very long one the first 20,000 characters, with how much more there is and where to read it), the model it would run with, and a session of the provider it would take up again. You allow that one task; or that task and no more asking for that agent while it stays connected, which covers its later tasks and what a client adds to a task that runs; or you refuse. A yes is not used up on a task that cannot begin right now (no session is free, or its workflow is paused or has no turns left): the answer is refused with what is in the way, and the question stays. At most twenty tasks wait for you at once. This is so in both profiles: full access does not answer it, because the client that asked would be the one answering, and a client that has your browser cannot read or click the workbench tab. What you hand to an agent yourself at the computer is not asked about, and a task that waits holds up nothing else: it starts nothing, and it counts against nothing until you allow it. `devmate delegation allow` ends the asking, `devmate delegation off` keeps connected clients from handing over tasks at all, `devmate delegation ask` is the default and, chosen again, has every agent asked about again, and every task of a client that has not begun (up to the twenty that may wait; what is beyond that is ended and says so); like the profile, it is chosen at your computer only.
- **Credential files are protected by default.** `.env`, key files, `.npmrc` and the like are not read or listed by the file tools; Git status names them, marked "do not commit". You can switch that off for one project, at your computer.
- **Secrets in command lines are not shown.** Process lists and activity records replace inline tokens and passwords with `[redacted]`; the command that runs is unchanged. This recognises common forms and is no guarantee.
- **The workbench session stays in its browser tab.** It is entered through a single-use link, and its session is never a cookie that other local services would receive.
- File contents, command output and web pages the model reads are data, never instructions to it.

[SECURITY.md](SECURITY.md) has the full policy and the known limits.

## Tools the model gets

A model is shown its tools under the names it was trained on. Which list a client gets is decided by what it says it is; a client that is not recognised gets DevMate's own names.

| | ChatGPT and Codex | Claude | Other clients |
| --- | --- | --- | --- |
| Read a file | `read` | `read` | `workspace_read` |
| Change files | `apply_patch` | `edit` `write` | `workspace_edit` `workspace_patch` `workspace_write` |
| Run a command | `exec_command` `write_stdin` | `bash` (`powershell` where commands run in PowerShell, as on Windows) `process_read` `process_write` | `shell_run` `process_read` `process_write` |
| Review what changed | `show_changes` | `show_changes` | `workspace_changes` |
| On every list | Everything that only reads: `project_list` `project_overview` `editor_context` `editor_diagnostics` `workspace_files` `workspace_find` `workspace_search` `workspace_history` `git_status` `git_diff` `git_log` `git_show` `git_blame` `git_branches` `process_list` `providers_list` `connection_status`. Taking a change back: `workspace_restore`. The engines, your browser among them: `capability_list` `capability_query` `capability_call`. And `process_stop` `agents_delegate` `agents_result` `operations_list` `operations_query` `operations_call` | | |

| Area | What it does |
| --- | --- |
| Orientation | `project_overview`: Git branch and changes, the project's own agent instructions (`AGENTS.md` and similar), runnable scripts, top-level layout and the editor's error count, in one call |
| Finding code | Glob find and ripgrep content search. Honours `.gitignore`; fast on large repositories |
| Reading | With line numbers, paged for large files (up to 32 MiB). UTF-16 and the computer's own encoding (GBK and the like) can be read, not rewritten |
| Changing | A patch (the `*** Begin Patch` envelope Codex writes, or a unified diff as `git diff` prints it) changes several files at once, all of it or none, and is taken back as one. Exact text replacement applies several edits atomically. Overwriting keeps what was there |
| Running | Real shell semantics (`npm test`, `git commit`). A call returns after 30 seconds at the latest by default (50 at the most); a command still running then keeps running and is followed, fed input and stopped as a whole process tree |
| Reviewing | What is uncommitted, whoever changed it (a tool, a command, a delegated agent): per file what happened and how many lines came and went. Marked as reviewed, the next look shows only what changed since. Needs a Git repository |
| Editor | The compiler, type and lint errors VS Code already computed |
| Delegation | Hand a whole task to a coding agent on this machine |
| History and Git | What DevMate changed and taking it back (`workspace_history`, `workspace_restore`, kept 30 days by default); the commit log, a commit, who changed a line, the branches (read only, never running a program the repository configures) |
| Engines | Through `capability_list`, `capability_query` and `capability_call`: your own browser (the Chrome and Edge extension), browser control and QA, Godot, reverse engineering, Obsidian and external MCP servers |
| Everything else | Operations, called by name through `operations_query` (those that only read) and `operations_call`: making a folder, moving, deleting (a patch or a command does these as well), workflows, tasks, jobs, artifacts |

- Every tool of every list can be called by every client: the list only decides what a model is told about up front. To choose a list yourself, add `?tools=gpt`, `?tools=claude` or `?tools=generic` to the MCP address you give the client. `devmate doctor` says what the last client called itself, which list it was shown and why.
- `projectId` is a project id, a project's root directory or a unique project name, and can be left out when only one project is shared. With several, read-only tools follow the editor window you are working in; a change must name its project.
- There is no tool for sharing a folder. That is yours to do; the model is told to ask you.
- A tool list has 34 to 37 entries and takes 32 to 35 KB. Nothing that only reads is kept off it: a tool a model cannot see is a tool it does not use, and what only reads is what a client does not ask you about.
- A tool is found by words: `capability_list` and `operations_list` take `query` and keep what has every word in its name or its description. `shell_run` takes `env`, variables for that one command (DevMate's own, the names beginning with `DEVMATE_`, are not set this way). `workspace_write` takes `append` and then adds the text to the end of the file, which is kept restorable like before any change.
- Tools carry accurate hints (read only, write, destructive, open world), so clients ask for confirmation only where it matters.
- A cancelled or timed-out call only stops waiting: the command or agent task it started continues and stays reachable.
- The server speaks MCP 2026-07-28 and the 2025 revisions.
- The reverse-engineering engine includes tools that read, and can write, the memory of another process on Windows. Both are off until you switch them on at your computer (`allowProcessAccess`, `allowMemoryWrite`); a connected client cannot. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for all engines.

## Delegating to coding agents on this machine

One call hands a task to Codex, Claude Code, Gemini CLI or Grok CLI installed here:

```json
{ "projectId": "Example", "provider": "claude", "prompt": "Fix the failing case in tests/login.test.ts and say why it failed" }
```

- You are asked first. The task runs on your account with the agent's provider, so the call returns at once with "the owner has to allow this task at their computer first", and the task starts when you allow it there (the notification in your editor, or the workbench). `devmate delegation allow` ends the asking; see [Who may do what](#who-may-do-what).
- A task that finishes within the wait returns its result and the list of changed files; otherwise it returns an `agentId` to follow with `agents_result`.
- Passing the same `agentId` again continues that session with its context.
- With `"isolate": true` the agent works in a copy of the project instead (a Git worktree of the last commit, kept in DevMate's own directory). The project does not change until you have read what it proposes (`agents.proposal`) and brought it in (`agents.apply`: all of it as uncommitted changes, or none of it when the project changed in the same places meanwhile) or dropped it (`agents.discard`). The copy holds what is committed: uncommitted changes and ignored files such as installed dependencies are not in it.
- The agent works in the project folder with its own account, quota and tools. What it asks you (approvals, questions) appears in the workbench and as a notification in VS Code and Obsidian, and you answer it at your computer.
- Collaboration inside one vendor (Claude Code sessions messaging each other, Codex sub-agents) is done natively by them. DevMate covers the part between clients, for example handing a task from ChatGPT on the web to Claude Code on your machine.

For several agents exchanging messages and tasks in one workflow, use the finer `workflow.*`, `agents.*`, `message.*` and `task.*` operations, or the workbench.

## Workbench

`devmate ui --open` opens the workbench in your browser: projects, files, changes, commands, editor problems, agents and their activity, messages, tasks, approvals, artifacts and references. `open_devmate_workbench` opens the same interface inside clients that support MCP Apps (ChatGPT, Claude and others); there it shows everything, while sharing a folder and answering an agent stay at your computer.

## Troubleshooting

Run `devmate doctor` first. It names the item that is wrong and how to fix it.

| What you see | Cause and remedy |
| --- | --- |
| `DevMate runtime is not running` | `devmate start`, or start it in an editor |
| `Port 8788 … is already used by another program` | Another port: `devmate start --port 8790`, or the setting `devMate.runtimePort` |
| `DevMate needs Node.js 24 or newer` | Install Node.js 24+, or set the path of its executable in the DevMate settings of the editor |
| `Git … is too old` | Update to Git 2.41 or newer, then restart DevMate |
| A note that PowerShell 5.1 has no `&&` | Have the model use `;` and `if ($?) { … }`, or install PowerShell 7 and restart DevMate |
| The model says folders are "shared by the owner on their own computer" | Share the folder yourself: open it in an editor with DevMate, or `devmate project add <folder>`. To let your client do such things itself: `devmate access full` |
| The model says a project is read only, or a folder was taken out of sharing | That was your decision at this computer. Change it there: **Change Folder Sharing** in the editor, `devmate project add`, or the local workbench |
| "Answer this on your computer" in an embedded workbench, or an agent that keeps waiting for approval | Approvals are answered locally: `devmate ui --open`, or the notification in your editor. With `devmate access full` they are granted automatically |
| The model says "the owner has to allow this task at their computer first" | It handed a task to a coding agent, which runs on your account with the provider. Allow it in the notification of your editor or in the local workbench (`devmate ui --open`). Not to be asked again: `devmate delegation allow`, run at your computer |
| `rg was not found on PATH` | Install ripgrep as the message says, then `devmate restart`; or open DevMate once in VS Code, whose copy is then used |
| `The origin … is not allowed` | A browser-based client: add its origin to `allowedOrigins` in the configuration if you run that client yourself |
| A cloud client cannot connect | The `connection.*` items of `doctor`: where the connector (cloudflared, OpenSSH) is not in order, the `connection.process` line carries what it said last, and so does the line about an address over SSH that is not reached; `devmate logs` has what the runtime itself recorded |
| `This instance was last used by DevMate …, which stores its state in a newer format` | An entry of an older release (an extension or plugin that was not updated, an old `devmate`) tried to start the runtime. Update that entry; meanwhile it works with a runtime another entry started |
| `DevMate … is still running, older than this command` | The runtime was started before the update: `devmate restart` |
| Start fails | The message has the reason; the full log is `runtime.log` in the instance directory |

## Uninstalling

Removing the extension or the plugin does not stop the runtime, because other entries may be using it. Stop it first (**Stop DevMate Runtime**, or `devmate stop`), then uninstall. Everything DevMate keeps is in the instance directory (`~/.devmate/runtime` by default): delete it to remove the state, the credentials and the restorable file versions. Your project files are never touched by this.

## Data and retention

State lives in one SQLite database in the instance directory. The event journal, operation receipts, finished jobs and approvals, and restorable file versions are pruned after `retentionDays` (default 30). Projects, workflows, messages and tasks are not pruned.

## Compatibility

These are treated as public: the names and parameters of the tools above, operation names, configuration keys, command-line commands and the workbench resource `ui://devmate/workbench/v1`. A change to any of them is listed in the changelog. A test pins the tool names and parameters, so none changes by accident. The stored state carries a format number: a release never touches state written by a newer one and says which versions are involved.

## Development

```powershell
npm ci
npm run lint               # mistakes only: undefined names, unreachable code and the like
npm run check              # manifest, versions, pinned workflow actions, syntax
npm run test:unit          # the whole test suite
npm run test:vscode-host   # the extension in a real VS Code: two editors and a third window on one runtime
npm run candidate          # build once, smoke-test that build as packaged, write what a release publishes to dist/release/
```

Pushing a tag `X.Y.Z` that matches the package version (no `v`) verifies that commit and publishes the GitHub release and the VS Code Marketplace version. [CONTRIBUTING.md](CONTRIBUTING.md) describes the release steps.

| Directory | Contents |
| --- | --- |
| `runtime/` | The runtime: the one entry and authorisation of every call (`service.mjs`), all operations (`operations/`), SQLite state (`store.mjs`), the MCP layer (`mcp.mjs`), HTTP (`main.mjs`), the instance lock, commands and processes, files and Git, connections, agent adapters (`agents/`) |
| `runtime/engines/` | Browser, Godot, reverse engineering and other domain capabilities |
| `runtime/platform/` | Process trees, paths, tools and other low-level helpers |
| `workbench/` | The workbench, shared by the MCP App and the local page |
| `vscode-host/` `obsidian-plugin/` | The two editor hosts |
| `chrome-extension/` | The extension for Chrome and Edge that connects the owner's own browser |
| `tests/` `scripts/` | Tests; build, check, smoke and packaging scripts |

Every operation is defined once in `runtime/operations/` and authorised by the registry in `runtime/service.mjs`. MCP, the command line and the workbench all get it from there.

## Documentation

- [Getting started](docs/GETTING_STARTED.md): from nothing to ChatGPT working on your computer, step by step
- [Capabilities](docs/CAPABILITIES.md): browser, Godot, reverse engineering, Obsidian
- [Security policy](SECURITY.md) and its known limits
- [Changelog](CHANGELOG.md)
- [Contributing and releasing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Code of conduct](CODE_OF_CONDUCT.md)
- [Status](docs/STATUS.md) (in Chinese): what is not done yet, what could not be verified, and measured performance

## License

[MIT](LICENSE)
