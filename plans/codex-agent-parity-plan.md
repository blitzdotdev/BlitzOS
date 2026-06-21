# Plan: Codex resident-agent parity and backend selector

## Goal

Add a product-grade agent backend selector that lets the user choose Claude or Codex, with no hidden feature loss when Codex is selected.

Parity means the selected backend works for the resident chat agent lifecycle, not just for one-off model calls:

- Persistent per-agent context across BlitzOS restarts.
- Managed tmux terminal lifecycle.
- Auto-restart without idle hot loops.
- Event wake loop equivalent to the current `wait.sh` behavior.
- `New context` semantics.
- Archive, restore, close, rename, and restart.
- Details and milestone narration.
- Workflow orchestration and workflow leaf defaults.
- Session tape and transcript observability.
- Clear UI semantics for new agents versus existing agents.

## Current state

- Resident agent runtime is centralized in `src/main/agent-runtime.mjs`.
- Claude is the default resident backend.
- A `codex-serverless` runtime exists, but it launches `codex exec` and treats Codex as a one-shot process.
- Runtime selection exists in `src/main/index.ts` and `src/renderer/src/App.tsx`, but it is marked as debug-only.
- Existing runtime selection affects future launches/restarts only; it does not hot-swap existing agents.
- Claude persistence uses `claudeSessionId`, `claudeEstablished`, `--session-id`, `--resume`, and Claude's JSONL under `~/.claude/projects/...`.
- Codex currently gets an `agentSessionId`, but current launch code does not use it to resume a Codex conversation.
- BlitzScript workflow leaves already support `claude` and `codex` harnesses through `src/main/blitzscript/harnesses.mjs`.
- Local Codex CLI supports interactive `codex`, `codex resume`, `codex exec`, `codex exec resume`, and `codex app-server`.

## Key decision

Do not expose the current `codex-serverless` runtime as "Codex parity".

The current `codex-serverless` path is useful for prototyping, but it is not equivalent to the Claude resident-agent path. It relies on `codex exec` exiting after a turn and terminal-manager restarting it. That can work accidentally for some flows, but it is not a reliable resident loop.

The product backend should be a real Codex resident adapter. The preferred architecture is a BlitzOS-supervised `codex app-server` process, with BlitzOS talking to the app-server over JSON-RPC to create/resume threads, start/steer turns, interrupt active work, and stream Codex events into the existing session UI/tape.

TODO: investigate `codex app-server` further before implementation. Confirm the stable protocol shape, transport choice (`stdio`, Unix socket, or localhost WebSocket), thread persistence semantics, turn interruption semantics, approval event handling, transcript/event fidelity, and how Codex app-server thread/session metadata maps onto BlitzOS session IDs. Treat `codex exec` as a noninteractive fallback for workflow/CI-style leaves, not as the resident chat backend.

## Why app-server instead of raw interactive Codex or `codex exec`

Raw interactive `codex` is closest to Claude's visible TUI model, but it is optimized for a human terminal. BlitzOS would need to scrape terminal state, detect readiness, inject messages safely, and recover from TUI/alt-screen states.

`codex exec` is useful for one-shot workflow leaves, but it is run-to-completion and should not be treated as a resident chat backend.

`codex app-server` is the best candidate for product parity because it gives BlitzOS explicit control over:

- The event wait loop.
- Idle behavior.
- Context IDs.
- JSONL capture.
- Retry and backoff.
- Turn boundaries.
- Consistent transcript normalization.

The app-server path should use Codex threads/turns directly, with `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt` where supported.

## Current parity gaps

- `codex-serverless` is not truly resident. It exits after a turn.
- `wait.sh` bootstrap instructions are Claude-shaped because they rely on background Bash task behavior.
- Codex session persistence is not wired to Codex app-server threads or `codex resume`.
- `New context` rotates Claude state meaningfully, but for Codex it currently mostly rotates metadata.
- Agent details are Claude-only through `osAgentClaudeSid` and `agent-transcript.mjs`.
- Milestone narration is Claude-only because `agent-narrator.mjs` reads Claude JSONL and calls `claude -p --model haiku`.
- Workflow leaves default to Claude unless `BLITZ_HARNESS` or `opts.harness` overrides it.
- Existing selector is debug-only and does not explain switch behavior.
- UI copy still tells users to use Claude Code or `claude -p` in places.
- Session tape is partly backend-neutral, but the model-plane join is still biased toward Claude session IDs.

## Target architecture

Use three distinct concepts:

- `claude`: resident Claude Code backend.
- `codex`: resident Codex backend, implemented through `codex app-server`.
- `codex` workflow harness: direct `codex exec` leaf calls for BlitzScript.

`codex-serverless` should become an internal compatibility alias or be removed after migration.

## Backend metadata model

Move terminal agent metadata toward backend-neutral names.

Keep existing Claude fields for migration:

- `claudeSessionId`
- `claudeEstablished`

Add backend-neutral fields:

- `agentRuntime`: `claude` or `codex`
- `backendSessionId`: provider-native conversation/session ID.
- `backendEstablished`: whether the backend has a resumable conversation.
- `backendMode`: `app-server`, `interactive-tui`, or `exec`.
- `agentSessionId`: keep only if still needed for tape correlation, otherwise migrate to `backendSessionId`.

Files:

- `src/main/terminal-manager.d.mts`
- `src/main/terminal-manager.mjs`
- `src/main/terminal-ops.d.mts`
- `src/main/terminal-ops.mjs`
- `src/main/agent-runtime.d.mts`
- `src/main/agent-runtime.mjs`

## Runtime adapter plan

Refactor `agent-runtime.mjs` into backend-specific command builders.

Claude adapter:

- Preserve existing `buildClaudeCommand`.
- Preserve `ensureClaudeSessionId`.
- Preserve `claudeEstablished` handling.
- Preserve `--resume` / `--session-id` behavior.

Codex adapter:

- Add `buildCodexResidentCommand`.
- Launch or connect to a supervised `codex app-server`, not raw `codex exec`.
- Persist and reuse Codex thread/session metadata as `backendSessionId` or a richer backend metadata object.
- Support fresh context by rotating `backendSessionId`.
- Use app-server thread creation/resume for conversation continuity.
- Use app-server turn APIs for wakes, steering, and interrupts.

Potential new files:

- `src/main/codex-app-server.mjs`
- `src/main/codex-resident.mjs`

## Codex app-server adapter contract

The adapter supervises or connects to `codex app-server` and owns the BlitzOS-facing resident event loop.

Inputs:

- Workspace path as cwd.
- Agent ID.
- Bootstrap file path.
- Relay URL file path.
- Existing backend session ID, if any.
- Runtime options: model, effort, sandbox, approvals, config isolation.

Loop:

- Read `.blitzos/relay-url`.
- Call `/events` with the agent and workspace scope.
- Block until real events arrive.
- Build a turn input from the same bootstrap contract plus the event payload.
- Start or steer a Codex app-server turn.
- Capture app-server item/turn events.
- Extract final message and any thread/session metadata.
- Persist thread/session metadata back through a state file or terminal metadata update path.
- Continue waiting.

Important behavior:

- Idle waiting must not call Codex.
- Transient relay failures retry without calling Codex.
- Codex app-server turn failures surface an agent error and back off.
- A clean turn does not exit the adapter or app-server.
- The adapter should emit enough terminal output for the user to understand what is happening.

## Polling and `wait.sh`

Claude can keep the current `wait.sh` prompt because Claude Code supports the intended background Bash-task pattern.

Codex should not be instructed to run `wait.sh` in the model prompt. The BlitzOS adapter should do the waiting itself and call app-server only when there is work.

Files:

- `src/main/agent-runtime.mjs`
- `src/main/codex-resident.mjs`
- `src/main/blitzos-agents.md`

## Auto-restart behavior

Current terminal-manager auto-restarts any managed agent. That remains correct, but Codex should normally not exit between turns.

Expected behavior:

- Claude exits unexpectedly: existing restart path applies.
- Codex app-server or adapter exits unexpectedly: terminal-manager restarts the managed process.
- Codex turn fails inside app-server: adapter handles backoff and remains alive unless the failure is unrecoverable.
- User stops/archive/closes: existing stop flags prevent resurrection.

Files:

- `src/main/terminal-manager.mjs`
- `src/main/terminal-ops.mjs`

## Fresh context behavior

`New context` must be backend-specific.

Claude:

- Rotate `claudeSessionId`.
- Set `claudeEstablished=false`.
- Restart agent.

Codex:

- Rotate or delete `backendSessionId`.
- Clear app-server/thread state for that agent.
- Restart or reconnect the app-server adapter.
- Preserve `chat.md` and `chat-<id>.md`.

Files:

- `src/main/terminal-manager.mjs`
- `src/main/terminal-ops.mjs`
- `src/main/osActions.ts`
- `src/preload/index.ts`
- Notch UI files if the action is exposed there.

## Transcript and details parity

Replace Claude-only transcript access with a backend-neutral transcript interface.

Current issue:

- `osAgentDetails` calls `sessionJsonlPath(root, osAgentClaudeSid(id))`.
- Codex agents show "No steps recorded" even if they acted.

Target:

- Add `agentBackendMeta(id)` in `osActions.ts`.
- Add `readBackendSessionEvents(meta, wsRoot)` in `agent-transcript.mjs`.
- Claude reader parses Claude JSONL as today.
- Codex reader parses app-server events or adapter-captured Codex JSONL.
- Fallback reader parses `.blitzos/terminals/<id>/transcript.jsonl`.

Files:

- `src/main/osActions.ts`
- `src/main/agent-transcript.mjs`
- `src/main/agent-transcript.d.mts`
- `src/renderer/src/notch/IslandPanel.tsx`

## Milestone narrator parity

Current narrator is Claude-specific.

Target:

- Narrator consumes normalized transcript events, not Claude JSONL directly.
- Summarizer backend is selected by availability and current app preference.
- If no summarizer backend is available, derive deterministic milestone labels from tool rows.

Files:

- `src/main/agent-narrator.mjs`
- `src/main/index.ts`
- `src/main/agent-transcript.mjs`

Backend options:

- Use Claude Haiku when Claude is available.
- Use Codex with an output schema when Codex is selected or Claude is unavailable.
- Use deterministic fallback: last meaningful tool label, capped and de-duplicated.

## Workflow parity

Current BlitzScript leaf support is good, but default selection is not backend-neutral.

Target:

- Resident backend should control the default workflow harness.
- A Codex resident running `run_workflow` should default leaves to Codex.
- A Claude resident should default leaves to Claude.
- Explicit `opts.harness` and `BLITZ_HARNESS` still override.

Implementation:

- Add `defaultHarness` to `RunContext`.
- Add `defaultHarness` option to `runWorkflow`.
- Pass agent backend from `runWorkflowHosted`.
- In `agent()`, default to `process.env.BLITZ_HARNESS || opts.harness || ctx.defaultHarness || 'claude'`.

Files:

- `src/main/workflow-host.mjs`
- `src/main/blitzscript/runtime.mjs`
- `src/main/blitzscript/runtime.d.mts`
- `src/main/blitzscript/agent.mjs`
- `src/main/blitzscript/agent.d.mts`
- `src/main/os-tools.mjs`

## Workflow leaf drill-in parity

Current leaf capture stores `sessionId` with Claude in mind.

Target:

- Capture `harness`, `backendSessionId`, and `rawTranscriptRef` per leaf.
- For Claude leaves, keep Claude session ID.
- For Codex leaves, store the Codex JSONL path or session ID if emitted.
- Drill-in should show Asked, Did, and Returned for both harnesses.

Files:

- `src/main/blitzscript/agent.mjs`
- Future real island kanban files when the lab plan is ported.
- `lab/kanban/vite.config.mjs` only for prototype parity.

## Selector product plan

Do not keep the current bottom-right debug switch as product UI.

Product selector requirements:

- Label it "Agent backend" rather than "model" unless model IDs are also exposed.
- Show Claude and Codex availability.
- Show auth health if possible.
- Show current default for new agents.
- Show each agent's actual backend.
- Make switching semantics explicit.

Switch modes:

- `Default for new agents`: safe default.
- `Restart current agent with selected backend`: explicit action.
- `Restart all agents with selected backend`: explicit action, probably advanced.

Files:

- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/notch/IslandSettings.tsx`
- `src/renderer/src/notch/types.ts`

## Session tape and observability

Current session tape already records:

- `backend`
- `command`
- `claudeSessionId`
- `agentSessionId`
- `transcriptRef`

Target:

- Record `backendSessionId`.
- Record `modelPlane` as `claude-jsonl`, `codex-jsonl`, `tmux-transcript`, or `none`.
- Register Codex JSONL refs when available.
- Keep tmux transcript as universal fallback.

Files:

- `src/main/session-tape.mjs`
- `src/main/index.ts`
- `src/main/codex-resident.mjs`

## Documentation and prompt copy

Update user-facing and agent-facing copy once Codex parity exists.

Files:

- `src/main/blitzos-agents.md`
- `src/main/blitzos-orchestrator.md`
- `CLAUDE.md`
- `src/renderer/src/App.tsx`
- Relevant plans that still define Agent as "Terminal running claude".

Copy changes:

- "Claude Code workflow interface" should become "Blitz workflow interface" in product docs.
- External-drive copy should mention Codex CLI and Claude Code.
- Agent docs should not assume Claude-specific background task semantics for Codex.

## Tests and acceptance checks

Add deterministic tests before manual testing.

Unit tests:

- `agent-runtime` builds Claude and Codex resident commands correctly.
- Codex session metadata persists and resumes.
- `clearAgentContext` rotates the correct backend field.
- `wasInterrupted` handles Claude and Codex without blind auto-continue.
- Transcript reader returns rows for Claude JSONL, Codex JSONL, and tmux transcript fallback.
- Workflow default harness follows agent backend.

Integration checks:

- Select Codex, spawn a new agent, send a message, receive a response without Claude installed.
- Quit and relaunch BlitzOS; same Codex agent resumes context.
- Idle Codex agent does not make repeated model calls.
- A user message wakes Codex exactly once.
- `New context` starts a fresh Codex conversation while preserving chat transcript.
- Archive and restore a Codex agent works.
- Details panel shows Codex activity.
- Milestones work or degrade to deterministic labels.
- `start_workflow` from a Codex agent uses Codex leaves by default.
- Switching backend never silently changes existing agents.

## Rollout slices

### Slice 1: backend-neutral metadata and selector cleanup

- Add backend-neutral metadata fields.
- Rename debug UI to an internal settings prototype.
- Show per-agent backend.
- No behavior change yet.

### Slice 2: Codex app-server investigation and resident adapter

- Investigate `codex app-server` protocol and transport in a small isolated spike.
- Add `src/main/codex-app-server.mjs` and/or `src/main/codex-resident.mjs`.
- Launch the app-server adapter for `agentRuntime:'codex'`.
- Wire fresh/resume context.
- Confirm idle behavior does not spend model turns.

### Slice 3: transcript and details parity

- Add backend-neutral transcript reader.
- Update details panel.
- Add tmux transcript fallback.

### Slice 4: narrator parity

- Normalize events for narrator.
- Add Codex summarizer or deterministic fallback.

### Slice 5: workflow backend defaults

- Thread selected agent backend into hosted workflow runs.
- Default leaves to the selected backend.

### Slice 6: productize selector

- Replace debug switch with product UI.
- Add explicit restart/migration actions.
- Update docs and copy.

## Risk ranking

- Highest risk: treating current `codex exec` auto-restart as resident parity. Avoid this.
- High risk: `codex app-server` protocol maturity and future compatibility.
- High risk: robust Codex thread/session ID discovery and resume.
- High risk: ensuring Codex adapter does not spend model calls while idle.
- Medium risk: transcript parser fidelity for Codex JSONL.
- Medium risk: keeping workflow leaves backend-aligned without breaking existing Claude-authored workflows.
- Low risk: selector UI and copy.

## Open questions

- Where should Codex app-server metadata persist: terminal meta, adapter state file, or both?
- Which app-server transport should BlitzOS use first: `stdio`, Unix socket, or localhost WebSocket?
- Does app-server expose all required events for transcript, details, approval, interrupt, and restart parity?
- Should Codex resident use `--ignore-user-config` like workflow leaves, or should resident mode inherit user Codex config?
- Should Codex resident enable `--search` by default, or rely on BlitzOS connected-browser policy only?
- Should old `codex-serverless` be migrated automatically to `codex`, or hidden behind an env-only escape hatch?

## Pi universal harness backend

Pi is a separate candidate backend from both Claude Code and Codex CLI. The value
proposition is different: Pi is a universal model harness with its own agent
runtime, RPC protocol, session format, auth storage, model registry, and provider
plugin system. If BlitzOS integrates Pi correctly, it can expose Codex
subscription models through Pi's `openai-codex` provider plus arbitrary API-key
or extension-provided models such as GLM/ZAI, OpenRouter, local OpenAI-compatible
servers, GitHub Copilot, and other third-party providers.

Important distinction: Pi's Codex support is not "run Codex CLI". Pi implements
its own `openai-codex` OAuth provider and `openai-codex-responses` API path
against ChatGPT/Codex subscription credentials. This makes Pi a universal
agent/model harness, not a Codex app-server or Codex CLI session backend.

### Pi integration decision

Do not integrate Pi by driving the interactive TUI. Also do not treat `pi -p` as
resident parity.

Use Pi RPC mode as the resident integration surface:

```text
BlitzOS terminal/agent manager
  -> BlitzOS Pi resident adapter
      -> pi --mode rpc --session-id <stable-id> --session-dir <workspace-session-dir>
      -> JSONL RPC: prompt, steer, abort, get_state, get_messages, set_model, new_session
```

Pi RPC is long-running, headless, stream/event based, and already exposes most
resident controls needed by BlitzOS.

### Pi surfaces already available

Pi supports:

- Interactive TUI.
- Print / JSON one-shot mode.
- Long-running RPC mode.
- SDK embedding.
- JSONL session persistence.
- Provider/model selection.
- OpenAI Codex subscription support via `openai-codex`.
- Custom providers via `~/.pi/agent/models.json`.
- Custom providers, tools, commands, UI, and OAuth flows via extensions.

Useful Pi RPC commands:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `new_session`
- `get_state`
- `get_messages`
- `set_model`
- `cycle_model`
- `get_available_models`
- `set_thinking_level`
- `compact`
- `get_session_stats`
- `switch_session`
- `get_last_assistant_text`

Useful Pi CLI flags:

- `--mode rpc`
- `--session-id <id>`
- `--session-dir <dir>`
- `--provider <provider>`
- `--model <model>`
- `--models <patterns>`
- `--approve`
- `--no-approve`
- `--offline`

### Recommended launch contract

The BlitzOS Pi adapter should launch Pi with deterministic session identity and
workspace-owned session storage:

```bash
pi --mode rpc \
  --session-id "blitzos-<agent-id-or-context-id>" \
  --session-dir "<workspace>/.blitzos/pi-sessions" \
  --approve \
  --model "<provider>/<model>"
```

The exact trust flag needs product/security review. `--approve` maximizes
feature parity with project-local Pi settings/extensions. `--no-approve` is
safer and more predictable, but suppresses project-local Pi resources. A
backend selector should not silently enable arbitrary project extensions without
clear user intent.

### Backend metadata

Add Pi-specific backend metadata under the same backend-neutral schema:

- `agentRuntime`: `pi`
- `backendMode`: `pi-rpc`
- `backendSessionId`: Pi session ID.
- `piSessionFile`: absolute Pi JSONL session file path, once known.
- `piSessionDir`: workspace-owned session directory.
- `piProvider`: selected provider, for example `openai-codex`.
- `piModel`: selected model ID, for example `gpt-5.5`.
- `piThinkingLevel`: selected Pi thinking level.
- `piRpcPid` or process handle metadata when useful for diagnostics.

Use a deterministic `--session-id` for normal launches so auto-restart can reopen
the same conversation without scraping. On startup, call `get_state` and persist
the returned `sessionId`, `sessionFile`, model, thinking level, streaming state,
and session name.

### Polling and idle behavior

Pi should not be instructed to run `wait.sh`.

The BlitzOS Pi adapter should own the event polling loop:

- Keep the Pi RPC process alive.
- Poll BlitzOS events itself.
- Send Pi `prompt` only when there is real work.
- Send `steer` or `follow_up` only for deliberate queued user input.
- Never spend model calls while idle.

This matches the planned Codex app-server adapter shape and avoids relying on
Claude-specific background Bash semantics.

### Persistence and auto-restart

Pi persists messages to JSONL session files on finalized `message_end` events.
BlitzOS should still record streamed RPC events in session tape so partial
in-flight output survives UI refreshes and can explain interrupted turns.

Expected restart behavior:

- Pi RPC process exits unexpectedly: terminal-manager restarts the Pi adapter.
- Adapter relaunches Pi with the same `--session-id` and `--session-dir`.
- Adapter calls `get_state` after reconnect.
- If `isStreaming` is false, resume normal idle polling.
- If the previous process died mid-turn, surface an interrupted/backend-restarted
  state in BlitzOS instead of blindly auto-continuing.

### Interrupt parity

Map BlitzOS interrupt/stop to Pi RPC `abort`.

Known gap: Pi RPC exposes `abort`, `steer`, and `follow_up`, but does not expose
an explicit `clear_queue` command. Until that exists, BlitzOS should avoid
unbounded queueing while Pi is streaming, or the adapter should track and limit
its own queued work. Full parity may require an upstream Pi RPC addition for
clearing/restoring queued messages.

### Fresh context parity

There are two viable fresh-context options:

- Deterministic: stop Pi RPC and relaunch with a new BlitzOS-generated
  `--session-id`.
- Native RPC: call `new_session`, then call `get_state` and persist the new Pi
  session ID/file.

Prefer deterministic relaunch for the first product slice because it gives
BlitzOS full control over the session ID and mirrors the existing backend
metadata model. Keep `new_session` for later if we want Pi-native session
switching without process restart.

### Transcript, details, and session tape

Add a Pi transcript reader to the backend-neutral transcript layer:

- Parse Pi JSONL session files from `piSessionFile`.
- Fall back to RPC `get_messages` when the process is alive.
- Fall back to tmux transcript only if no Pi session file is known.
- Normalize Pi `message_start`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
  `turn_start`, `turn_end`, and `agent_end` into BlitzOS activity rows.

Details panel should use:

- `get_state` for current model, thinking level, streaming state, session ID,
  session file, session name, and pending queue count.
- `get_session_stats` for usage/cost/context usage.
- `get_last_assistant_text` for summary fallback.

### Model selector behavior

The top-level backend selector should include:

- Claude Code
- Codex
- Pi

When Pi is selected, show a provider/model selector backed by Pi
`get_available_models`.

Initial supported examples:

- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.4`
- `zai/glm-5.1`
- `openrouter/<model>`
- `github-copilot/<model>`
- Any custom provider/model registered through Pi `models.json` or extensions.

Do not market Pi as "Codex CLI". Label it as "Pi universal harness" or similar.

### Workflow leaf behavior

Pi can run one-shot work through print/JSON mode:

```bash
pi -p "prompt"
pi --mode json "prompt"
```

However, current BlitzScript structured-output parity should not assume Pi has a
native output-schema flag equivalent to the existing Claude/Codex leaf harnesses.

TODO: investigate Pi workflow-leaf support separately. Options:

- Add a Pi leaf harness using `pi --mode json` and prompt-level JSON contract.
- Use Pi SDK directly for structured output.
- Add a small BlitzOS/Pi extension or SDK wrapper that enforces JSON schema.
- Keep workflow leaves on Claude/Codex until Pi structured-output reliability is
  proven.

### Security and trust

Pi does not include a built-in permission sandbox. Its own README recommends
containerizing or sandboxing Pi if stronger filesystem/process/network
boundaries are needed.

BlitzOS needs an explicit policy for Pi:

- Whether Pi runs with full workspace permissions.
- Whether project-local `.pi` settings/extensions are trusted.
- Whether global Pi extensions are allowed.
- Whether BlitzOS should set `PI_CODING_AGENT_DIR` to an isolated
  BlitzOS-owned config dir or use the user's normal `~/.pi/agent`.
- Whether `models.json` command-backed API key resolution is allowed.

Recommended first slice:

- Use the user's normal Pi auth/model config for maximum usefulness.
- Use a workspace-owned `--session-dir` for BlitzOS agent sessions.
- Default to no implicit project-local Pi extension trust until product UX
  explicitly communicates that extensions run arbitrary code.

### Implementation slices for Pi

#### Pi slice 1: isolated adapter spike

- Build a small local adapter that launches `pi --mode rpc`.
- Send `get_state`, `get_available_models`, and one `prompt`.
- Stream JSONL events into a normalized internal event format.
- Confirm no model calls occur while idle.

#### Pi slice 2: backend metadata and launch

- Add `pi` to backend enum.
- Add Pi command builder in `agent-runtime.mjs`.
- Store `piSessionId`, `piSessionDir`, `piSessionFile`, provider/model/thinking.
- Launch with deterministic `--session-id`.

#### Pi slice 3: resident event loop

- Implement BlitzOS event polling in the Pi adapter.
- Convert event payloads into Pi `prompt`/`steer`/`follow_up`.
- Map interrupt to `abort`.
- Add backoff for Pi process failures and RPC parse errors.

#### Pi slice 4: transcript/details parity

- Add Pi JSONL session parser.
- Add RPC live-state details.
- Update details panel to show Pi provider/model/session stats.
- Keep tmux transcript fallback.

#### Pi slice 5: selector productization

- Add Pi to product backend selector.
- Add provider/model picker for Pi.
- Make existing agents show their backend and selected Pi model.
- Ensure backend changes affect only new launches/restarts unless user chooses an
  explicit migration/restart action.

#### Pi slice 6: workflow leaf investigation

- Evaluate `pi --mode json` for structured outputs.
- Decide whether Pi leaf harness is prompt-contract only, SDK-based, or deferred.
- Add acceptance checks before exposing Pi workflow parity claims.

### Pi acceptance checks

- Select Pi, spawn a new agent, and send a message.
- Pi agent responds without Claude installed.
- Pi agent can use `openai-codex` if Pi is authenticated with ChatGPT Plus/Pro.
- Pi agent can use a non-Codex provider/model from Pi config.
- Quit and relaunch BlitzOS; the same Pi agent resumes from the same session.
- Idle Pi agent does not make model calls.
- A user message wakes Pi exactly once.
- Interrupt maps to Pi `abort` and stops active work.
- Fresh context starts a new Pi session while preserving BlitzOS chat transcript.
- Archive/restore works.
- Details panel shows Pi model, session ID/file, token/cost/context stats.
- Transcript parser shows user, assistant, tool calls/results, errors, and
  compaction events.
- Backend selector does not silently migrate existing Claude/Codex agents.

### Pi risks and open questions

- Highest risk: claiming Pi equals Codex CLI/app-server. It does not; it is a
  universal harness with Codex subscription provider support.
- High risk: Pi has no built-in permission sandbox. Product must define trust
  and isolation explicitly.
- High risk: project/global Pi extensions execute arbitrary code.
- Medium risk: Pi RPC lacks explicit `clear_queue`.
- Medium risk: Pi structured-output workflow leaves may need SDK or extension
  support for reliable schema enforcement.
- Medium risk: session persistence writes finalized messages, so BlitzOS must
  capture streamed partial events for crash/interruption transparency.
- Low risk: basic resident launch, model listing, and JSONL transcript parsing.

Open questions:

- Should BlitzOS use the user's normal `~/.pi/agent` auth/config, or set
  `PI_CODING_AGENT_DIR` to a BlitzOS-owned config directory?
- Should Pi default to `--approve`, `--no-approve`, or a product-specific trust
  prompt?
- Should Pi backend use RPC subprocess mode first, or embed the Pi SDK directly
  inside BlitzOS main process later?
- Should Pi sessions live under `.blitzos/pi-sessions` or a global BlitzOS data
  dir?
- Do we need an upstream Pi RPC `clear_queue` command for full interrupt parity?
- Can Pi JSON mode or SDK reliably enforce structured workflow outputs?

### Pi MVP spike findings

Run date: June 20, 2026 Pacific time. Some Pi session files use June 21, 2026
UTC timestamps.

Spike locations:

- BlitzOS MVP worktree: `/private/tmp/blitzos-pi-mvp-20260620225605`
- Experiment scratch dir: `/private/tmp/blitzos-pi-exp-20260620230300`
- Pi source checkout: `/Users/minjunes/pi`
- Installed Pi binary used for live tests: `/opt/homebrew/bin/pi`, version
  `0.79.7`

The Pi source checkout was not directly runnable through `pi-test.sh` because
`/Users/minjunes/pi/node_modules/.bin/tsx` was missing. The installed Homebrew
binary was present and used for the actual OAuth/RPC experiments. Production
BlitzOS should therefore resolve an installed `pi` binary through the same
login-shell strategy used for `claude` and `codex`, or explicitly package/manage
Pi as a dependency.

#### MVP code shape proven in the separate worktree

The spike added a first-pass `pi` backend without changing the main repo code:

- Added `AGENT_RUNTIME_PI = 'pi'`.
- Added aliases `pi`, `pi-rpc`, and `pi-coding-agent`.
- Added `src/main/pi-resident.mjs`.
- Added `buildPiResidentCommand(...)`.
- Reused existing `agentSessionId` as the deterministic Pi `--session-id`.
- Used `<workspace>/.blitzos/pi-sessions` as Pi `--session-dir`.
- Added `pi` to the existing debug backend switch.
- Added `pi` to `wasInterrupted(...)` as a resident-process backend.

The adapter architecture is:

```text
tmux managed agent terminal
  -> node src/main/pi-resident.mjs
      -> pi --mode rpc --session-id <agentSessionId> --session-dir <workspace>/.blitzos/pi-sessions
      -> adapter polls BlitzOS /events
      -> adapter sends Pi RPC prompt per real wake
      -> adapter posts final Pi assistant text to BlitzOS /say
```

This is intentionally not `wait.sh`. The adapter owns polling, so idle waiting
does not require Pi/model turns.

#### Codex subscription via Pi works

Command shape tested:

```bash
pi --provider openai-codex \
  --model gpt-5.4-mini \
  --session-dir /private/tmp/blitzos-pi-exp-20260620230300/sessions \
  --session-id codex-smoke \
  --approve \
  -p 'Reply exactly: BLITZOS_PI_CODEX_OK'
```

Result:

```text
BLITZOS_PI_CODEX_OK
```

`pi --list-models openai-codex` returned the subscription provider models:

- `openai-codex/gpt-5.3-codex-spark`
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.4-mini`
- `openai-codex/gpt-5.5`

This confirms the user's existing Pi/OpenAI subscription auth path is usable
from BlitzOS without requiring OpenAI API keys.

#### Pi RPC persistence and restart works

RPC smoke:

- Launched `pi --mode rpc`.
- Provider/model: `openai-codex/gpt-5.4-mini`.
- Session dir: `/private/tmp/blitzos-pi-exp-20260620230300/rpc-sessions`.
- Session ID: `rpc-stable`.
- Sent `get_state`, `get_available_models`, `prompt`,
  `get_last_assistant_text`, then relaunched a fresh Pi RPC process with the
  same session ID.

Observed:

- First `get_state.sessionId`: `rpc-stable`.
- Model provider: `openai-codex`.
- Model ID: `gpt-5.4-mini`.
- Prompt final text: `BLITZOS_PI_RPC_OK`.
- Relaunch with the same `--session-id` restored the same session.
- `messageCountAfterRestart`: `2`.
- Session file:
  `/private/tmp/blitzos-pi-exp-20260620230300/rpc-sessions/2026-06-21T06-03-45-260Z_rpc-stable.jsonl`

Conclusion: deterministic `agentSessionId -> pi --session-id` is the right first
implementation path for persistence, auto-restart, and fresh-context rotation.

#### Pi RPC bash and cancellation works

RPC bash smoke:

- `bash` with `printf BASH_OK` returned:

```json
{"output":"BASH_OK","exitCode":0,"cancelled":false,"truncated":false}
```

- A long `bash` command was cancelled with `abort_bash`; the pending bash
  response returned:

```json
{"output":"","cancelled":true,"truncated":false}
```

This is good evidence for Pi tool-interrupt parity at the RPC layer. BlitzOS
still needs product wiring from user/host interrupt actions to Pi RPC `abort`
and, when relevant, `abort_bash`.

Pi CLI constraint discovered: `--session-id` cannot be combined with
`--no-session`. This is fine for BlitzOS because resident agents should always
use persisted sessions.

#### BlitzOS adapter event loop works against a mock relay

The new `pi-resident.mjs` was tested against a local mock BlitzOS relay:

- Mock `/events` returned one message: `Reply exactly:
  BLITZOS_PI_ADAPTER_OK`.
- Adapter launched `pi --mode rpc`.
- Adapter sent one Pi prompt.
- Adapter called mock `/say`.

Observed `/say` body:

```json
{"text":"BLITZOS_PI_ADAPTER_OK","workspace":"adapter-workspace"}
```

Conclusion: the basic resident chain works:

```text
BlitzOS /events -> Pi RPC prompt -> get_last_assistant_text -> BlitzOS /say
```

#### BlitzOS metadata restart check works

`prepareAgentLaunch({ runtime: 'pi' })` was tested with persisted terminal
metadata containing:

```json
{"agentRuntime":"pi","agentSessionId":"stable-pi-session-id"}
```

Observed:

- Returned `agentRuntime`: `pi`.
- Returned `agentSessionId`: `stable-pi-session-id`.
- Rebuilt command included `stable-pi-session-id`.

Conclusion: terminal-manager's existing restart/rebuild path can preserve Pi
session identity if Pi uses `agentSessionId`.

### Pi architecture decision after MVP

Proceed with Pi as a real resident backend candidate using an adapter process
plus Pi RPC subprocess. This is a stronger path than trying to drive Pi's TUI or
using `pi -p`.

Recommended first production implementation:

- Keep `agentRuntime: 'pi'`.
- Use existing `agentSessionId` for the first slice instead of introducing a
  separate `piSessionId`.
- Launch a BlitzOS-owned `pi-resident.mjs` in tmux.
- Launch Pi as `pi --mode rpc`.
- Store Pi sessions under `<workspace>/.blitzos/pi-sessions`.
- Let the adapter own `/events` polling.
- Do not ask Pi to run `.blitzos/wait.sh`.
- Post final assistant text through `/say` from the adapter, at least initially.
- Read `get_state` after startup and persist `sessionFile`, provider, model,
  thinking level, and streaming/pending state once metadata plumbing exists.

### Pi MVP gaps before product parity

The worktree MVP is not product-ready. Remaining required work:

- Replace the MVP's hardcoded Pi availability with a real `piCliPath()` resolver
  using login-shell PATH behavior.
- Decide whether the adapter or Pi model owns normal chat delivery. The MVP
  adapter posts `get_last_assistant_text` to `/say`; if Pi also calls `/say`,
  duplicate messages are possible. Product should prefer adapter-mediated normal
  chat and reserve direct BlitzOS HTTP calls for OS actions.
- Persist Pi `sessionFile`, provider, model, thinking level, and live RPC state
  into backend-neutral agent metadata.
- Add a Pi transcript reader for Pi JSONL and use tmux transcript only as
  fallback.
- Add details panel parity using `get_state`, `get_session_stats`,
  `get_messages`, and `get_last_assistant_text`.
- Wire host/user interrupt to Pi RPC `abort`, and shell/tool interrupt to
  `abort_bash` where applicable.
- Add adapter queue policy because Pi RPC has `steer` and `follow_up` but no
  explicit `clear_queue`.
- Bridge Pi `extension_ui_request` events to BlitzOS UI. The MVP auto-cancels or
  chooses defaults, which is not acceptable for real extension flows.
- Define Pi trust policy around `--approve`, project-local resources, global Pi
  extensions, command-backed API key resolution, and whether BlitzOS uses
  `~/.pi/agent` or an isolated `PI_CODING_AGENT_DIR`.
- Add a provider/model selector backed by Pi `get_available_models`.
- Add non-Codex provider smoke tests such as ZAI/GLM or OpenRouter once the user
  selects a configured provider.
- Add idle/no-spend integration instrumentation. The architecture only calls Pi
  on startup and non-empty event batches, but production should log enough to
  prove idle polling is not spending model calls.
- Add packaging/dependency policy for Pi. The local source checkout was missing
  dependencies, while the installed binary worked.
