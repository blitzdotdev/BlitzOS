# BlitzOS Agent Activity Details Plan

Status: planned
Owner area: V1 island Chat details / agent activity

## Summary

Replace the current inline Details row, which shows raw Claude tool labels like `Run Background wait for next message`, with a user-facing activity model derived from Claude Code's canonical session JSONL.

The goal is not to rewrite the agent runtime. V1 agents currently run interactive Claude Code TUI inside tmux so the user can watch the real terminal. Keep that runtime. Borrow the cc-web architecture pattern instead: parse Claude activity into an app-owned normalized protocol, then render that protocol in the island.

First pass should make the Details row feel like:

- `Thinking...`
- `Read package.json`
- `Searched for markdown renderer`
- `Ran typecheck`
- `Edited IslandPanel.tsx`
- `Waiting for your response`
- `Done`

Instead of:

- `Run Background wait for next message`
- `Read b2qdbnlgc.output`
- `Run Send Blitz UI build prompts`

## Current State

- `src/main/agent-transcript.mjs` already locates and reads Claude Code session JSONL at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- `readSessionEvents()` currently normalizes only a small shape: `tool`, `text`, and `result`.
- `src/main/osActions.ts` exposes `osAgentDetails(id)`, which filters the transcript to recent `tool` events only and returns `{ rows: [{ label }] }`.
- `src/preload/index.ts` exposes `agentDetails(id)`.
- `src/renderer/src/notch/IslandPanel.tsx` polls `agentDetails()` every 2.5s while active and renders `detailRows`.
- The renderer currently shows raw labels directly in `.isl-inline-details`.

## Reference Architecture

The cc-web note recommends this pipeline:

```text
Claude Code process
  -> raw stream / hooks / transcript JSONL
  -> backend event normalizer
  -> backend turn accumulator
  -> frontend reducer
  -> ThinkingCard / details UI
```

Blitz should follow the same shape, with one important V1 adaptation:

- cc-web's cleanest path uses `claude -p --output-format stream-json --include-partial-messages --verbose`.
- Blitz V1 uses interactive Claude TUI in tmux, not print mode.
- Therefore the first pass should use the existing session JSONL reader, not stream-json runtime replacement.

## Goals

- Show human-readable agent activity inside the chat transcript.
- Hide Blitz plumbing and wait-loop implementation details.
- Treat thinking, tool calls, tool results, assistant replies, and waiting states as first-class activity items.
- Keep the current agent runtime, tmux terminal behavior, chat transcript, and `/say` data flow unchanged.
- Preserve the inline collapsed row plus expandable history pattern.
- Make the renderer consume structured data instead of raw strings.

## Non-Goals

- Do not switch default agents to `claude -p stream-json`.
- Do not implement token streaming here.
- Do not expose raw tool inputs or full tool results in the island.
- Do not show private reasoning text unless Claude Code explicitly persists readable thinking text. Even then, keep it optional and collapsed.
- Do not involve the supervisor/deep-supervision loop yet.
- Do not add new canvas/surface concepts.

## Data Model

Add a normalized activity item type. Keep the old `{ rows }` response during migration.

```ts
export type AgentActivityItem =
  | {
      kind: 'thinking'
      id: string
      status: 'active' | 'done'
      label: string
      text?: string
      startedAt?: number
      durationMs?: number
    }
  | {
      kind: 'tool'
      id: string
      status: 'running' | 'done' | 'error'
      tool: string
      label: string
      detail?: string
      ts?: number
    }
  | {
      kind: 'assistant'
      id: string
      label: string
      ts?: number
    }
  | {
      kind: 'waiting'
      id: string
      label: string
      ts?: number
    }
  | {
      kind: 'done'
      id: string
      label: string
      ts?: number
    }
```

Initial preload shape:

```ts
agentDetails(id: string): Promise<{
  items: AgentActivityItem[]
  rows: Array<{ label: string }>
}>
```

## Backend Plan

### 1. Upgrade `agent-transcript.mjs`

Add `readSessionActivity(jsonlPath, sinceOffset = 0)` or extend `readSessionEvents()` carefully.

Parse these Claude JSONL shapes:

- `assistant.message.content[].type === 'thinking'`
- `assistant.message.content[].type === 'text'`
- `assistant.message.content[].type === 'tool_use'`
- `user.message.content[].type === 'tool_result'`

For `tool_use`:

- Preserve `id` when present.
- Normalize tool display through a new `activityToolLabel(name, input)`.
- Keep `toolRow()` and `toolLabel()` for compatibility if other code uses them.

For `tool_result`:

- Match by `tool_use_id` when available.
- Mark the matching tool `done` or `error`.
- Do not expose raw result body in V1, except maybe a tiny safe error summary later.

For `thinking`:

- Emit a thinking item even if text is empty.
- If readable `thinking` text exists, include a clipped version.
- If only signature/encrypted content exists, use label-only state like `Thinking`.

For `text`:

- If text is visible assistant prose, emit a compact `assistant` item like `Replied`.
- Do not duplicate full chat content in Details.

### 2. Filter Blitz Plumbing

Add a single filter helper before items reach the renderer.

Hide or de-emphasize:

- `wait.sh`
- `/events`
- `/say`
- `curl .../say`
- `curl .../events`
- `Background wait for next/new message`
- temporary `.output` file reads from background Bash tasks
- relay-url reads
- bootstrap/manual recovery commands unless they failed

Important: this filter should hide infrastructure, not real work. A user-facing Bash command like `npm run typecheck` should remain visible.

### 3. Build a Turn Accumulator

The JSONL file is append-only and event ordering can be weird because Claude TUI, tool results, and transcript writes race.

Add a small accumulator:

- Maintains items in order.
- Keeps open thinking item until a tool/text/done signal closes it.
- Keeps open tool item until matching tool result arrives.
- Computes `durationMs` when possible from timestamps.
- Produces a compact recent slice for the island, for example last 40 items.

First pass can rebuild from the whole file on `osAgentDetails()` call, because this is already a one-shot/poll path and bounded to recent display. If it becomes slow, add offset caching per agent later.

### 4. Update `osAgentDetails`

Return:

```ts
{
  items: AgentActivityItem[],
  rows: items.map(itemToLegacyRow)
}
```

Keep `rows` until the renderer and tests have fully moved.

## Renderer Plan

### 1. Add Types

Update `src/renderer/src/notch/types.ts` or a local type in `IslandPanel.tsx`:

```ts
type AgentActivityItem = ...
```

Then update preload typing in `src/preload/index.ts`.

### 2. Replace `detailRows` With Activity Items

In `IslandPanel.tsx`:

- Rename `detailRows` to `activityItems`.
- Keep a legacy fallback: if `items` is absent, map `rows` to plain tool items.
- `latestDetail` should use the last meaningful activity item.
- Collapsed row should render:
  - status dot/icon
  - `Thinking...`, `Running typecheck...`, `Edited file`, `Waiting for your response`, etc.
  - caret

### 3. Render Expanded Timeline

Replace plain bullets with richer rows:

- `thinking`: subtle shimmer/dot, `Thinking` or `Thought for 8s`
- `tool running`: spinner/dot, verb label
- `tool done`: muted check/dot
- `tool error`: warning color
- `assistant`: `Replied`
- `waiting`: yellow or blue attention state
- `done`: quiet check

Keep it compact. This lives inside the transcript, so avoid a huge debug console look.

### 4. Copy Guidelines

Use user-facing phrases:

- `Thinking`
- `Checking files`
- `Reading package.json`
- `Editing IslandPanel.tsx`
- `Running typecheck`
- `Searching web`
- `Waiting for your response`
- `Finished`

Avoid implementation phrases:

- `Background wait`
- `curl`
- `events`
- `relay`
- `.output`
- `tool_result`
- `session JSONL`

## Tool Label Normalization

Recommended labels:

| Tool | Label |
| --- | --- |
| `Read` | `Read <file>` |
| `Write` | `Wrote <file>` |
| `Edit` / `MultiEdit` | `Edited <file>` |
| `Bash` with description | `Ran <description>` |
| `Bash` without description | `Ran command` |
| `Grep` | `Searched files` or `Searched for "<pattern>"` |
| `Glob` | `Found files` |
| `WebSearch` | `Searched web` |
| `WebFetch` | `Read webpage` |
| `Task` | `Asked subagent` |
| `TodoWrite` | `Updated plan` |
| Blitz UI choice prompt | `Waiting for your response` |

Keep details optional, clipped, and never dump raw command arguments if they are long or sensitive.

## Thinking Details

Claude Code transcript thinking blocks may be:

- readable text,
- empty,
- encrypted/signature-only,
- absent.

So the UI should not depend on readable thinking content.

First-pass behavior:

- If a thinking block appears, show `Thinking`.
- If it later closes, show `Thought for Ns`.
- If readable text exists, allow expanding to show a clipped summary.
- If no readable text exists, do not fake one.

## Testing Plan

### Unit Tests

Update `scripts/test-agent-transcript.mjs`:

- parses `thinking` blocks,
- parses `tool_use.id`,
- matches `tool_result.tool_use_id`,
- marks tool errors,
- filters wait-loop plumbing,
- keeps real Bash commands,
- returns legacy `rows`,
- preserves existing `toolRow()` / `toolLabel()` behavior.

### Static Guard

Update `scripts/test-notch-hit-window.mjs` to assert:

- `osAgentDetails` returns `items`,
- `agentDetails()` preload type includes `items`,
- `IslandPanel` renders structured activity items,
- wait-loop labels are filtered from user-facing details,
- expanded details no longer render only raw `{ label }` rows.

### Manual QA

Run an agent through:

- simple answer,
- file edit,
- typecheck,
- web/browser task,
- Blitz UI multiple-choice prompt,
- failed command,
- background wait idle state.

Verify:

- collapsed details are readable,
- expanded details are compact,
- wait-loop/internal plumbing is hidden,
- active work still updates every few seconds,
- idle/done/waiting states still make sense,
- no raw sensitive tool input/result dumps appear.

## Rollout Order

1. Add activity parser and tests in `agent-transcript.mjs`.
2. Update `osAgentDetails()` to return both `items` and legacy `rows`.
3. Update preload type.
4. Update `IslandPanel` to render structured activity items with legacy fallback.
5. Add CSS for the activity timeline.
6. Update notch static guard.
7. Run:

```bash
node scripts/test-agent-transcript.mjs
node scripts/test-notch-hit-window.mjs
npm run typecheck
npm run build
git diff --check
```

## Risks And Open Questions

- Claude's TUI transcript may not expose readable thinking text. The UI must still be valuable with state/duration only.
- Rebuilding from whole JSONL on each poll may become slow for huge sessions. If it does, add per-agent offset cache or tail-only parsing.
- Filtering wait-loop Bash commands must avoid hiding real user-requested shell work.
- Codex backend parity is deferred; this plan is Claude JSONL first.
- If we later ship a true stream-json runtime, the same `AgentActivityItem` contract can be fed by live stream events instead of JSONL reconciliation.

## Future Upgrade

When/if Blitz adopts a stream-json Claude runtime for chat:

- parse `content_block_start` / `thinking_delta` / `text_delta` live,
- feed the same activity accumulator,
- broadcast activity updates over the chat hub instead of polling `agentDetails()`,
- keep JSONL reconciliation as recovery/source-of-truth.

