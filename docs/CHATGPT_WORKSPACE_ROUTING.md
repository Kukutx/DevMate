# ChatGPT workspace routing contract

This behavior is a product invariant. Do not replace it with a different safety model, a fail-closed default, or a permanently persisted editor-default binding.

## Required state machine

A ChatGPT conversation has exactly two routing states:

### 1. Implicit host-default state

Before the user explicitly selects a project, project-scoped work uses the **current writable VS Code/Obsidian workspace**.

- If VS Code is on `Crew`, an unspecified ChatGPT request uses `Crew`.
- If the active host workspace changes before the conversation is explicitly pinned, the unspecified ChatGPT request follows the new host workspace.
- `source=auto` and `source=default` records are compatibility/default markers only. They are **not** explicit conversation ownership and must never trap the conversation on an old workspace.
- An implicit/default route must never prevent the user's first explicit project selection.

### 2. Explicit pinned state

As soon as the user explicitly selects a configured workspace ID/name or an exact absolute local path, that ChatGPT conversation becomes pinned to that project.

- The explicit project wins over the current VS Code/Obsidian workspace.
- Host workspace changes must not move the pinned conversation.
- Reconnects and long gaps must not move or expire the pinned conversation.
- A different project must not be adopted silently after pinning. Switching an already explicit binding is a deliberate `workspace_bind` operation.

## Workspace access model

The desktop UX uses these terms consistently:

- **Current Project** — the primary writable folder in the current VS Code/Obsidian host. This is the implicit default only.
- **Additional Workspaces** — explicit writable roots that DevMate may access without changing the Current Project. They are backed by `trustedWritableRoots` and appear as normal writable workspace IDs.
- **Reference Projects** — readonly context only. They never become writable merely because they are visible in the desktop host.

There is still one Current Project per desktop host/window. "Multiple workspaces" means the Gateway may expose the Current Project plus multiple explicitly authorized Additional Workspaces at the same time. It does **not** mean mutating a single global `activeWorkspaceId` into an array or making all roots implicit defaults.

This supports the intended workflow:

1. Open `Crew` in VS Code. It is the Current Project and the default for unpinned conversations.
2. Add `ProjectWaiting`, `FolioWeave`, or another directory as an Additional Workspace from VS Code, or authorize/select a path through the existing ChatGPT workspace tools.
3. A ChatGPT conversation may explicitly bind to one of those workspaces by ID/name or exact absolute path.
4. Other conversations can remain on Crew or bind to different workspaces concurrently.
5. An explicit conversation pin never changes the VS Code Current Project, and changing the VS Code Current Project never moves an explicitly pinned conversation.

The VS Code command `DevMate: Manage Workspaces` is the manual fallback and management surface. `DevMate: Add Workspace` adds an existing absolute directory. Removal stops the shared runtime before revoking a writable root so persistent processes cannot continue using a workspace after access is removed.

## Compatibility requirement

ChatGPT may temporarily cache an older MCP tool catalog. If `workspace_bind` is not visible, an existing `workspaceId` field on the first explicit project-scoped call is a compatibility selector and must establish the explicit binding before authorization can reject it as a workspace conflict.

## Non-goals

Do **not** implement any of these behaviors:

- "every new ChatGPT conversation must bind before doing project work";
- "the first editor-default workspace is permanently pinned to the conversation";
- "changing VS Code changes a conversation that was explicitly pinned elsewhere";
- "a stale `source=default` binding can block an explicit user-selected workspace";
- "adding another writable workspace changes the Current Project";
- "all writable roots become implicit defaults";
- "readonly reference projects become writable workspaces".

## Regression requirement

Changes to conversation routing or workspace access must keep tests for all of these cases green:

1. unspecified conversation uses the current host workspace;
2. implicit/default routing follows a host workspace switch;
3. first explicit selector replaces an unbound or implicit route;
4. explicit binding survives host switches and reconnect-style reuse;
5. explicit binding rejects silent project changes;
6. absolute-path narrowed bindings remain exact;
7. routing runs outside authorization so an explicit selector is handled before workspace-conflict checks;
8. the Current Project stays singular while multiple Additional Workspaces remain writable and independently addressable;
9. adding an Additional Workspace never changes `activeWorkspaceId`;
10. workspace access mutation requires `fullAccess` and protected control-plane roots are rejected.

If a proposed refactor changes any item above, it is a product behavior change and must not be merged as a bug fix.
