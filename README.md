# dsh-workspace-sort

A DeepSeek Harness Host plugin that keeps the sidebar's Workspace sections in
activity order:

1. **Workspaces with a running Session come first**, sorted alphabetically by
   workspace name.
2. **Every other workspace follows by its most recent Session activity**,
   newest first; equal activity falls back to workspace name.
3. **Sessions themselves are never reordered.** The sorter only moves whole
   Workspace sections, so a busy Session lifts the workspace that contains it,
   not the Session row.

## How it works

The sidebar renders Workspace sections in the durable Workspace registry
order (`ctx.workspaceRegistry.list()`, which the client follows through the
Workspace Controller stream). There is no separate client-side Workspace sort
hook, so this plugin expresses the result by rewriting that durable order
through `ctx.workspaceRegistry.insertBefore` — one whole-workspace move at a
time. A Session's position inside its workspace is independent of this and is
never touched.

Data sources:

| Input | Source |
| --- | --- |
| Workspace rows, titles, Session membership, registry order | `ctx.workspaceRegistry` |
| Archived Sessions (excluded from activity) | `ctx.workspaceRegistry.archivedSessionIds` |
| Session last-activity time and running flag | `ctx.sessionController.list()` baseline, then the `api-session/activity`, `api-session/status`, `api-session/added`, `api-session/removed` events |
| Workspace creation/deletion/rename/manual reorder | the `domain/changed` event, filtered to the `workspace` domain |

Recomputations are debounced. A pass reads the committed order, computes the
desired order, and applies only the moves needed; when the order already
matches, nothing is written. A startup Session baseline is required before the
first pass, and it is retried a few times if the Session controller is
temporarily unavailable — the plugin stays passive rather than guessing an
order from incomplete data.

Blank draft Sessions and `origin: 'subagent'` Sessions are ignored for both
activity and the running flag: the sidebar hides them, so they do not date a
workspace.

## Configuration

Row id `workspace-sort`, package `dsh-workspace-sort`:

```yaml
- insert:
    - id: workspace-sort
      name: dsh-workspace-sort
      config:
        enabled: true
        debounceMs: 350
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the plugin loaded but stops all reordering. |
| `debounceMs` | `350` | Quiet period after an activity change before a reorder pass. |

## Install

From this directory:

```
plugin_manager action=install_bundle target=<absolute path to this directory>
```

The bundle declares the `workspace-sort` row through `dsh.bundle.patch`.

## Known limitations

- **The sorted order is durable.** Because the Web client's Workspace order is
  the Host registry order, sorting rewrites it. A manual Workspace drag stays
  until the next activity change re-sorts the list; disabling the plugin leaves
  the last computed order in place.
- **"Active" means a running Agent turn.** Waiting-for-approval and
  waiting-for-answer states are part of a running turn, so they count.
  Client-only notions such as "finished but not yet viewed" do not.
- **Activity time is the Host session-list activity time**: the latest
  user-authored durable message (and the session creation time), matching the
  sidebar's own "Last updated" ordering.
- The plugin does not reorder the "Ungrouped" bucket: only registered
  Workspaces take part.

## Development

```
node --test tests/
```
