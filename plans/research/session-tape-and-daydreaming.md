# Session Tape (Feature 3, revised) + Idle Daydreaming (Feature 5) + the Flywheel

> **⚠️ Stale runtime references (2026-06-11):** this doc cites `agent-runner.mjs` as "the live brain supervisor" — it was **DELETED**. There is no single headless brain; each agent is a **visible `claude` tmux terminal** supervised by `terminal-manager.mjs` (command/bootstrap in `agent-runtime.mjs`). The daydreaming "tick wakes the brain" idea still maps onto waking the resident agent; read `agent-runner.mjs` as `terminal-manager.mjs`/`agent-runtime.mjs`.

**Status:** Design (2026-06-07). No core code changed yet.
**Supersedes (for Feature 3):** the agent-managed `log_event`/`recall` memory design explored earlier this session. That design put "what to remember" judgment *in the agent*. This one is simpler and **more pure-substrate**: BlitzOS passively records everything; the agent does nothing special.
**Companion docs:** `agent-os-dynamic-architecture.md` (the substrate, §0 locked decisions, P0–P6), `guardian-angel-blitzos.md` (Feature 3 ≈ GA-1 preference flywheel; Feature 5 ≈ GA-4 daydreaming). This doc is the implementable filling-in of those two slots, plus the loop that joins them.
**Grounding note:** the seams below were verified against the live tree by a multi-agent pass; several earlier assumptions were *false against the code* and are flagged inline (no `journal.mjs`; the `.blitzos` watcher is non-recursive; `redactMoment` can't redact a record; consent is a live in-memory Set; there is no localhost-trusted resident brain; no STOP exists; `surface_control` writes are ungated CDP; `claude -p` can't be token-metered as wired). Re-verify file:line before implementing — symbols are stable, line numbers drift.

---

## 0. The shape in one paragraph

**Feature 3** is a *passive session recorder* — a flight-data recorder for BlitzOS. Every user action inside BlitzOS and every agent tool call (everything over agent-socket + localhost) is appended, automatically, to one ordered tape. No agent-in-the-loop, no "remember this" tool calls. The tape is the **training corpus** (a faithful, replayable human+agent transcript) and the substrate for **RAG**. **Feature 5** is *idle daydreaming*: when the principal is away, the always-on brain reprocesses that tape and produces useful unrequested work, parked invisibly in a "Dream" workspace, behind a real cost/safety firewall; the principal returns to discover it. **Together** they form a flywheel — daydreaming consumes the tape and produces work; the principal's reaction to that work is *itself another passively-recorded action on the tape*; which makes the next daydream better and yields clean preference-training pairs.

---

# Part A — Feature 3 (revised): the passive session tape

## A.1 Why the simpler framing is better

The earlier design exposed `log_event`/`recall` tools and made the agent decide what to log. The user's revised intent — *"a simpler recording of every BlitzOS interaction… no agent calling tools in the loop to write to memory… every action the user takes passively, and every tool call the agent makes"* — is **strictly more aligned with locked decision #6** (BlitzOS is pure substrate; no policy in OS code). Recording becomes 100% mechanism. The agent never thinks about memory; the tape is a byproduct of using the system, and it captures things an agent-curated log would miss (what the agent *didn't* choose to remember).

## A.2 The model — one ordered append-only tape

A single JSONL file, append-only, one record per line, ordered by a monotonic `seq`. It is a **deterministic, replayable transcript** of the whole session: world state + user actions + agent tool calls (+ results). That is exactly the shape behavioral-cloning / SFT wants ("given this state and these user actions, the agent made these calls") and the raw material RAG retrieves over.

## A.3 The four tap points (all passive, all at seams where everything already flows)

**Tap 1 — every agent tool call ("everything thru agent-socket").**
Every tool runs through the shared `OS_TOOLS` registry (`src/main/os-tools.ts`), dispatched by **both** transports — the relay (`src/main/agentSocket.ts`, the `OS_TOOLS.map(... transport:'relay')` block) and localhost (`src/main/control-server.ts`, the `OS_TOOLS_BY_PATH[path].handler(...)` dispatch). There is already a precedent for wrapping handlers: `preview/backend.mjs` has `withActivity(tools)` that fires a side-event before each call. So this is a one-shot **`withRecording(tools)`** wrapper applied once at the registry, appending `{ts, actor:'agent', tool, args, result, ok, transport}` for every call — `create_surface`, `surface_control`, `read_window`, `say`, `provider_call`, etc.
- **Gotcha (verified):** `preview/backend.mjs` does **not** import `os-tools.ts` — it hand-rolls its own inline tool list (the known duplication). The wrapper must be applied in both places, or recording must move to the dispatcher layer. Best: a shared `recordToolCall()` in a new `src/main/session-tape.mjs` that both registries call.
- **Results carry page content** (e.g. `read_window`, `surface_control:read`) — see A.5 sensitivity.

**Tap 2 — every user action inside a web surface.**
The injected sensors (`INJECT` in `src/main/perception-core.mjs`) already capture key/click/input/nav/select as raw signals, drained into `ingestSignals(surfaceId, raw)`. Today they are coalesced into "moments" and the raw is dropped. The tape taps `ingestSignals` and appends the raw user signals **before** coalescing (filtering pure noise — mouse-move, the page's 5s `idle` ping, content-only mutations with no user signal).
- Fed by `osActions.ts` `ensureCapture`/`DRAIN` (Electron) and `preview/backend.mjs` `ensureServerCapture` (server) — both already route through `ingestSignals`, so one tap covers both transports.

**Tap 3 — every canvas / OS action the user takes.**
Move / resize / open / close / maximize / minimize, group, marquee-select, workspace switch, ⌘Z layout-undo, 👁 content-share, lock. These are zustand mutations in `src/renderer/src/store.ts` and are **not** individually sent to main today (only the debounced `os:state`). This is the **one piece of new wiring**: a generic **`os:user-action {kind, payload, ts}` IPC**, emitted from the store mutators, mirroring the existing `os:user-message` / `os:content-share` IPCs (`osActions.ts` `initOsActions`). ~10 emit sites; passive from the user's side (they don't trigger anything — the recording is automatic).

**Tap 4 — chat + widget actions.**
Already arrive in main: `emitUserMessage` (chat `trigger:'message'`) and `emitSurfaceAction` (a srcdoc widget firing an action back), both in `perception-core.mjs`. Tap there. (Agent `say` replies are tool calls → already captured by Tap 1.)

All four append to one tape via a shared `appendTape(record)` in `session-tape.mjs`.

## A.4 The record shape

```jsonc
{ "seq": 1042, "ts": 1733600000000,
  "actor": "user" | "agent" | "os",
  "kind": "...",          // e.g. surface.move | page.click | page.input | page.nav |
                          // chat.message | layout.undo | content.share | workspace.switch |
                          // tool.create_surface | tool.surface_control | tool.say | moment.wake
  "surfaceId": "…",       // when applicable
  "data": { … },          // action payload OR {args,result,ok,transport} for a tool call
  "shared": true }        // (egress only) frozen at capture — see A.5
```
One shape, ordered, replayable. `kind` is a free string convention — BlitzOS never interprets it.

## A.5 Storage + sensitivity (carry-over findings that still bind)

- **Store it at the workspaces root**, above any single workspace: `~/Blitz/.blitzos/log/session-<YYYYMMDD>.jsonl`. **Verified reason:** the per-workspace file watcher (`workspace-host.mjs` `startWatch`) is **non-recursive**, and its self-write gate checks the *child directory* name, not the file — so a tape inside a watched workspace would fire `scheduleReconcile()` on *every append* (a reconcile storm). The workspaces root (`~/Blitz`, resolved in `osActions.ts` `initOsActions`) is outside any workspace watch. `chat.md` only avoids this because it sits at a workspace *root*.
- **Reuse the atomic-append machinery** (`appendFileSync` as in `appendChatMessage`; `atomicWrite`/`safeJoin`/`markWrite` in `workspace.mjs`). Roll by day; tail-read newest N — do **not** inherit `readChatMessages`' "return [] if size > 2MB" cliff (it would silently blind any reader as the tape grows).
- **This tape is the single most sensitive artifact in the system** — a complete recording of everything, including logged-in third-party page content (in tool results + in-page signals). Therefore:
  - **Local-only by default. Gitignored** (add `.blitzos/log/` to the scaffold `.gitignore`). **Human-viewable + one-gesture-deletable** (a "session history" view + a forget gesture) — a permanent hidden diary is a product-credibility killer.
  - **If any slice ever leaves the device** (relay or a cloud mirror), two verified rails apply: (1) `redactMoment` (`perception-core.mjs`) **cannot** be reused — it is moment-shaped and trigger-keyed; a new schema-bound `redactRecord(rec, transport)` is required, keeping `{seq,ts,actor,kind}` and dropping page-derived bytes; (2) the `shared` flag must be **frozen at capture time** via `isContentShared(surfaceId)` — because `contentShared` is a live in-memory `Set` dropped on surface close (`perception-core.mjs`), so a record outlives its consent. For a pure-local training tape, neither is in the hot path, but the schema reserves `shared` so egress is possible later without reshaping the store.

## A.6 The one open fork: the RAG read-path

Writing is fully passive. **RAG is inherently a read** — *something* must fetch relevant slices at runtime. Two ways to keep it light (pick one; embeddings vs grep is an orthogonal, deferrable "retrieval quality" question):
- **R1 — Auto-inject (passive both ends):** BlitzOS feeds a rolling recent-tape window / activity digest into the agent's context on connect + each wake. Zero tool calls; coarse (recency, not semantic).
- **R2 — One read-only `recall(query)` tool:** the agent pulls context when it wants. One tool, **read-only** (honors "no write tools"), the standard RAG shape.

Training export is just `cat` / a localhost-only `dump` of the tape — never a relay path.

## A.7 Open decisions (Feature 3)

1. **Granularity:** raw user signals (faithful, large) vs coalesced moments (lighter). Lean: raw *meaningful* actions, drop pure noise (mouse-move, no-op drains, the agent's own `/events` polls).
2. **RAG read-path:** R1 auto-inject vs R2 read-only `recall`.
3. **Scope:** one tape per *principal* (`~/Blitz/.blitzos/log`, with `workspace` as a filter field — the moat is the person, "knows me everywhere") vs per-workspace.
4. **Record the agent's wake moments** (the *why* behind each tool call — valuable training causality) or just the actions?

## A.8 Phasing (Feature 3)

- **P3a — the tool-call tape (cheapest, highest value):** `session-tape.mjs` + `withRecording` on the registry (both transports incl. the `backend.mjs` hand-rolled list) → the *entire agent side* of every session, with almost no code. Store at the workspaces root; gitignore it.
- **P3b — user actions:** the `os:user-action` IPC from the store (Tap 3) + the `ingestSignals` tap (Tap 2) + the chat/widget taps (Tap 4). Now the tape is the full human+agent transcript.
- **P3c — read + manage:** the chosen RAG read-path (R1/R2) + the human "session history" view + delete gesture + day-roll/age-cap.
- **P3d (deferred, opt-in, must justify egress):** semantic retrieval (embeddings/Vectorize via a user-claimed blitz.dev app) and any off-device mirror, behind `redactRecord` + frozen consent.

---

# Part B — Feature 5: idle daydreaming

**Recommended:** *"Daydream over the tape, into a Dream workspace, behind a real firewall."* Five dumb BlitzOS mechanism pieces + one policy doc. The brain does the thinking; BlitzOS contributes only a clock, a ledger, a presence flag, a write-target, and a breadcrumb path.

## B.1 The five mechanism pieces

**1. Idle detection = a presence-gated, budgeted idle tick** in the shared `perception-core.mjs` (one impl, both transports). A module-level `markUserActivity()` bumped from **three** sites (verified necessary): inside `ingestSignals` on the *strict* user subset, **and** `emitUserMessage`, **and** `emitSurfaceAction` (the latter two bypass `ingestSignals` entirely). **Critical:** the bump subset must **exclude** `type:'idle'` even though `'idle' ∈ USER_TYPES` — the in-page sensor fires a `type:'idle'` ping after 5s of *no* activity, so counting it as activity would keep a quiet page perpetually "active." A second `setInterval` (~30s, sibling of the batch timer) emits a **contentless** moment `{trigger:'idle', surfaceId:null, signals:{idle:1}}` when `now-lastUserActivityTs ≥ IDLE_MS && presence==='away' && dreamBudget.canTick() && BLITZ_DAYDREAM`. It **bypasses the `flush()` `!hasUser` gate** (that gate is exactly why the brain starves when the user leaves), re-arms with exponential backoff, and **stops re-arming after K empty ticks** (a dumb counter — a laptop-left-on must not burn forever). The tick carries no `snapshot`, so it is egress-inert by construction. Budget is fetched by the brain via a separate `GET /dream_status` read, **not** smuggled into the moment (`redactMoment` whitelists fields and would drop it anyway).

**2. Daydream policy = entirely in `src/main/blitzos-agents.md`** (the served manual), zero BlitzOS code. On an idle tick: read budget, read already-captured material (the **session tape** from Feature 3 + `chat.md` + the Notepad note), run a fixed prompt pipeline (recombine items not recently surfaced → mine connections → draft/research-from-already-shared-surfaces → pre-compute the next-best question → emit ≤budget artifacts), park them in a Dream workspace, leave one breadcrumb, sleep.

**3. Safe = effects confined to a non-active Dream workspace folder** (`.md`/`.html` artifacts, local recombination, drafts). Unsafe = anything leaving that folder into a logged-in account or the live page. The firewall makes unsafe *structurally* impossible while away (piece 4 + the safety prereq in B.3).

**4. Cost/STOP firewall = `src/main/dream-budget.mjs`** (NEW, ~60 lines): a dumb persisted ledger `{day, ticksToday, unattendedSecToday, maxTicksPerDay, ceilingSec, stopped}` at a **machine-global** path `~/Blitz/.blitzos/state/dream.json` (NOT under the active workspace — `performSwitch` would fork the ceiling). Caps tick **frequency** and unattended **wall-clock seconds**. `noteUnattendedRun(deltaSec)` is called on a backend timer (not only at tick-issue) so a single long brain run can't blow the budget. **`dreamBudget.stop()` is the first STOP kill-switch in the codebase** (grounding: none exists) — reachable from a human (toolbar → `POST /api/os/dream {stop:true}`) and from the host. Default OFF (`BLITZ_DAYDREAM` unset), mirroring `BLITZ_AGENT`.

**5. Presentation = the Dream workspace** — invisible by construction, because the file watcher is per-*active*-workspace (`startWatch` is tied to `performSwitch`). The brain `create_workspace('Dream-<date>')` and **never** `switch_workspace`, authoring files via a **new write-into-named-workspace verb** (net-new: `wsHost` only ever touches `activeWorkspace` today, and `osCreateWorkspace` drops the `{path}` that `createWorkspace()` actually returns). On return: **one `say()` breadcrumb** into the *active* `chat.md` ("Daydreamed N items while you were away — open the Dream workspace; nothing was sent."). Discovery via Mission Control + the breadcrumb. Fully reversible: every artifact is a file; deleting the Dream workspace = full undo; ignoring the breadcrumb = dismiss. Artifacts get an **"auto-drafted while away, unverified" provenance banner** so a prompt-injected draft can't masquerade as vetted output.

## B.2 Honest scope limits (verified against code — do not paper over)

- **There is no localhost-trusted resident brain.** Electron spawns the brain with `getAgentSocketUrl()` (the **relay**, `index.ts`), `backend.mjs` spawns with `agentUrl` (the **relay**), and **both** `/events` paths the resident brain reads are **redacted** (`os-tools.ts` only un-redacts `transport:'localhost'`, which the resident brain never hits; `backend.mjs` never un-redacts). So deep full-content inward daydreaming is fiction as wired. **v1 daydreams over already-captured / already-shared material only** (the tape, `chat.md`, Notepad). A "localhost-trusted full-read daydream brain" is genuinely net-new architecture — flag it, don't assume it.
- **Do not open new pages to research while away** in v1: agent-opened web/app surfaces auto-share (`osActions.ts` auto-`setContentShare` on create; renderer mirrors it), so unattended research would stream un-looked-at content off-device over the relay. Deeper research-while-away is a later fork gated on a real default-OFF read-consent grant.
- **BlitzOS cannot meter tokens** as the brain is wired (`claude -p` spawned `stdio:'ignore'`, no `--output-format json`). v1 bounds idle spend by tick-frequency + unattended wall-clock + empty-tick-stop + the STOP switch, and relies on the agent self-throttling on the advertised budget. Real token metering (respawn with `--output-format json` + parse usage) is a named fork.
- **Laptop closed:** the Electron renderer sleeps on lid-close, so daydreaming lives on the **always-on server track** (`preview/backend.mjs`, `BLITZ_AGENT` set) — which already imports `perception-core`, already supervises one brain (`agent-runner.mjs`), and has a persistent workspace root. Pure-Electron-only deployment → the feature is **dormant** (it does not try to keep the laptop awake).

## B.3 The safety prerequisite — the `surface_control` away-gate (the first STOP)

Provider *writes* are already hard-refused in server mode (`provider-call.mjs` returns `write_unavailable` 403). The **actual** unattended-write hole is **`surface_control`**: CDP click/type/key is **ungated** (`osActions.ts` `osControlSurface` / `backend.mjs` `controlSession` run immediately) and the brain runs `--dangerously-skip-permissions`, so a markdown "don't" is **not** a control. The one genuinely new safety mechanism this feature must ship is a **code-level `presence==='away' ⇒ 403`** on the `surface_control` write actions, at both entry points (~3 lines each). `read`/`screenshot` stay content-share-gated; `eval` stays blocked. This becomes the seed of the `surface_control` write-gate the codebase already owes.

## B.4 Seams (Feature 5)

- `src/main/perception-core.mjs`: `lastUserActivityTs` + `markUserActivity()` (3 sites, excl. `type:'idle'`); `setPresence(away)` + `presence`; the second `setInterval` → `emitIdleTick()`; factor the 4-copy push+`waiters.splice` into one private `emit(moment)` while here. A test asserting the idle tick has no `snapshot`/`user`.
- `src/main/dream-budget.mjs` (NEW): the ledger + the first STOP, persisted machine-global via `atomicWrite`.
- `src/main/osActions.ts` `osControlSurface` **and** `preview/backend.mjs` `controlSession`: the `presence`-gate on click/type/key.
- **Write-into-named-workspace** (NET-NEW, both transports — add `wsHost.appendIntoWorkspace(name,file,text,mode)` in `workspace-host.mjs` for ONE impl): resolve the named workspace, HARD-refuse if it equals `activeWorkspace` (never pops onto the live canvas) or escapes the root, then `safeJoin`+`atomicWrite`+`markWrite`. Thread `createWorkspace()`'s `{path}` through `osCreateWorkspace` + the `/create_workspace` response (today it drops it).
- Reused as-is: `startWatch`/`performSwitch` (the "invisible until you switch in" invariant); `appendChatMessage` via `osSay`/`/say` (the breadcrumb); `reconcileWorkspace` + `autoKind` (.md→note, .html→srcdoc) so Dream artifacts materialize on switch-in; `agent-runner.mjs` (already supervises the brain — the tick just wakes it).
- NEW endpoints: `GET /dream_status` (advertise budget), `POST /api/os/dream {stop}` (human STOP), `POST /api/os/presence {away}`; `src/main/index.ts` `powerMonitor` lock/suspend/resume for precise presence when the app is alive; `backend.mjs` SSE-absence presence inference + heartbeat for the lid-closed case.

## B.5 Open decisions (Feature 5)

1. **v1 reads only already-captured/already-shared material** (safe, shallower) — confirm. "Research the open web while away" is a Phase-5 fork behind a real read-consent grant.
2. **Ship the `surface_control` away-gate now** as a hard prerequisite (small change to a core control path)?
3. **Cost honesty:** bound by frequency + wall-clock + STOP (no token metering as wired) acceptable for the prototype? Defaults — `IDLE_MS ~10min`, `maxTicksPerDay ~8`, `ceilingSec ~30min/day`, `GRACE_MS` before inferring "away" from SSE absence?

## B.6 Phasing (Feature 5)

- **P5-0 (safety, do FIRST, independent):** the `surface_control` away-gate + `presence` flag + `setPresence`. ~10 lines; closes the real unattended-write hole.
- **P5-1 (tick + firewall, mechanism-only, OFF by default):** `markUserActivity` (3 sites), the idle `setInterval`, `emitIdleTick` (contentless), `dream-budget.mjs` (ledger + STOP + machine-global persist), `BLITZ_DAYDREAM` gate, `GET /dream_status` + `POST /api/os/dream{stop}`. Brain can be woken; policy is a no-op stub.
- **P5-2 (presentation seams):** the write-into-named-workspace verb (both transports) + thread `create_workspace` path; provenance banner on `Dream-*` artifacts; the one `say()` breadcrumb (already exists).
- **P5-3 (the policy):** the "On an idle tick (daydreaming)" section in `blitzos-agents.md` — read budget + already-captured material, the 5-stage pipeline, hard no-outward-write while away, create-but-never-switch Dream workspace, one breadcrumb, bail-fast on empty. Zero new BlitzOS code; this is where it becomes useful.
- **P5-4 (laptop-closed correctness):** `powerMonitor` precise presence (`index.ts`); SSE-absence inferer + heartbeat (`backend.mjs`); `noteUnattendedRun` timer.
- **P5-5 (deferred forks):** real read-consent grant for research-while-away; real token metering; a passive "N items waiting" Mission-Control badge; Dream-workspace GC/merge-back gesture.

---

# Part C — The Feature 3 + 5 flywheel

## C.1 The loop

ONE loop, four arcs, sharing ONE store (the session tape) and ONE clock (the idle tick):

1. **CAPTURE [F3]** — every user action + every agent tool call is passively taped.
2. **DAYDREAM consumes the tape [F5]** — on the idle tick, the brain reprocesses the tape (anti-spaced-repetition: prefer items *not* recently surfaced — it can tell, because its own past daydream outputs are themselves tape records), mines connections, drafts, pre-computes the next-best question, and parks artifacts in the Dream workspace. This is where the tape *pays off*: a write-only recording becomes a serendipity engine.
3. **UNREQUESTED WORK meets the human** — one breadcrumb on return; they open the Dream workspace and accept / dismiss / **edit** each artifact.
4. **THE REACTION IS A CORRECTION, taped by [F3], closing the loop** — accept/dismiss/edit on a daydreamed artifact is the **highest-signal correction in the whole system**: supervised feedback on the agent's *own unprompted output*, not on ambient activity. It improves RETRIEVAL (down-weight the clusters a dismissed daydream was built from), biases the NEXT DAYDREAM (away from dismissed patterns, toward accepted ones), and yields a clean DPO/SFT triple `{daydream artifact, human verdict, edit diff}` with real provenance.

So daydreaming is not a consumer bolted onto the tape — **it is the tape's reward-signal generator.** Without F5, the tape accumulates actions with no verdict on whether the agent's interpretation was *valued*; F5 manufactures the verdicts.

## C.2 Why the passive recorder makes the flywheel *automatic*

In the original (agent-managed) design, closing the loop required a dedicated `daydream_feedback` log call. With the **passive recorder**, it's free: the user opening the Dream workspace, accepting/editing/dismissing an artifact, and editing a draft are just ordinary canvas/chat/widget actions — already captured by Taps 2/3/4. **No special coupling code.** The flywheel falls out of "record everything" + "daydream over the recording."

## C.3 Shared substrate

- **One store:** the per-principal session tape (Part A). Daydream artifacts and the human's reactions to them are *the same tape*, so the reward signal and the corpus are unified by construction.
- **One clock:** the presence-gated idle tick (B.1) wakes the daydream now and is the exact seam a future F3 *consolidation* pass (distill the cold tape into a hot Notepad preference digest) would ride. Building two idle mechanisms would be the bolt-on failure.
- **One privacy posture:** local-first; the tape never leaves the device by default; daydreaming reads only already-captured/already-shared material; any future egress goes through the one `redactRecord` + frozen-consent gate.

## C.4 What to build first

**The session tape's tool-call tap (Feature 3, P3a).** It is the cheapest slice (one `withRecording` wrapper = the entire agent side), it is the store Feature 5 dreams over, and it is where the flywheel's reward signal lands. Everything else rides it.

## C.5 Risks

- **The tape is a honeypot.** A complete local recording of logged-in sessions is a higher-value target than scattered state. Local-only + gitignore + visible + deletable are non-negotiable; any egress is a separate, justified decision.
- **Firehose noise vs fidelity.** Too raw = unusable + huge; too coalesced = loses intent. Tune the Tap-2 filter; let the training/RAG pipeline downsample rather than dropping at capture.
- **Unattended trust.** Daydreamed work must be visibly provisional, reversible, and incapable of outward writes (the away-gate). A single creepy or wrong-feeling surprise on return costs more trust than ten good ones earn.
- **Cost.** Daydreaming is the biggest tape consumer *and* the biggest cost center; the frequency + wall-clock + empty-tick-stop + STOP firewall is the only real bound until token metering exists.

---

# Part D — Consolidated open decisions (need the user)

1. **Tape scope:** per-principal (lean) vs per-workspace. (Gates the store path + re-verifying it never reconciles.)
2. **RAG read-path:** R1 auto-inject vs R2 read-only `recall`.
3. **Tape granularity:** raw meaningful signals vs coalesced moments; and whether to record the agent's wake moments (the "why").
4. **`surface_control` away-gate now** (the first STOP / prereq for daydreaming).
5. **v1 daydream reads already-captured/shared only** (no new-page research) — confirm.
6. **Cost defaults + the "no token metering" honesty** — acceptable for the prototype? `IDLE_MS`, `maxTicksPerDay`, `ceilingSec`, `GRACE_MS`.

# Part E — Unified build order

1. **P5-0** — `surface_control` away-gate + presence flag (safety, ~10 lines, unblocks daydreaming).
2. **F3 / P3a** — `session-tape.mjs` + `withRecording` tool-call tap (both transports), stored at `~/Blitz/.blitzos/log`, gitignored. *(The substrate both features ride.)*
3. **F3 / P3b** — user-action taps (`os:user-action` IPC + `ingestSignals` + chat/widget). Full transcript.
4. **F5 / P5-1 → P5-2 → P5-3** — idle tick + `dream-budget` STOP + Dream-workspace write verb + the policy doc. Daydreaming goes live (server track).
5. **F3 / P3c** — the RAG read-path + the human session-history view + day-roll/age-cap.
6. **The flywheel is now automatic** (the user's reactions to daydreamed artifacts are taped by step 3). 
7. **Deferred forks:** semantic retrieval / cloud mirror (F3 P3d); research-while-away + token metering + waiting-badge (F5 P5-5); the F3 consolidation pass on the shared idle clock.
