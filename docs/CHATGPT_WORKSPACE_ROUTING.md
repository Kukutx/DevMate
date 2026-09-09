# ChatGPT workspace routing contract

This behavior is a product invariant. Do not replace it with a globally drifting editor-default binding or a mandatory bind-before-read workflow.

## Required state machine

A ChatGPT conversation has two routing stages before and after its first concrete project selection.

### 1. Initial Current Project candidate

Before a conversation has used a project, DevMate chooses the shared **Current Project** as the initial candidate. The Current Project is changed by an explicit/automatic DevMate Start or another authoritative workspace activation, not by routine editor, selection, diagnostics, or host-context refreshes.

A generic VS Code host refresh may register its writable root and publish editor context, but it must not overwrite `activeWorkspaceId`. Multiple host windows merge their writable workspace registrations monotonically instead of replacing one another from stale snapshots.

### 2. Conversation-bound project

On the first project-scoped call, DevMate persists the selected/default workspace for that ChatGPT conversation. `source=auto` and `source=default` are replaceable defaults, but they remain stable for that conversation after creation.

- A later VS Code/Obsidian Current Project change does not move the existing conversation.
- A background desktop window cannot reroute it by publishing diagnostics or editor context.
- Reconnects and long gaps do not move or expire it.
- The user's first explicit workspace selector may replace an `auto/default` binding.
- After an explicit project selection, switching to a different project requires deliberate `workspace_bind`.

This gives a stable initial default without turning editor focus churn into an authorization/routing control plane.

## Workspace access model

The desktop UX uses these terms consistently:

- **Current Project** — the machine-shared primary writable workspace selected by authoritative host activation. It is only the initial candidate for a new conversation.
- **Additional Workspaces** — explicit writable roots that DevMate may access without changing the Current Project. They are backed by `trustedWritableRoots` and appear as normal writable workspace IDs.
- **Reference Projects** — readonly context only. They never become writable merely because they are visible in the desktop host.

There is one shared Current Project for the desktop DevMate instance. Multiple VS Code/Obsidian hosts may register writable roots concurrently, but routine context refresh cannot steal Current Project authority from another host.

This supports the intended workflow:

1. Start DevMate from `Crew`; `Crew` becomes the Current Project.
2. A new ChatGPT conversation's first project-scoped call defaults to `Crew` and persists that conversation binding.
3. Open or use another VS Code/Obsidian host. Its background diagnostics/context refresh may register the workspace but cannot move the existing conversation or steal Current Project.
4. Run Start/activate deliberately in another project when that project should become the initial default for future conversations.
5. Existing conversations remain bound to their own projects; use `workspace_bind` to switch deliberately.
6. Additional Workspaces remain independently addressable without changing the Current Project.

The VS Code command `DevMate: Manage Workspaces` is the manual fallback and management surface. `DevMate: Add Workspace` adds an existing absolute directory. Removal stops the shared runtime before revoking a writable root so persistent processes cannot continue using a workspace after access is removed.

## Compatibility requirement

ChatGPT may temporarily cache an older MCP tool catalog. If `workspace_bind` is not visible, an existing `workspaceId` field on the first explicit project-scoped call is a compatibility selector and must establish the explicit binding before authorization can reject it as a workspace conflict.

## Non-goals

Do **not** implement any of these behaviors:

- "every new ChatGPT conversation must bind before doing project work";
- "routine editor/diagnostic activity changes the machine Current Project";
- "a later host workspace change silently moves an already-used conversation";
- "a stale `source=default` binding can block the user's first explicit project selection";
- "adding another writable workspace changes the Current Project";
- "all writable roots become implicit defaults";
- "readonly reference projects become writable workspaces".

## Regression requirement

Changes to conversation routing or workspace access must keep tests for all of these cases green:

1. an unbound conversation uses the Current Project as its first default candidate;
2. first project use persists a stable conversation default;
3. routine host workspace/context refresh cannot replace `activeWorkspaceId`;
4. stale host workspace snapshots preserve already-registered writable roots;
5. first explicit selector replaces an unbound or `auto/default` route;
6. explicit binding survives host switches and reconnect-style reuse;
7. explicit binding rejects silent project changes;
8. absolute-path narrowed bindings remain exact;
9. routing runs outside authorization so an explicit selector is handled before workspace-conflict checks;
10. the Current Project stays singular while multiple Additional Workspaces remain writable and independently addressable;
11. adding an Additional Workspace never changes `activeWorkspaceId`;
12. workspace access mutation requires `fullAccess` and protected control-plane roots are rejected.

If a proposed refactor changes any item above, it is a product behavior change and must not be merged as a bug fix.
