# Security Policy

DevMate 4 is a personal and internal-team local runtime with filesystem, Git, native agent, command, browser, Godot, reverse-engineering and Obsidian capabilities. Code execution is performed under the operating-system account that runs the selected provider or host.

## Connections and identity

The runtime binds to `127.0.0.1` on two ports. The control port is the owner's local surface: CLI, editor hosts, the localhost workbench and MCP clients on the same computer. The ingress port serves only MCP and OAuth and is the only port a tunnel or reverse proxy targets; the control port refuses any request that arrived through a proxy.

Local control uses the private instance owner token, which is never given to a browser. The localhost workbench is entered through a link that only the holder of that token can create (`devmate ui`, or the editor command): it works once and expires within a minute. The page of that link exchanges the code for a session that belongs to its browser tab. The session is not a cookie: a browser sends a cookie to every port of `127.0.0.1`, so every other local web service would receive it. The tab keeps the session to itself and presents it in a request header. Opening the control port in a browser without such a link shows a page that holds nothing and says how to get in.

One instance directory has exactly one runtime. Ownership is an operating-system endpoint (a named pipe on Windows, a Unix socket elsewhere) that exists only while the owning process lives, so concurrent starts from several editor windows, another editor and the CLI cannot produce two runtimes, and a record left by a crash is never mistaken for a running one.

Single-owner MCP defaults to no authentication for both local and public ingress; OAuth is required for team/member identity. Public `auth.mode: none` does not prove caller identity, so that endpoint must remain private to the owner. On the control port a caller that presents no credentials is the local owner in either mode, so clients on the owner's own computer keep working when sign-in is enabled for the public address; a caller that presents a token is exactly who the token says, or is refused.

Every service, capability, host and MCP call requires an explicit verified role; omitting identity never grants owner authority. The default `auth.mode: none` is the explicit single-owner trust model. Every request reaching `/mcp` receives owner authority. Keep such an endpoint private to the owner, including when a configured tunnel or HTTPS ingress is used.

Optional OAuth provides team/member identity. It uses the configured HTTPS issuer, resource-bound tokens, S256 PKCE, client metadata documents, one-use login and authorization codes, refresh rotation and grant revocation. Member authorization changes invalidate old grants. Dynamic client registration and copied static member tokens are not supported.

A configured public Host exposes the MCP and OAuth routes only. Local control, owner recovery, settings, host binding and the localhost UI remain private local surfaces. A local owner token does not authorize a public OAuth request. Tunnel process readiness is not proof of a working remote connection.

## Project access and trusted execution

What an editor window shares is the owner's setting (`devMate.shareFolders`). By default a trusted local folder opened in VS Code is shared with connected clients, read and write, and the window says so once with a way to change it; the owner can make any folder read only or take it out at any time, and a folder taken out stays out. The setting can instead ask first, share read only, or share nothing. Folders of an untrusted workspace are never shared. Each editor window acts only on its own selected project.

Because the default shares what is opened, a public address without sign-in gives whoever has it write access to every folder open in an editor that runs the extension. Use sign-in, or `ask`/`never`, when that is not intended.

What is shared, and how far, is decided by the owner at their computer: in an editor, on the command line (`devmate project add`), or in the local workbench. A client reaching DevMate through MCP, whether a model, a script or a workbench embedded in a chat app, cannot share a folder, cannot make a read-only project writable, cannot lift the credential-file protection and cannot change how a capability engine is set up. It can narrow all of these: make a project read only, take a folder out, switch an engine off. A folder taken out stays out, also for the folder above it and the folders inside it, until its owner shares it again. The two sharing settings of the VS Code extension are machine-scoped, so a repository's workspace settings cannot change them.

How far this holds depends on one thing. **A client with write access to any project can run commands, and commands run as the owner's operating-system account.** From there it can read any file the owner can read, including the owner token of this DevMate. So with at least one writable project, the limits on the *other* folders (read only, protected files, taken out) keep a well-behaved model from wandering; they are not a wall against a hostile one. With only read-only projects shared there are no commands and no agents, and the limits above are a boundary: that is the setting to use for a client you do not fully trust.

Decisions an agent waits for (approvals, questions) are the person's, and they are answered at the computer: in the editor, or in the local workbench. No client connected through MCP can answer them, whatever it declares about itself, because the caller may be the very model that started the agent. An embedded workbench shows what is waiting and says where to answer it.

### The full access profile

The two paragraphs above describe the default profile, *guarded*. The owner can replace it with *full access* (`devmate access full`, or the editor command). `access.update` is a local operation: no MCP path reaches it in either profile. The choice is stored with the instance, applies at once, and is reported by `devmate doctor`.

With full access, a caller that is the owner on any surface may do what otherwise needs the local one: share a folder (`project.create`), widen a project, lift the credential-file protection, configure capability engines, answer approvals and questions, and read what says why something does not work (`runtime.doctor`, `runtime.metrics`, the names of stored credentials, the full connection status). Credential-like files are no longer withheld from the owner in the file tools and the project overview, whatever a project's own setting says. What a delegated agent asks permission for is granted by the runtime at once, preferring the option that grants it one time, when the owner started the agent and the task it is working on is the owner's; every such grant is kept as an approval record marked automatic. A question an agent asks, and a permission request that offers no granting option, still wait for an answer.

What full access does not change:

- Members. An OAuth member keeps exactly its role and project grants: credential files stay withheld from it, it shares and answers nothing, and work it delegated waits for a person as before.
- The editor context. It is one state for every reader, so an open credential file stays out of it.
- Changing the installation: settings, stored credentials, starting or stopping the connection or the runtime, and the profile itself stay local, because a remote caller could cut its own route.
- Switching on the tools that read or write the memory of other processes (`allowProcessAccess`, `allowMemoryWrite`).

The `devmate` command line is the owner's interface, and a command a client runs is the owner's process. So every command and agent the runtime starts carries a marker in its environment, and a `devmate` that finds it tells the runtime so: it is then answered as a connected client, and it refuses to stop or reconfigure DevMate. A model that is told "folders are shared by the owner" and helpfully runs `devmate project add` through its shell tool is refused like its MCP call was. This stops the well-behaved case only. A client that removes the marker, or reads the owner token and calls the control port itself, is covered by the paragraph on write access above: the guarded profile is a boundary only where every shared project is read only.

With full access the last distance between "can reach `/mcp` as the owner" and "is the owner at the keyboard" is gone. With `auth.mode: none` on a public address that is everyone who learns the address; `devmate doctor` reports this combination as a warning.

Command lines are shown to others (process lists, a project's activity, jobs seen by another member) without the credentials written inline in them; the command that runs is unchanged. This recognises well-known forms only and is not a guarantee.

Credential-like files (`.env`, key files, `.npmrc` and similar) are withheld from the file tools by default and can be enabled per project by the owner. Git status names them, marked as protected, so they are not committed by accident; their content is never returned. The read-only Git tools accept only commits as revisions and never run a program the repository configures (filters, textconv, external diff). Executables DevMate starts itself are resolved to absolute paths on `PATH`, never in the project directory.

Members receive explicit project grants and read or write roles. Built-in file/resource APIs, collaboration records and MCP workbench snapshots enforce those grants. File operations check canonical project paths, reject symlink traversal and exclude the runtime control directory. File writes can require the hash observed when the file was read.

Write access is trusted local execution authority. Commands, native agents and domain engines may run with the host account's filesystem and network privileges. A project working directory or an API path check is not an operating-system sandbox. Give write access only to trusted participants; use an independently configured isolation boundary when that is required.

Configured external MCP servers may have independent machine-wide credentials and resources. Their discovery and calls are owner-only; members cannot reuse owner-configured MCP clients through an allowed project ID. Third-party annotations do not establish an authorization boundary.

## Native sessions and decisions

DevMate uses documented native provider interfaces and owns the processes it starts. It does not guess private desktop IPC, scrape web sessions, manufacture vendor account tokens or silently attach arbitrary existing sessions.

A session's communication token is restricted to its project/workflow and communication operations. It cannot choose another sender identity or resolve a user approval. Model-origin messages do not become user authorization.

Approvals retain the native options and return the selected option to the waiting request. Form answers are validated against the original request schema and returned to that request. Answer content is not persisted as an input response record. Requested form schemas and surrounding model/provider messages can still contain sensitive context; treat the private runtime database and logs accordingly.

Server-Sent Events are delivered from the journal by cursor: a slow reader pauses its own stream and nothing is buffered for it, so it can neither lose events nor grow the runtime's memory. A reader that stays blocked is released and resumes from its cursor when it reconnects.

Member OAuth principals carry their current authorization version. A queued command or capability job revalidates the member's enabled state, role, version and project grant immediately before the native effect; member updates/removal also cancel outstanding jobs. Explicit retries are attributed to the current authenticated caller. Cancellation cannot undo side effects that were already produced.

## Jobs and process ownership

Queued, running, completed, failed, cancelled and unknown outcomes are distinct. Interrupted execution is not silently replayed. Explicit retry creates a new execution record.

Cancellation is only reported as confirmed when the relevant native protocol or owned process provides the evidence. Failed cleanup retains owned resources for an explicit retry. CLI stop validates instance, generation, process and build identity; a PID read from a record is not sufficient authority to kill a process.

A runtime or project close drains owned jobs, capability clients, browsers and vault operations before disposing of their records. Host record writes needed by an already-running vault operation may finish during that drain through the locally authenticated, bound host interface.

## State and credentials

Each DevMate 4 instance uses its own SQLite database and private runtime records. Old instance state is not imported. Owner tokens, OAuth signing material, native session communication tokens, third-party MCP credentials and tunnel runtime keys belong to the local owner.

Connection credentials are stored in the private instance directory (`devmate secret set`, read from standard input) and handed only to the connector process that needs them; they are not placed in the environment project commands inherit and no operation returns them. A connector the runtime started is recorded so that a runtime which died without stopping it does not leave it running; only that exact process is ended, identified by program and start time. Do not publish runtime state, private project content, bearer tokens, login codes, raw provider logs or credentials in source, issues, screenshots or test fixtures. Third-party tool results and provider messages remain untrusted input.

## Obsidian and domain tools

Vault operations use the public Obsidian APIs through an explicitly attached desktop host. Batch previews, saved operation records and rollback apply to the documented vault operations; they do not undo arbitrary external commands. Disconnecting an HTTP request does not undo a native Vault operation already executing.

Browser and reverse-engineering tools require explicit project and local tool configuration. Their execution authority and optional native dependencies must be assessed as part of granting write access. Tests that skip an absent native backend do not prove that backend works on the deployment machine.

## Dependencies and verification

Review production dependency additions according to `AGENTS.md`. Use the official MCP and MCP Apps SDKs and package the third-party notices generated from the actual bundle. Keep native protocol versions and account readiness separate from package build success.

Protocol, per-request identity, project grants, file writes, job outcomes, process cleanup, host drains and UI wiring are exercised by the current runtime test suites. See [AUDIT-4.0.md](docs/AUDIT-4.0.md) for what was found, what was fixed and what could not be verified without real accounts and deployments.

## Reporting vulnerabilities

Only the latest 4.x release receives security fixes; 3.x is not maintained.

Report suspected security vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/Kukutx/DevMate/security/advisories/new) flow. Do not open a public issue for an undisclosed vulnerability.

## Known limits

- **Write access is full access.** See "Project access and trusted execution": a client with one writable project can act as the owner's operating-system account. DevMate has no sandbox.
- The runtime keeps running after the editor that started it is closed, until it is stopped (`devmate stop`, or **Stop DevMate Runtime** in the editor). A public connection stays up with it.
- An origin added to `allowedOrigins` may call the local MCP port from a browser, and on that port a caller without credentials is the owner. Add only the origin of a client you run yourself.
- A delegated Gemini CLI or Grok CLI session also loads the MCP servers configured in that CLI's own settings; DevMate cannot keep them out (it does for Codex and Claude Code). If DevMate itself is registered there, the delegated agent reaches it with the owner's authority.
- A command still running when the runtime dies is ended by the next runtime of that instance, if it had been running for more than a few seconds; a shorter one is not tracked and ends on its own. Processes a command left in the background after it exited itself are not tracked.
- Command redaction, protected paths and the read-only tools reduce what a connected model can see or do by accident. They are not a sandbox: commands run as the owner's operating-system account.
