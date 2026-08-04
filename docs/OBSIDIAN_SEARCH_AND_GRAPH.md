# Obsidian Content Search and Note Graph

DevMate's Obsidian host exposes two bounded, read-only knowledge workflows in addition to metadata queries.

## Content search

`obsidian_content_search` reads Markdown notes through Obsidian's `Vault.cachedRead()` API and returns deterministic, bounded results.

Supported controls:

- metadata selectors: folder, path, tag, Property, and modified time
- search modes: exact phrase, all terms, or any term
- optional case-sensitive matching
- candidate, result, file-size, snippet, and concurrency limits
- result score, first matching line, occurrence count, and a compact snippet

The default limits are intentionally conservative: at most 1,000 candidate notes, 50 returned matches, 1 MiB per note, and 8 concurrent reads. The bridge never stores the query text in diagnostics.

Example:

```json
{
  "query": "forest carbon",
  "mode": "all",
  "folder": "Research",
  "tagsAny": ["paper", "analysis"],
  "limit": 25
}
```

## Note graph

`obsidian_note_graph` traverses Obsidian's resolved internal links without reading note bodies.

Supported controls:

- one to 50 root note paths
- inbound, outbound, or bidirectional traversal
- depth from one to three
- explicit node and edge limits
- optional Property inclusion

The response contains deterministic nodes with their distance from the nearest root, directed edges with link counts, missing roots, and truncation flags.

Example:

```json
{
  "paths": ["Projects/DevMate.md"],
  "direction": "both",
  "depth": 2,
  "maxNodes": 200,
  "maxEdges": 500
}
```

## Local diagnostics

`obsidian_status` now reports:

- index generation and refresh timestamps
- the most recent link-metric rebuild
- aggregate statistics from the most recent content search, without its query
- in-memory request counts, failures, and action latency summaries

These diagnostics remain inside the local Obsidian process and are not sent to an analytics service.
