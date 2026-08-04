# Design references

DevMate uses original implementation code. The following open-source projects and official resources were reviewed for architectural patterns that fit this project.

## Obsidian sample plugin

Repository: https://github.com/obsidianmd/obsidian-sample-plugin

Adopted principles:

- keep plugin lifecycle and settings code explicit;
- perform heavier initialization after the workspace layout is ready;
- ship standard `main.js`, `manifest.json`, and `styles.css` assets;
- maintain `versions.json` compatibility metadata;
- validate release metadata and bundles in CI.

## Obsidian API

Repository: https://github.com/obsidianmd/obsidian-api

Adopted principles:

- use public Vault, MetadataCache, FileManager, Workspace, and event APIs;
- use `processFrontMatter`, `renameFile`, and `trashFile` instead of editing private state;
- keep desktop-only Node integration clearly separated from Obsidian API integration.

## Dataview

Repository: https://github.com/blacksmithgu/obsidian-dataview

Adopted principles:

- separate a read-oriented metadata index from mutation workflows;
- query normalized note metadata instead of repeatedly scanning every file;
- keep Markdown/Properties as source data rather than creating a competing private database.

DevMate does not embed Dataview or depend on its query language.

## Obsidian Tasks

Repository: https://github.com/obsidian-tasks-group/obsidian-tasks

Adopted principles:

- bound query result sizes;
- centralize filtering and deterministic ordering;
- make performance-sensitive vault-wide operations incremental;
- separate read/query behavior from explicit mutations.

## Deliberately not adopted

- no direct edits to `.obsidian` internals;
- no hidden SQLite or proprietary vault database;
- no implicit large-scale mutation from a read/query request;
- no automatic continuation of an interrupted batch whose exact side effects are uncertain;
- no dependency on discontinued project-management plugins.
