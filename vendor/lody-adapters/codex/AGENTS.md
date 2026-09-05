# Repository Guidelines

## Pull Requests

- Always open pull requests against the `LodyAI` organization repository
  (`LodyAI/acp-extension-codex`), not a personal fork.

## Project Structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — Vitest suite (behavior-focused tests around ACP/Codex events).
- `src/app-server/` — generated Codex app-server API types (regenerate via `npm run generate-types`).
- `dist/bin/` — release-ready single-file executables and `*.zip` archives.

## Coding Style & Naming Conventions

- Keep edits consistent with existing formatting.
- When adding env/config knobs, document them in `readme-dev.md`.
- Lody may launch the adapter from an Electron or daemon process with no Windows console.
  Set `windowsHide: true` on every adapter-owned console-subsystem child process spawn;
  `ELECTRON_RUN_AS_NODE` is a separate runtime-mode concern.
- When updating discriminated-union/event `switch` statements, do not add a trailing fallback like `return null` only to satisfy TypeScript.
- Handle each variant with an explicit `case`; if intentionally ignored, use an explicit no-op case.

## Testing Guidelines

- Tests live under `src/__tests__/` and use Vitest.
- Favor event-driven assertions (see `src/__tests__/CodexACPAgent/*`).
- Prefer snapshot-based tests using `toMatchFileSnapshot()` over inline assertions.
- When snapshot response data drifts, prefer replacing that response payload with a stable placeholder over asserting fragile fields (except for 'model/list').
- Focus on behavior and outputs rather than implementation details.
- Use `/run-codex` skill (`.claude/skills/run-codex/`) to test with real Codex and observe actual events.

## Docs

- Codex app-server usage: see https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md when touching protocol/transport details, adding or consuming JSON-RPC methods, handling approvals/turn events, or updating generated schema/clients.
- App-server events: prefer `thread/*`, `turn/*`, and `item/*` event surfaces; avoid the deprecated `codex/event/*` API (planned removal). Keep implementations aligned with generated types in `src/app-server` (including `v2` exports).
- Steer uses app-server `turn/steer` on the tracked active turn. Correlate `clientUserMessageId` and acknowledge only the matching `item/completed(userMessage)`; never emulate steer with a second `turn/start`.
- Session fork uses app-server `thread/fork` and installs the returned child as an independent ACP
  session. Agent message updates expose their Codex turn id as `_meta.lody.turnId`;
  `_meta.lody.forkAtTurn.turnId` is passed directly to `thread/fork.lastTurnId`. Do not maintain
  a message-id mapping or emulate fork by replaying source history.
- Codex reasoning summaries can echo trailing empty HTML comments from model instructions. Keep
  that provider-specific cleanup in `src/ReasoningText.ts` across live deltas and history replay;
  do not filter assistant text, raw reasoning, or HTML globally in the client renderer.
- App-server `warning` and `configWarning` notifications are structured ACP session info updates:
  put `{ level, message, source }` under `_meta.lody.notice`. Never emit them as agent message text;
  Lody persists that metadata as an `agent_warning` system notice, and text chunks would pollute
  assistant history, generated titles, and replayed prompts.
- App-server terminal `error` notifications are also control-plane state, never agent message text.
  Record a prompt failure for every non-retry error and publish structured `_meta.codex.error`
  metadata only. Redact any Lody internal-instruction tail at this adapter boundary before putting
  provider errors in ACP metadata or `RequestError` data. Session title updates must identify
  `_meta.lody.titleSource` as `explicit`,
  `fallback`, or `unset` so hosts can accept real names without mistaking prompt previews for
  generated titles.
- Account rate-limit windows are dynamic. Read the full `account/rateLimits/read` snapshot when a
  session opens, merge sparse `account/rateLimits/updated` values into that snapshot, and preserve
  each native window's `windowDurationMins` when mapping it to Core's
  `windowDurationSeconds`. Never infer 5-hour/7-day meaning from `primary`/`secondary` position.
