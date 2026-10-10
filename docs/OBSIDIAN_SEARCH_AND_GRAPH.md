# Obsidian content search and note graph

Two bounded, read-only capabilities of an attached vault, called through `capability_call`. Attaching a vault and everything else about `obsidian.*` is in [OBSIDIAN_DATA_WORKFLOWS.md](OBSIDIAN_DATA_WORKFLOWS.md).

## Content search

`obsidian.content_search` reads note bodies through Obsidian's cached read and returns scored matches.

```json
{
  "capability": "obsidian.content_search",
  "input": { "query": "forest carbon", "mode": "all", "folder": "Research", "tagsAny": ["#paper", "#analysis"], "limit": 25 }
}
```

- `mode`: `phrase` (the exact phrase), `all` (every term) or `any`; `caseSensitive` is optional.
- The selector fields of `obsidian.note_query` (folder, paths, tags, Properties, modified time) narrow which notes are read.
- Notes are read newest first. Defaults and maxima: 1000 candidate notes (2000), 50 returned matches (200), 1 MiB per note (5 MiB), 8 concurrent reads (16), 280-character snippets (1000).
- Each match has a score, the matched terms, the occurrence count, the first matching line and a snippet. `stats` reports how many notes were selected, read and skipped; `truncated` says whether candidates or results were cut.

A search can take up to two minutes and is flagged `longRunning`: for a large vault start it with `job_start`, or narrow it with a selector. It does not block changes, and changes do not block it.

## Note graph

`obsidian.note_graph` walks the links Obsidian has resolved, without reading note bodies.

```json
{
  "capability": "obsidian.note_graph",
  "input": { "paths": ["Projects/DevMate.md"], "direction": "both", "depth": 2, "maxNodes": 200, "maxEdges": 500 }
}
```

- `paths`: 1 to 50 root notes.
- `direction`: `inbound`, `outbound` or `both`; `depth` 1 to 3.
- `maxNodes` up to 500, `maxEdges` up to 2000; `includeProperties` adds each note's Properties.

The result lists nodes with their distance from the nearest root, directed edges with link counts, roots that were not found, and truncation flags.

## Diagnostics

`obsidian.status` reports the index generation and refresh time, the last link-metric rebuild, statistics of the most recent content search (not its query), pending work, and per-operation request counts, error counts and durations. These numbers stay in the local Obsidian process and the runtime.

## Tests

`tests/obsidian-content-search.test.cjs`, `tests/obsidian-vault-graph.test.cjs`, `tests/obsidian-vault-index.test.cjs`, `tests/runtime-hosts.test.mjs`.
