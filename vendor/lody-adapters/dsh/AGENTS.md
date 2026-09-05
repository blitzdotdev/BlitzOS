# acp-extension-dsh contributor guide

This package is the provider-owned integration boundary between ACP and DeepSeek
Harness. Keep it usable without importing Lody packages.

## Ownership

- `src/adapter.ts` owns ACP lifecycle, prompt streaming, model/reasoning changes,
  permission-preset selection, blank-session Agent preset composition, and
  session-scoped mounting of ACP stdio/HTTP servers through `dsh-mcp-client`.
- `src/capabilities.ts` owns the static preflight metadata shared with host UIs.
  Each ACP session must instead derive its model selector, legacy `models`
  response, and image admission from the Harness LLM catalog returned by
  `ctx.llm.listModels()`. Do not override that catalog in the generated profile.
  Persist accepted image bytes through the Harness attachment service before
  queuing the user message.
- `src/profile.ts` owns the pinned Harness version, explicit npx package closure,
  and ACP host-plane composition. Keep every transitive DSH dependency and peer
  package in that exact-version closure; Harness caret ranges must never let npm
  mix a later release candidate into a cold install. `presets/` is the pinned copy
  of the official `standard`/`code`/`minimal`/`cordis` Agent presets; update it
  together with the package list and retain the upstream notice. It is excluded
  from Prettier so the vendored files remain byte-identical to upstream.
  Its persistence default matches upstream `zstd`; hosts may select legacy raw
  `none` only after inspecting an existing single-encoding root. A mixed root is
  an error and must never trigger automatic artifact mutation or deletion.
  Keep the SQLite session-query service mounted with `openAt: never`: this ACP
  composition needs its exact-read contract but exposes no full-text search,
  and public Node builds do not reliably include SQLite FTS5.
  The `0.1.1-rc.2` package family cold-installs under npm 10 with the complete
  same-version closure. Keep the closure exact and do not add `--force` or
  `--legacy-peer-deps`; either would hide a future peer-graph regression.
- `src/capabilities.ts` metadata is authoritative for built-in preset labels exposed
  through ACP. Harness runtime metadata remains authoritative for user presets.
- Hosts own installation caches, data-directory selection, process supervision,
  credentials, and bundling.

The profile and adapter must change together when a selector or Harness service
contract changes. Credentials must remain in the host environment and must never
be rendered into a generated profile.

ACP MCP server names become Harness tool namespaces. Preserve an already-valid,
available name; normalize invalid names and suffix concurrent collisions so two
live ACP sessions cannot contend for the native client's process-global namespace.
MCP plugin fibers belong to the Agent context and must settle before `session/new`
returns, so failed startup cannot publish a session without its requested tools.
Forward `assistant/chunk` reasoning deltas immediately as ACP thought chunks and emit
`\n\n` when their reasoning block ends, matching Lody's semantic thought-section
separator. Harness may retry after emitting them, and the adapter intentionally does
not retract or deduplicate those already-visible thoughts; do not replay final reasoning
blocks.
Translate Harness's durable `compaction/start` / `compaction/end` bracket into one
standard ACP tool-call lifecycle. Compaction meaning belongs only in the shared
`_meta.lody.activity` contract from `acp-extension-core`; manual compaction has a
`null` Harness turn owner and automatic compaction has a numeric owner.

## Checks

Run `npm run build`, `npm test`, and `npm run format:check` before publishing a
change. Node.js 22 or newer is required.
