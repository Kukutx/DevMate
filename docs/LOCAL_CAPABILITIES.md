# Trusted local capabilities

DevMate provides two bounded local-development capabilities:

1. Explicit trusted writable roots outside the current VS Code folder.
2. Persistent process management for development servers, watchers, interactive CLIs, and other long-running commands.

These features extend convenience without turning the normal file tools into unrestricted filesystem access.

## Permission model

- The current VS Code folder remains the active writable workspace.
- Readonly References remain readonly.
- Adding or removing a trusted writable root requires the `fullAccess` permission profile.
- Persistent process execution is blocked by `readOnly` and follows the existing dangerous-command guard in `balanced` mode.
- Processes run as the operating-system user that launched VS Code. DevMate cannot bypass UAC, filesystem ACLs, `sudo`, containers, Remote SSH boundaries, or other OS controls.
- Public MCP access still requires the DevMate connection token by default.

## Trusted writable roots

Use a trusted root when ChatGPT needs normal DevMate file and Git tools against another local directory without changing the active VS Code project.

### Add a root

```text
Use add_trusted_root with an existing absolute directory path.
```

The operation:

- rejects relative paths;
- rejects filesystem roots such as `C:\` or `/`;
- resolves symbolic links and reparse points;
- deduplicates paths using their real location;
- stores only the explicit directory in DevMate `config.json`;
- exposes it as a normal writable workspace ID to existing file, command, validation, and Git tools.

### List and remove roots

Use `list_trusted_roots` to obtain stable workspace IDs. Use `remove_trusted_root` with either the ID or absolute path.

Removal does not delete the directory. If persistent processes are still running in that root, removal is refused unless `stopProcesses=true`, in which case DevMate stops those process trees first.

### Existing file protections

Trusted roots do not disable the existing safe-path policy. Normal file tools continue to block:

- hidden generated directories such as `.git` and `node_modules`;
- credential and secret directories;
- private keys and certificates;
- real `.env` files;
- databases, logs, and unsupported binary files;
- paths that escape the trusted root through `..`, symlinks, or reparse points.

Arbitrary shell commands remain intentionally powerful under `fullAccess`; review the connection token and only trust directories needed for development.

## Persistent processes

One-shot commands remain available through `run_command`. Use persistent processes when a command must stay alive across MCP calls.

Typical examples:

- `npm run dev`
- `dotnet watch`
- `flutter run`
- file watchers
- local API servers
- interactive REPL or CLI sessions

### Lifecycle

1. `start_process` launches a command inside a writable workspace or trusted root.
2. `read_process_output` reads stdout, stderr, and lifecycle messages using a sequence cursor.
3. `send_process_input` writes to stdin when the child process accepts input.
4. `process_status` or `list_processes` reports state and exit information.
5. `stop_process` terminates the complete process tree.

All remaining persistent processes are terminated when the DevMate gateway exits.

### Output cursor

`read_process_output` returns:

- `firstAvailableSequence`: earliest retained event;
- `nextSequence`: cursor to pass as the next `afterSequence`;
- `missed`: true when older output was discarded by the retention bound;
- `events`: ordered stdout, stderr, and system events.

Use the returned `nextSequence` to avoid receiving duplicate output.

### Limits

Defaults:

- maximum simultaneous processes: `8`;
- retained output per process: `1 MiB`;
- completed-process metadata retention: approximately one hour;
- hard upper bounds: `32` processes and `20 MiB` per process.

Use `configure_local_capabilities` to adjust the first two values. Use `local_capabilities_status` to inspect effective values and current utilization.

### Process-tree termination

- On Windows, DevMate uses `taskkill /T` and escalates to `/F` if necessary.
- On POSIX systems, DevMate creates a process group and sends `SIGTERM`, then `SIGKILL` after a short grace period if necessary.

This avoids leaving common child processes, watchers, and shells orphaned after a stop request.

## Recommended private-use configuration

```json
{
  "devMate.permissionProfile": "fullAccess",
  "devMate.blockDangerousOperations": false,
  "devMate.confirmBeforePush": false,
  "devMate.allowDirectoryMutations": true,
  "devMate.requireAuthToken": true
}
```

Keep `devMate.requireAuthToken` enabled. Trusted roots and persistent commands increase the value of the local gateway, so the public MCP URL must continue to be treated as a secret.
