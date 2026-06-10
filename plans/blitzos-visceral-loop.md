# The Visceral Loop — why BlitzOS doesn't feel like a paradigm shift yet, measured, and the general-framework fixes

**Status:** Proposal (2026-06-09). Two bug fixes from this investigation are LANDED (§2); everything else is design.
**Companion docs:** `agent-os-dynamic-architecture.md` (the substrate + locked decisions), `session-tape-and-daydreaming.md` (Feature 3 tape + Feature 5 daydreaming — §3.C below defers to it), `guardian-angel-blitzos.md` (identity/flywheel tiers), `ONBOARDING-FLOW.md` (the scan + interview §3.F wires in), `blitzos-agents-redraft.md` (the doctrine rewrite §3.G feeds), `command-bar.md` (the <1s human→agent channel).
**Grounding:** every number below was **measured live this session** by driving the running Electron app over the localhost control API (and the server backend over the relay) as the brain would — instrumented scripts, isolated test workspaces, all torn down after. Re-verify before citing; line numbers drift.

---

## 0. The problem in one paragraph

BlitzOS doesn't viscerally wow because the **loop** that animates it runs three to four orders of magnitude slower than the substrate it drives, lies about the most common perception event, and forgets itself every few minutes — while the doctrine compensates by performing motion ("keep the canvas alive") instead of delivering outcomes. The felt paradigm shift of an agent-OS is exactly two experiences — **contingency** ("it noticed something about me, instantly, specifically") and **consequence** ("I came back and real things were finished, and they accumulate") — and both are content-agnostic properties of the loop, not of any vertical. That is the strategic point: **staying general is correct**, the wow of a general framework is *personalization × speed × accrual*, the user supplies the vertical, and the framework instruments which verticals users actually pull (§3.F). A vertical built on today's loop would feel equally dead.

---

## 1. The measurements (the evidence everything below stands on)

| Path | Measured | Meaning |
|---|---|---|
| Tool calls: `create_surface`, `update_surface` (widget drive), `move` | **1–3 ms** | The OS-side substrate is instant |
| `read_window` (full DOM read) / `screenshot` of a live page | **1 ms / 90 ms** (~30 KB jpeg) | On-demand rich perception is essentially free |
| File → surface (write `.md` into the workspace folder) | **276 ms** | Everything-is-a-file works as advertised |
| User acts, then pauses → moment wakes the agent (idle flush) | **6.5–8 s** | The wake floor for reactive help |
| Continuous activity → moment (batch) | **~15 s** | The ambient cadence |
| Real link-click navigation → `nav`-trigger moment | **never fired** (pre-fix) | The marquee "flush immediately on navigation" promise was false for cross-document navs — see §2 |
| Moment `snapshot` fidelity | 600 chars; **~40% navigation chrome** on a Wikipedia article; 10 chars on a sparse page | The standing view of a page is mostly menus |
| Cold `claude -p` trivial turn (the shipped brain architecture) | **5.3 s** floor; a realistic moment→acted turn is est. 15–60 s; the brain self-restarts every ~5–8 min (working-stream) and resumes from `tail -60 chat.md` | The actual bottleneck is the brain's residency, not the OS |

The felt pipeline: substrate ~1 ms → perception delivery 6.5–15 s → brain reaction 15–60 s → memory horizon ~5 min. Meanwhile a `pipeline` widget drives at 1 ms and a screenshot costs 90 ms — **the OS is not the problem; the loop is.**

In-the-wild confirmation of §2's second bug: restarting the app re-hydrated `Home` with four web surfaces the user had previously closed (orphaned `.weblink` files from closes that raced) — the resurrection bug was already quietly corrupting real desktops.

---

## 2. LANDED this session: two perception/consistency bug fixes

**2a. Cross-document navigation is now a real `nav` moment (both runtimes).**
*Was:* the in-page sensor detects nav by polling `location.href` (600 ms); a hard navigation destroys the document — and the undrained signal buffer — before the poll/drain can run, and the sensor re-injected on the new page boots with `lastHref` already at the new URL. So `nav` could **never** fire for an ordinary link click (only SPA route changes), and the moment that eventually arrived was an `idle` ~6.5 s later with the causing click lost.
*Fix:* the host is the nav authority. Electron emits from `did-navigate` on each guest (`osActions.ts` `ensureNavEmitter`; wired at the `os:webview` registration, which arrives on dom-ready — after the boot load, so only real subsequent navigations emit). Server emits from `Page.frameNavigated` (main frame, boot-load skipped) via a new `onNavigated` hook in `browser-host.mjs`, wired to `ingestSignals` in `backend.mjs`. SPA navs stay with the in-page poll — no double-count. Kernel comment updated in `perception-core.mjs`.
*Measured after:* click → `nav`-trigger moment in **0.26 s (Electron)** / **1.0 s (server, via the relay)**, carrying the new URL and a "navigated to …" user line. The pre-nav click signal still dies with the document — accepted and documented; the nav moment records the transition and the re-injected baseline refreshes the snapshot.

**2b. `close_surface` is now atomic with its file (Electron ops parity).**
*Was:* the API close relied on the renderer round-trip to delete the backing workspace file (`store.closeSurface` → `closeSurfaceFile` IPC). An agent that closes and *immediately* switches workspace wins that race — the flush projects stale state, or the late delete looks up the id in the new workspace and no-ops — and the orphaned file **resurrects the surface** on the next reconcile (observed live, twice). The server ops already deleted main-side; Electron had drifted.
*Fix:* `electron-os-tools.ts` `closeSurface` now calls `osCloseSurfaceFile(id)` synchronously before broadcasting the close (duplicate delete is a no-op). Verified with the exact racing sequence: file gone.

Both verified end-to-end on the live app; `npm run check` (typecheck + parity + build) clean.

---

## 3. The fix architecture (general-framework only — no verticals)

Ordered by leverage. For each: what it is, the OS/doctrine/policy split (respecting locked decision #6 — pure substrate, no policy in OS code; only write-confirm + STOP as OS rails), and what already covers it.

### 3.A — Resident brain + a published latency budget (the single biggest lever)

Replace the respawning `claude -p` in `agent-runner.mjs` with a **held session**: a streaming Claude Agent SDK session (or `claude --resume` against a persisted session id) that stays warm across wakes — no 5.3 s process boot per turn, no prompt re-read, no 5–8-min amnesia cycle, warm KV cache so a wake→act turn lands in seconds. This is **transport/supervision work, not policy** — the runner already owns spawn/restart; it graduates to owning a session. Set a budget and show it: **wake → first visible action, p50 < 5 s**, surfaced in the Agent-activity panel so slowness is a visible regression, not a vibe.
*Covers a named gap:* no existing plan owns brain durability (`session-tape-and-daydreaming.md` §B.2 explicitly flags "no localhost-trusted resident brain" as net-new architecture — this is that work). Everything else in this doc compounds on it.
*Also:* prefer the localhost transport for a co-located brain (trusted, unredacted, no relay flakiness) — the doctrine already says this; the runner should actually do it (today both Electron and server spawn the brain on the **relay** URL).

### 3.B — Perception: honest first, then richer (still zero per-task code)

1. *(landed)* Host-side nav — §2a.
2. **Digest v2 — reader extraction + delta.** The 600-char `innerText` slice spends ~40% of its budget on nav chrome. Extract like a reader instead: prefer `main`/`article`/`[role=main]`, strip `nav/header/footer/aside`, lead with URL + title + H1 + any selection. And emit a **diff against the previous digest** — "what changed" is the significance signal an agent actually needs, and it's content-agnostic. Lives in `INJECT` (`perception-core.mjs`), shared by both runtimes.
3. **Tiered sight: attach a screenshot to significant moments.** Screenshots cost 90 ms/~30 KB. On `nav`/`idle`/`select` triggers (not batches), the host captures and attaches (or references) one frame so the brain sees what the user sees without a second round-trip. Egress note: image-bearing moments over the relay inherit the same posture as `snapshot` (currently unredacted by deliberate removal) — if content-share gating returns, images gate with it.
4. **Site perceptors** (`agent-os-dynamic-architecture.md` L2/P3) stay the later, richer tier — (2)+(3) deliver most of the value with no per-site code, which preserves the generalization doctrine.

### 3.C — The tape (accrual substrate) → build `session-tape-and-daydreaming.md`, starting at P3a

That doc is already grounded and decision-ready; this investigation only adds urgency and one datum: the brain's working memory today is literally `tail -60 chat.md`, and `/events` seq resets on restart — so **every veto, correction, and acted-on moment is currently thrown away** (its words, confirmed). Build order there is right: P3a (the `withRecording` tool-call tap) first — cheapest slice, and it is the store every other accrual feature (daydreaming, standing intents §3.D, demand telemetry §3.F) rides.

### 3.D — Standing intents (the commitment primitive — what makes "I came back and it was done" possible for ANY workflow)

One tiny generic OS mechanism: the agent registers `{ intent: <opaque text it wrote for itself>, wake: <time/cron | idle | on-activity-in-workspace> }`; the OS persists it and **wakes the brain with the intent attached** (a moment with `trigger:'intent'`). No task logic in the OS — the intent text is the agent's note to its future self; BlitzOS contributes a clock, a store, and a wake (the same shape as `session-tape-and-daydreaming.md` B.1's idle tick + dream budget — build them on the **same clock/budget machinery**, not as a second mechanism; that doc's B.4 seams and STOP/budget pattern apply verbatim). Human-visible and cancellable: intents render in a system widget (each one a card: text, next wake, last result, pause/delete).
*This converts "an agent reacting to moments" into "an agent with commitments."* It is also the load-bearing dependency of §3.F's demand discovery. Composes with daydreaming rather than competing: daydream = *un*committed idle work; intents = committed scheduled work; both park results quietly and leave a breadcrumb.

### 3.E — Consequence must end in a receipt (extend #51, don't re-gate it)

The write-gate (`dynamic-provider-substrate.md`, shipped) is the right rail; what's missing is the loop closing into a *felt outcome*:
- **Proposed-action card v2:** human-readable diff of exactly what will be sent/changed and to whom (today's card is the seam; this is presentation + payload).
- **Action ledger:** every executed write (and every `surface_control` act into a logged-in page) lands in a persisted, per-workspace ledger surface — *what was done, when, for which ask* — with **undo** where the provider supports it (send→trash, create→delete, label→unlabel). The ledger is the generic artifact of "real things happened here," and the tape (§3.C Tap 1) already captures the raw events — the ledger is a *view* over tape records, not a second store.
*OS/policy split:* the ledger records and renders (mechanism); what to propose remains the agent's (policy). No new gates beyond the locked rails.

### 3.F — First-run = the demand-discovery engine (how a general framework finds its verticals)

The stated strategy is to put the general framework in front of many people and *measure* which workflows are pulled. That only works if the product elicits workflows and records the elicitation:
1. Wire `ONBOARDING-FLOW.md` into actual first-run: scan (the `--no-fda` branch by default) → brain assembles the desktop from the scan (proven at ~135 s in working-stream; §3.A makes it fast) → the ≤4-question interview.
2. End onboarding with the key move: the brain **proposes 2–3 standing intents (§3.D) phrased in the user's own domain language**, derived from the scan. The user accepts / edits / declines.
3. Record `{scan-context summary, proposed intent, accepted|edited|declined, alive-after-7-days}` — on the tape, exportable. **That table IS the vertical-discovery instrument**: the user population votes with retained intents; nobody has to guess the wedge.
Mirror-benchmark guardrail applies: the *human* blind round showed "any real signal ≫ none" with a flat dose curve — so the cheap scan is sufficient signal; don't over-invest in distillation before retention data exists.

### 3.G — Doctrine: liveness = real state transitions (input to `blitzos-agents-redraft.md`)

Resolve the corpus's open conflict ("keep the canvas alive / idle is failure" vs the GA/daydream "park quietly, never a notification"): a surface may animate **only on a real state change** (props/file actually advanced); placeholder motion and skeleton-theater are forbidden; idle time goes to tape/daydream work parked on a "for when you're free" board with provenance banners. Liveness becomes a *byproduct of real work* — which the 1-ms drive path makes effortless to show honestly. Zero code; doctrine prose.

### 3.H — How proactivity comes back (the override's exit ramp)

`agent-runner.mjs`'s session override ("DO NOTHING unprompted") exists because a wrong proactive move was expensive: it rearranged a curated desktop, a minute late. Make a wrong proactive move cost ~0 and the dial can rise without a governor (consistent with the P2-removal decision — policy stays agent-side):
- Low-confidence acts surface as a **quiet proposal chip** (a small pinned-adjacent surface / `say` variant), never a layout mutation. One tap applies; ignoring it costs nothing.
- Accept/dismiss lands on the tape (§3.C — free once Taps 2/3 exist) and the brain reads its own correction history on wake (the GA-T2 flywheel, automatic).
- §3.A's latency budget is the enabler: a 3-second wrong suggestion is forgivable; a 60-second one is creepy.

---

## 4. The wow tests (generic acceptance criteria — no vertical required)

1. **Reactive:** highlight text in any page → a relevant surface appears in **< 5 s**.
2. **Navigation:** click a link → a `nav`-triggered moment in **< 2 s**. *(passes today, post-§2a: 0.26 s Electron / 1.0 s relay)*
3. **Continuity:** quit and relaunch → the brain continues mid-task from tape + chat, no re-greeting, no re-assembly.
4. **Morning return:** a standing intent registered at night → the morning desktop shows the ledger of completed work with receipts and undo.
5. **First five minutes:** fresh user → scanned, assembled desktop + 2–3 personal intent offers in **< 90 s**.

When all five pass, the shift is *felt* — through whatever workflow each user brought.

## 5. Build order

1. ~~§2a + §2b~~ **landed** (this session).
2. **§3.A resident brain + latency budget** — everything compounds on it; pairs with `command-bar.md` (<1 s human→agent channel) for the full both-directions latency story.
3. **§3.C tape P3a** (per its own doc) → then **§3.D standing intents** on the shared clock/budget machinery.
4. **§3.F first-run wiring + intent offers + telemetry** — the put-it-in-front-of-people moment; gated on 3.A (speed) and 3.D (intents).
5. **§3.B digest v2 + screenshot tier**, **§3.E ledger view**, **§3.G doctrine** — continuous, parallelizable.

## 6. Open decisions (need Min)

1. §3.A: Agent SDK held session vs `claude --resume` supervision — and does the resident brain move to localhost transport (trusted/unredacted) as the doctrine already prefers?
2. §3.B.3: screenshots attached inline to moments (bytes in the long-poll) vs referenced (`GET /moment_frame?seq=`)?
3. §3.D: intent wake vocabulary v1 — time/cron only, or also `idle` and `on-activity-in-workspace`? (Lean: time + idle; activity-matching flirts with policy-in-OS.)
4. §3.F: is intent-offer telemetry local-only (tape) with manual export, or is there an opt-in aggregate channel? (Default: local-only.)
5. §3.G/H: confirm the doctrine direction before the redraft folds it in — "animate only on real state change" + the proposal-chip channel.

## 7. What this doc deliberately does NOT propose

- **No vertical wedge.** The earlier "pick a wedge" advice is withdrawn — measurement shows generality isn't the bottleneck; the loop is. §3.F is how verticals get *discovered* instead of picked.
- **No policy in OS code.** Every fix is mechanism (clocks, stores, emitters, views) or doctrine prose; significance/act-vs-wait stays the brain's.
- **No new gates.** Write-confirm + STOP remain the only OS-enforced rails; §3.E adds receipts and undo, not friction.
