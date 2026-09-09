# ChatGPT workspace routing contract

This behavior is a product invariant. A machine-wide DevMate instance may have multiple desktop hosts, but one ChatGPT conversation must not drift between projects merely because another VS Code/Obsidian window becomes active.

## Required state machine

A ChatGPT conversation has exactly three practical routing states:

### 1. Unbound state

Before project-scoped work has selected a workspace, DevMate may use the current writable VS Code/Obsidian workspace as the **initial default candidate**.

- A new conversation opened while VS Code is on `Crew` may begin on `Crew`.
- The machine-wide `activeWorkspaceId` is only a host/UI hint for choosing that initial default. It is not persistent authority over an existing conversation.
- If the user supplies an explicit workspace ID/name or exact local path on the first project-scoped call, that selector wins immediately.

### 2. Sticky default state

Once an unspecified project-scoped call has actually established `source=auto` or `source=default`, that stored workspace becomes the conversation's stable default.

- A different VS Code/Obsidian window may later change the machine-wide `activeWorkspaceId`; the existing conversation stays on its stored default.
- Reconnects and long gaps do not move the stored default.
- The default remains **implicit** in one important sense: the user's first explicit project selector is still allowed to replace it without a separate unbind step.
- Therefore `source=auto` / `source=default` means “sticky default, still replaceable by an explicit selection”, not “follow whichever host was active most recently”.

This prevents unrelated editor/window activity from silently rerouting a ChatGPT conversation while preserving a low-friction first use.

### 3. Explicit pinned state

As soon as the user explicitly selects a configured workspace ID/name or an exact absolute local path, that ChatGPT conversation becomes pinned to that project.

- The explicit project wins over the current VS Code/Obsidian workspace.
- Host workspace changes must not move the pinned conversation.
- Reconnects and long gaps must not move or expire the pinned conversation.
- A different project must not be adopted silently after pinning. Switching an already explicit binding is a deliberate `workspace_bind` operation.

## Workspace access model

The desktop UX uses these terms consistently:

- **Current Project** — the primary writable folder in a VS Code/Obsidian host. It is only an initial default candidate for conversations that have not established a route yet.
- **Additional Workspaces** — explicit writable roots that DevMate may access without changing the Current Project. They are backed by `trustedWritableRoots` and appear as normal writable workspace IDs.
- **Reference Projects** — readonly context only. They never become writable merely because they are visible in the desktop host.

There is still one Current Project per desktop host/window. "Multiple workspaces" means the Gateway may expose the Current Project plus multiple explicitly authorized Additional Workspaces at the same time. It does **not** mean mutating a single global `activeWorkspaceId` into an array or making all roots implicit defaults.

This supports the intended workflow:

1. Open `Crew` in VS Code. A new unbound ChatGPT conversation may choose Crew as its initial default.
2. Once that conversation performs project-scoped work on Crew, Crew becomes its sticky default; another window cannot move it.
3. Add `ProjectWaiting`, `FolioWeave`, or another directory as an Additional Workspace from VS Code, or authorize/select a path through the existing ChatGPT workspace tools.
4. The conversation may explicitly select one of those workspaces by ID/name or exact absolute path; that replaces its implicit default and creates an explicit pin.
5. Other conversations can independently keep different sticky defaults or explicit pins.
6. No conversation routing decision changes the VS Code Current Project.

The VS Code command `DevMate: Manage Workspaces` is the manual fallback and management surface. `DevMate: Add Workspace` adds an existing absolute directory. Removal stops the shared runtime before revoking a writable root so persistent processes cannot continue using a workspace after access is removed.

## Compatibility requirement

ChatGPT may temporarily cache an older MCP tool catalog. If `workspace_bind` is not visible, an existing `workspaceId` field on the first explicit project-scoped call is a compatibility selector and must establish the explicit binding before authorization can reject it as a workspace conflict.

## Access diagnostics

`effective_access_status` is the canonical explanation surface when a conversation can read but cannot mutate a workspace. It reports the shared permission policy and generation, authenticated principal role, conversation binding, workspace mode, lease state, per-capability allow/deny decisions, and concrete blocker codes.

A displayed local profile such as `fullAccess` is not by itself proof that every operation is allowed: OAuth/member role, member workspace scope, readonly/reference workspace state, optional workspace leases, and operation-specific safety guards remain independent policy layers.

## Non-goals

Do **not** implement any of these behaviors:

- "every new ChatGPT conversation must bind before doing project work";
- "an established default conversation follows whichever desktop window updates `activeWorkspaceId` most recently";
- "changing VS Code changes a conversation that already has a sticky default or explicit pin";
- "a stale `source=default` binding can block the user's first explicit workspace selection";
- "adding another writable workspace changes the Current Project";
- "all writable roots become implicit defaults";
- "readonly reference projects become writable workspaces".

## Regression requirement

Changes to conversation routing or workspace access must keep tests for all of these cases green:

1. an unbound conversation may use the current host workspace as its initial default candidate;
2. once an implicit/default binding exists, later host `activeWorkspaceId` changes do not move it;
3. first explicit selector replaces an unbound or implicit route;
4. explicit binding survives host switches and reconnect-style reuse;
5. explicit binding rejects silent project changes;
6. absolute-path narrowed bindings remain exact;
7. routing runs outside authorization so an explicit selector is handled before workspace-conflict checks;
8. the Current Project stays singular while multiple Additional Workspaces remain writable and independently addressable;
9. adding an Additional Workspace never changes `activeWorkspaceId`;
10. workspace access mutation requires the appropriate effective access and protected control-plane roots are rejected;
11. `effective_access_status` explains role, workspace, lease, and shared-profile blockers without exposing workspace filesystem roots.

If a proposed refactor changes any item above, it is a product behavior change and must not be merged as a bug fix.
