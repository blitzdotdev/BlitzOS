# BlitzOS logging: ship now

Status: 2026-06-14. The immediate, shippable logging work. The bigger vision (the experiment and replay
loop, the sandbox debugger, checkpoints, fidelity tiers) is `research/improvement-loop-and-tape.md`, which
is for later. This doc is only what we build now: get the right logs off the machine to our own server.

## Goal

Two streams to our own server, both riding the telemetry pipeline we already have:

1. **Everything in and out of the model** (the agent's loop), so we can later see what the agent saw and
   did. NOT the workspace dir. It is too much storage, and it is redundant: whatever the agent actually
   used, it read into its context, which is already in the model log.
2. **Frontend error reports** (Sentry-style) from the React renderer, so we catch crashes and errors across
   the fleet from day one.

Out of scope (it lives in the other doc): replay, the sandbox debugger, checkpoints, A/B experiments,
deterministic re-run, consent tiers. We are just logging, well, to our own server.

## What exists today (verified in the tree)

- **The agent terminal transcript is already captured** locally to `.blitzos/terminals/<id>/transcript.jsonl`
  (`terminal-manager.mjs:54` appends every terminal output chunk). Because the agent drives BlitzOS by
  running `curl` commands, this file already contains its reasoning, its tool calls, and the results. It is
  the whole loop, just raw terminal text, and it is local-only, never uploaded.
- **Claude Code writes a clean structured version** of that same conversation to its own session file.
  BlitzOS knows the path (`agent-runtime.mjs:139`) but only checks that it exists, it never reads the
  content. (Codex has the analogous rollout file.)
- **The OS tool tap fires on every tool call but logs metadata only** (`os-tools.mjs:78` logs
  `{path, transport, ms, status}`, with the args `ctx.body` and the result `out` in scope and discarded).
- **The telemetry pipeline already uploads to our server**: a local crash-safe spool, an outbox, gzip, then
  POST to `cfg.url/ingest/*`, default-off via `~/.blitzos/telemetry.json`, crash-tail recovery, and a 4s
  screenshot track. It already ships error events, but only from the MAIN process.
- **The React renderer has ZERO error capture today** (verified: no error boundary, no `window.onerror`, no
  `unhandledrejection`). Frontend crashes are currently invisible. This is the biggest single hole.
- **The agent's launch context is already on disk per launch**: `bootstrap.txt` (the full launch prompt) and
  `meta.json` (backend, model, effort, session id, command, cwd) under `.blitzos/terminals/<id>/`, plus the
  served `agents.md` (the real system prompt). Cheap to grab, and without them you cannot tell what the
  agent was told.
- **The user's durable app state is already serialized to disk**: `workspace.json`, the per-surface content
  files, the memory files (`profile.md`, `notepad.md`, `chat.md`), and the root journal (`permissions`,
  `bookmarks`). All small text, so the app state is cheap to approximate without a full-dir snapshot.

So the plumbing and the raw material both exist. What is missing is the assembly: a clean model-context
stream, a lightweight app-state stream, frontend error capture, and the diagnostics, all stamped and
uploaded.

## Log structure

One record per line on the local spool (the telemetry pattern), three streams sharing one envelope. The two
reconstruction jobs the structure serves: the **model context** (what the agent worked from) and the **app
state** (the user's desktop), plus the **diagnostics** to locate the failure.

**Common envelope (every record):**
`{ ts, seq, session (agent id + session id), workspace, code_version (git sha), app_version, stream, type, ...body }`

### Stream A — the model loop (what the agent worked from and did)

- **`agent.spawn`** (once per launch): the `bootstrap.txt` text, `meta.json` (backend, model, effort, session
  id, command, cwd), the served `agents.md`, and the duty text. This is the launch context. Without it you
  cannot tell what the agent was told, so you cannot reconstruct its context or AB-test a prompt change.
- **`moment.delivered`**: each `/events` moment as the agent received it (post-redaction), with the cursor.
  This is the world half of the model's context (what woke it and what it saw). The raw keystroke and input
  VALUES are already dropped at the coalesce, so this is keystroke-safe by construction.
- **`tool.call`**: the widened tap, `{ path, transport, args, result, ok, ms, decision_id, caused_by }`,
  where `caused_by` is the moment seq that triggered it. The agent's actions and their effects
  (`surface_control`'s verified effect rides the result). Today the tap discards `args` and `result`.
- **`model.io`**: the conversation in and out, by reference to the session log (the Claude/Codex JSONL, or
  the terminal transcript we already write). Later, `model.wire` = the exact rendered prompt and sampling,
  hosted-model only.

### Stream B — app state (approximate the desktop, lightweight)

- **`state.snapshot`**: at session start, workspace switch, and around failures, the small durable files by
  content hash: `workspace.json`, the per-surface content files, the memory files
  (`profile.md`/`notepad.md`/`chat.md`), root `permissions` and `bookmarks`, integrations status (names
  only), `panels.json`. Content-addressed so unchanged files dedupe across time and the fleet. NOT the whole
  dir, NOT continuous, KB-scale text.
- **`state.delta`** (optional): the `os:action` broadcasts (create/update/move/close) to roll the desktop
  forward between snapshots.

### Stream C — diagnostics (the failure markers and the bug signal)

- **`error`**: main AND the renderer (the new capture below), `{ source, message, stack, breadcrumbs, surface }`.
- **`crash`**: the boot dirty bit plus the macOS DiagnosticReports enrichment (signal/exception).
- **`web.fail`**: `did-fail-load` and tab-destroyed, `{ surfaceId, url, code }`.
- **`guest.decision`**: popup, permission, and download decisions.
- A frontend error, a crash, a web load failure, a `surface_control` not-found, or a human undo/edit are all
  "failure markers" (the X) the debugger triages.

**Renderer error capture (new, the one real frontend gap):** add `window.onerror`,
`window.onunhandledrejection`, a top-level React error boundary, and a patched `console.error` in the
renderer; forward each over IPC to main into the existing spool. This is the smallest piece and the biggest
hole, so it ships first.

## Privacy

- **Never log:** OAuth tokens and secrets (`integrations.json` is encrypted, plus the Keychain), and raw
  keystroke and input values (already dropped at the perception coalesce, keep them dropped). Scrub secrets
  out of `tool.call` args and snapshots before upload (extend `provider-specs.mjs` redact).
- **Default-off** via the config file, like telemetry today.
- **Flag, decide in the same pass:** today's telemetry already uploads perception moments with url, title,
  and typed text unredacted. Since we are touching the upload path, decide whether to scrub or gate that now.

## Built so far (2026-06-14, verified on a live driven + crash-tested session)

The **local spool** is built and tested: `src/main/session-tape.mjs` (+ `.d.mts`) writes one record per line
to `<root>/.blitzos/tape/session-<date>.jsonl` over the common envelope, with a sibling content-addressed
blob store (`.blitzos/tape/blobs/<sha>`). Multi-subscriber taps let it coexist with telemetry. Gate off with
`BLITZ_TAPE=0`; frames with `BLITZ_TAPE_FRAMES=0`. It is LOCAL-ONLY today, it never uploads.

Against the order of work below: 1 (renderer error capture) done via `main.tsx` -> `os:client-error` IPC ->
tape, plus a patched main `console.error` + `uncaughtException`/`unhandledRejection`. 2 (widened tap) done,
`tool.call` carries full scrubbed args + result, `decisionId`, and `causedBy` from the agent's `/events`
wake. 3 (`agent.spawn` + `moment.delivered`) done. 4 (conversation) done as `model.io`: each agent's TUI
transcript is collected offset-based (contiguous byte ranges, lossless) and blobbed; resumed agents are
found by a per-tick workspace scan, not just `agent.spawn`. 5 (`state.snapshot`) done at session-start +
60s heartbeat + workspace-switch, durable files content-addressed. 6 (diagnostics) done: `crash`
(positively tested by SIGKILL -> reboot), `web.fail` (did-fail-load), `guest.decision` (popup `logPlan` +
permission prompt, wired, popup path proven by the shared diag tap). 7 (secret scrub) done and proven on the
hardest case: the agent's `Authorization: Bearer <token>` curls saturate the raw transcript yet survive in
ZERO blobs.

Added beyond the spec: a **visual `frame` track** (`stream:state`, `capturePage` every ~4s). Two findings:
(a) live desktop frames are never byte-identical, so blob dedup is ~1.0x; the per-frame SIZE is the only
lever, so frames are downscaled to 1280px (~90 KB, ~80 MB/active-hour, still the dominant cost, hence
gateable). (b) `capturePage` of the sandwich UI window shows desktop chrome/notes/widgets but web pages are
transparent HOLES, so live page pixels are not in the frame (a known compositor limit).

**Not built yet — the upload.** The whole point of the goal (get logs off the machine to our own server) is
still pending: blob writes are async but everything stays on disk. The egress tier (ride telemetry's
outbox/gzip/POST, consent gating, on-device retention for the heavy frame blobs) is the remaining work.

## Order of work (one person)

1. **Frontend error capture** (renderer to main to the uploader). Biggest hole, smallest fix.
2. **Widen the tool tap** to full args + results, mint a stable `decision_id`, stamp `caused_by`.
3. **`agent.spawn` + `moment.delivered`** capture (bootstrap, meta, served `agents.md`, duty, and the
   agent's perception input). Now the model context is reconstructable.
4. **Collect the conversation log** by reference (the session JSONL or the terminal transcript).
5. **`state.snapshot`** of the small durable files at session start / switch / failure. App state
   approximable, no workspace-dir upload.
6. **Diagnostics**: crash (dirty bit + macOS `.ips`), web load failures, guest decisions.
7. **Secret scrub** on every stream, a "what we send" view, default-off.

It stands alone (useful error and agent logging immediately) and it is the foundation the later replay loop
reads from. When we pick the loop back up, it consumes these logs rather than needing new capture.
