# BlitzOS Architecture — A Dynamic, AI-Driven OS

**Status:** Synthesis of four design lenses + adversarial critiques, re-grounded against the live `master` tree (working tree clean; the `agent-runtime-moments` merge has **landed** — there are no conflict markers, `src/main/events.ts` exists and is wired).
**Supersedes:** `agent-os-desktop-architecture.md` (for the vision). `agent-os-server-mode.md` remains the server-mode deployment reference.
**Author note on grounding:** All four design proposals were authored against a *mid-merge* tree and the two critiques flagged unresolved conflict markers. That merge is now resolved on `master`. Two of the proposals' load-bearing theses — "nothing in BlitzOS initiates / perception is pull-only / there is no scheduler or event push" — are **false against the current code**. The perception bus, the MutationObserver sensors, the moment coalescer, and the `/events` long-poll wake **already exist and are documented in CLAUDE.md:60**. This document is written against what is actually there.

---

## 0. Decisions locked (this session)

These are the user's governing calls; where a section below differs, **these win.**

1. **Runtime = local-first, server-optional.** The autonomous layer stays transport-agnostic; the **Electron desktop is the MVP** (full webview/CDP, Keychain, the brain on the localhost-trusted path). Server/hosted is the *optional* second path (roadmap **P5** perception parity, **P6** D1 sync), not a separate product.
2. **Autonomy = Suggest & Confirm (default).** The OS perceives + proactively assembles UI and *proposes* (e.g. a message with suggested replies), but every **outward write into a logged-in account requires a per-action human confirm**. The Observe/Suggest/Act dial (L5) can raise this *per-verb, per-account* later; a *send* defaults to always-confirm.
3. **Perception = hybrid, delivered as a GENERIC agent-composable framework — not per-provider OS code.** The OS exposes generic verbs — the moment stream (built), `read_window` / scripted DOM read on the trusted path, a future generic `observe(selector→event)`, and a consent-gated generic API `fetch` — and the **agent** chooses DOM-vs-API per context and composes the extraction at runtime. The "site perceptors" named below are therefore **agent-authored compositions of these verbs, NOT hardcoded BlitzOS modules**; adding a site/provider must be **zero OS code** (a one-time OAuth connect + the agent composing primitives). This supersedes the closed-registry pattern — the widget bridge's `PROVIDER_DATA` is the unit to *generalize* (via the deferred `op:'fetch'`), not to extend by hand.
4. **Memory model = OPEN (decide in context).** The `Profile`/`Snapshot`/`BrainState` schema in §5 is the recommended *starting* shape, but its SCOPE — explicit profile + layouts only, vs. implicit **learned preferences** (reply style, app-usage patterns, what you usually approve) — is deliberately undecided. Build persistence so the learned-prefs tier can be added later without reshaping the store.
5. **First milestone = the end-to-end vertical slice** (the §4 loop on ONE real scenario: a moment → suggested-reply widget → confirm → send). It reuses everything just merged and proves the whole thesis. BUT it acts on a logged-in account, so it **rides on the safety prerequisites**: **P0 (close the `/events` privacy leak) is the immediate first step**, then the observe-only loop (P1) and the consent/STOP gate (P2), culminating in the slice (**P3**, the visible payoff). Near-term arc: **P0 → P1 → P2 → P3.** Resident-runtime hardening, persistence/boot, and server parity follow.

---

## 1. North star

BlitzOS is an **operating system for an agent**: a spatial desktop where a resident AI perceives what's on your screen, reasons about what you need, and acts — opening your accounts, surfacing the message that needs a reply with a drafted response, moving your attention to what matters — with you always in the loop and one gesture from veto. The agent supplies intelligence; BlitzOS supplies the loop, the hands, the eyes, and the memory. The premise that unlocks it: **read the rendered web page, not the OAuth API** — so the OS works on any logged-in account without per-site API scopes.

**Honest framing:** BlitzOS today is a **near-complete substrate with the autonomous brain still external.** It already has hands (the surface control plane + CDP action vocabulary), eyes (page sensors + read tools), an interrupt (coalesced "moments" + `/events` wake), and a self-describing tool contract. What it is missing is a **resident brain that runs the perceive→reason→act loop *inside* the OS**, the **governance and consent gates** that make autonomous action on a logged-in account safe, **attention/follow-mode** (the agent can move surfaces but not the human's view), and **persistence/profile** (a restart wipes everything). The agent that drives BlitzOS today is "the thing on the other end of the relay" — a human pastes a URL into an AI chat. The vision is to bring that brain inside, govern it, and give it memory.

---

## 2. Where we are — the 10 vision pillars

Grounded against the live tree. Citations are real files/symbols on `master`.

| # | Pillar | Status | Evidence (real files/tools) |
|---|---|---|---|
| 1 | Boot / onboarding / welcome (time, weather, greeting) | **NOT DONE** | `index.ts` boots an empty window (`createWindow` → `initOsActions`/`startControlServer`/`startAgentSocket`, index.ts:91-108); no startup surface seeding. No profile/role. Weather/time have no data source (PROVIDER_DATA is 2 entries). |
| 2 | Auto-open accounts as tabs around a workspace | **NOT DONE** | `osOpenWindow` exists (osActions.ts:138) but nothing calls it on launch. No "user's accounts" model; no periphery layout. Canvas mode is dormant for the human (CLAUDE.md:61). |
| 3 | Render + read + act on logged-in 3rd-party pages (Gmail/Discord), sidestepping API scopes | **PARTIAL (Electron strong, server weak)** | Electron: `<webview partition="persist:agentos">` keeps cookies; `osReadWindow` reads DOM via `executeJavaScript` (osActions.ts:116-121); `osControlSurface` drives CDP (osActions.ts:173). Server mode: `browser-host.mjs` renders top-level targets (X-Frame-Options bypass) but uses an **ephemeral** `mkdtempSync` profile — **always logged out**. |
| 4 | Resident proactive agent (the brain that initiates) | **NOT DONE** | Both transports are passive endpoints. `index.ts` spawns no agent child process. The brain still lives on the other end of `/events` (relay or localhost). The arch doc's "headless Claude Code/Codex child" is unbuilt. |
| 5 | Perceive→reason→act loop + triggers | **PARTIAL — the trigger half is BUILT** | Sensors injected per web surface (`INJECT` MutationObserver + input/nav/idle, osActions.ts:62-83); 350ms `DRAIN` → `ingestSignals` (osActions.ts:88-95); coalescer batches into **moments** (`events.ts`, `BATCH_MS=15000`, flush-on-significant); `/events` long-poll wakes the agent (agentSocket.ts:385-397, control-server.ts:100-118). **Missing:** the resident *reason+act* policy that consumes the stream. |
| 6 | Proactive widget surfacing (message + suggested replies) | **NOT DONE (mechanism partial)** | `spawn_widget`/`save_widget` author sandboxed srcdoc UI (agentSocket.ts:312,349). `blitz.props`/`onProps` push content with no reload (widget-bridge.ts:24,13). **But:** no inline/ephemeral spawn (must save to a shared library first), the data bridge is `op:'data'` only — **no widget→OS write path** (SurfaceFrame.tsx:177 rejects every non-`data` op), and the closed `PROVIDER_DATA` registry (discord/guilds, github/repos only — widget-catalog.mjs:134-165) can't represent a message object. |
| 7 | Persistence + user/role profile | **NOT DONE** | `store.ts` is a plain `create()` — no persist middleware, no localStorage. `cached` os:state is a module global (osActions.ts:28). Server `osState` is in-memory. Restart wipes surfaces, consent, the agent URL (CLAUDE.md:70). No profile, no role. |
| 8 | Attention / follow-mode (agent moves the human's view) | **NOT DONE (math exists, unreachable)** | `store.focusAndZoom` computes the center+fit camera transform (store.ts:131-148) but **no `os:action` case maps to it** — App.tsx:127-133 handles only create/move/update/close/goToPrimary. No `set_mode`/`focus`/`follow` tool. |
| 9 | Always-on reliability | **NOT DONE** | Server `browser-host.mjs` has no respawn supervisor, CDP socket has no reconnect; `createSurface` races in reconcile. Electron debugger is single-client, idle-detaches at 60s (cdp.ts). No persistence → no recovery. (See `working-stream.md` reliability list.) |
| 10 | Consent for autonomous actions | **PARTIAL — data reads only** | Per-(surface,provider) widget *data* consent with revoke-on-html-change (SurfaceFrame.tsx:128-203). eval is 403'd over relay, allowed on localhost-bearer (agentSocket.ts:277, control-server.ts:16). **But:** no consent gate for autonomous *writes* (surface_control type/click into a logged-in page), and **moment `snapshot` digests of logged-in pages already ship to the relay agent with NO consent gate** (events.ts:131 `snapshot` → `waitForEvents` → agentSocket.ts:396). |

**Reading of the table:** the substrate is ~70% there. The biggest *built* asset everyone underestimated is **Pillar 5's trigger half** (the moment stream). The biggest *gaps* are the resident brain (P4), governance+attention+consent (P8, P10), and persistence/profile (P7) — plus a live privacy leak (P10) that must be closed *before* anything else is built on the moment stream.

---

## 3. Target architecture — the layered model

Five layers. Each entry states **what it is**, **what it reuses** (cite the existing primitive), and **what is new**. The unifying invariant from the HCI lens: **every desktop mutation funnels through `osActions.ts`**, so one consent/governance gate at that choke point covers both transports and any future resident brain with a single piece of code.

```
┌────────────────────────────────────────────────────────────────────┐
│ L5  HCI / Attention / Consent      (NEW gates + reuse consent SM)    │
│     legibility + reversibility; the contract the others must honor   │
├────────────────────────────────────────────────────────────────────┤
│ L3  Resident Agent — THE BRAIN     (NEW; the only initiator)         │
│     governor (tiering/budget/attention) + policy over the moments    │
├────────────────────────────────────────────────────────────────────┤
│ L2  Perception / Event loop        (MOSTLY BUILT + semantic upgrade) │
│     sensors → moments → /events wake;  + site perceptors             │
├────────────────────────────────────────────────────────────────────┤
│ L4  State / Persistence / Profile  (NEW; the spine of memory)        │
│     durable world snapshot + profile;  boot/onboarding assembly      │
├────────────────────────────────────────────────────────────────────┤
│ L1  Substrate — surfaces/control/render   (EXISTS, mostly complete)  │
│     osActions chokepoint, control-core CDP, server browser-host      │
└────────────────────────────────────────────────────────────────────┘
```

### L1 — Substrate (surfaces, control, perception primitives) — *mostly exists*

**What it is.** The mutation choke point and the render/act primitives. One surface descriptor, four kinds (`web`/`app`/`srcdoc`/`native`); one CDP action vocabulary driving both Electron `<webview>` and server headless Chromium; the two transports (localhost-bearer + relay) onto the same plane.

**Reuses (all real):** `osActions.ts` (`osCreateSurface`/`osOpenWindow`/`osMoveSurface`/`osUpdateSurface`/`osCloseSurface`/`osControlSurface`/`osReadWindow`/`osGetState`) as the single seam; `control-core.mjs` `controlSession` (transport-agnostic click/type/key/read/screenshot/eval); `cdp.ts` Electron debugger session; `browser-host.mjs` top-level-target rendering (X-Frame-Options bypass); the relay's confused-deputy split (eval 403 over relay, allowed on localhost).

**New (small, additive):** new `os:action` cases for `focus`/`set_mode`/`follow` so `store.focusAndZoom`/`setMode`/`panBy` (already in store.ts, today unreachable) become drivable; a *trusted internal* `osCreateSurface` path that can honor a saved `srcdoc` id on restore (today srcdoc ids are force-minted, osActions.ts:132); a persistent/shared user-data-dir for the server browser so logins survive (replace `mkdtempSync`).

### L2 — Perception / Event loop — *mostly built; needs a semantic upgrade and a privacy gate*

**What it is.** Turns open web surfaces into a continuous, change-driven, content-agnostic sensory stream that *wakes* the brain only when something the user did matters. This is the half of the loop that already ships.

**Reuses (all real and merged):** `INJECT` (MutationObserver + key/click/input/nav/idle sensors, osActions.ts:62-83); the 350ms `DRAIN` → `ingestSignals` (osActions.ts:88-95); `events.ts` coalescer — `BATCH_MS=15000`, `USER_TYPES` gating so a running clock does **not** wake the agent (events.ts:52,103,116), flush-on-significant (nav/idle), `MAX=1000` ring; `waitForEvents`/`latestSeq` long-poll (events.ts:154-200); `/events` in **both** transports; `emitSurfaceAction` callback path so a srcdoc "approve" click re-enters the same moment stream (events.ts:165).

**New (the genuine net-new value the critiques endorsed):**
- **Site perceptors** — per-site scripted extractors (gmail.com, discord.com) returning *structured* records `{kind, author, snippet, permalink, threadId, unread, ts}` instead of the flat `digest` text blob (today `snapshot` is a ~600-char digest, which cannot represent "a message from X with a permalink"). These run on the **trusted localhost/in-process side only** (they need scripted reads the relay denies) with a screenshot+vision fallback for unknown sites and a staleness health-check (observer fired but extractor returned `[]` → mark stale, fall back to vision).
- **A privacy/consent gate on the moment snapshot** — *this is the first thing to fix.* Today `moment.snapshot` (a digest of a logged-in third-party page) ships to the relay agent via `waitForEvents` with **no per-surface consent**. Default the relay to **metadata only** ("surface X has an actionable item"); raw page content requires an explicit per-surface "perception sharing" grant reusing the existing consent ledger.
- **Server-mode parity** — `browser-host.mjs`/`backend.mjs` have *none* of the sensor/moment machinery (only the renderer screencast SSE). The previewed product (agentos.blitzmen.com) is server mode, so perception must be ported there, or the resident brain only works in the unshippable Electron path.
- **A scheduler/attention budget** — active/peripheral/idle tiers, exponential back-off on quiet surfaces, rate-limited vision. Today `INJECT` runs a body-subtree observer on **every** web surface unconditionally; an always-on OS needs a cost firewall.

**Dropped (the critiques killed it):** the proposals' "build a new MutationObserver + diff/dedup + event bus" — that *is* `events.ts`/`INJECT`. Do not rebuild it; **consume `/events`.**

### L3 — Resident agent — *the brain (NEW; the only component that initiates)*

**What it is.** A long-running policy that **consumes the existing moment stream** and decides, per moment, to ignore / handle locally / reason (a real model call) / act — under a budget and behind consent. This is the keystone gap. It is *not* a new perception system; it is the reason+act half of the loop that nobody has written.

**Reuses:** the *entire* existing tool vocabulary as its action surface — it calls the same tools the relay exposes (`create_surface`/`spawn_widget`/`surface_control`/`read_window`/the new `focus`/`follow`). The `/events` long-poll is its interrupt. The `AGENTS_MD`/`tools.json` self-describing contract (agentSocket.ts) is its operating manual and a stable prompt-cache blob. The `USER_TYPES` coalescing in `events.ts` is *already* the cheap "does this matter" rules engine — no separate model triage tier is needed (this resolves the CLAUDE.md "Opus-only" tension: the cheap gate is non-model and already shipped).

**New:**
- **Governor** (`brain/governor.ts`) — model-tiering (rules → reason), an **attention set** (focused + auto-opened accounts), a **persisted budget** (tokens/$/actions-per-minute) with **hard degrade-to-observe** when exhausted. Nothing in the repo bounds cost today; a model-in-a-loop is unbounded without this.
- **Policy/orchestrator** — turns a moment into a decision and a sequence of (gated) tool calls. Composes context-aware suggested replies from a site-perceptor's structured records.
- **Dedupe/seen memory** — a stable per-record identity (threadId/permalink from the perceptor; content-hash fallback) so the brain replies once, never double- or re-surfaces an old message on boot. Tuned toward false-positive (surface, let the human decide) over false-negative in Suggest mode.

**Resolved conflict (the critiques' strongest point): drop the "in-process for eval" framing.** The resident-agent proposal wanted the brain in Electron main *specifically to inherit eval and bypass the relay's confused-deputy guard*. That is an anti-feature — the repo just hardened that boundary, and composing replies + arranging surfaces needs only `surface_control` + `read_window` + `spawn_widget`, never eval. **Decision:** the brain runs as the architecture doc specifies — a supervised agent over the **localhost-bearer** path (`control-server.ts`, which already exposes `/events` and the full tool set). Localhost-bearer gives it scripted/structured reads (which the relay denies) **without** turning eval into a routine dependency. eval stays available on that path as a break-glass primitive, not the design center. *Open: hosted Claude API call vs spawned headless Claude Code/Codex child — see §7.*

### L4 — State / Persistence / Profile — *the spine of memory (NEW)*

**What it is.** Makes the world survive a restart and gives the OS an identity to boot from. A durable **Snapshot** (the full desktop) + a **Profile** (who the user is, their role, their accounts, their boot intent), owned by main, persisted as atomic JSON under `userData`, with teenybase-D1 designed-in as the later sync tier.

**Reuses:** the `userData` seam `tokenStore.ts:15` already uses (`app.getPath('userData')/integrations.json`) so OS state and Keychain tokens share one backup story; the atomic temp-write+rename pattern proven in `widget-catalog.mjs:120-124`; the os:state buffer that *already* flows to main (`cached`, osActions.ts:35-36) — persistence is a **debounced mirror** of a buffer that already exists, not a new feature; `integrations.ts` `connectedProviders()`/`integrationStatuses()` to derive the account list; the repo's own teenybase D1 + the proven `save_version` CAS (MEMORY.md) for the eventual sync tier.

**New:**
- `StateStore` (atomic JSON, 5-deep crash-recovery ring), `Snapshot`/`Profile` schema.
- A **`renderer:ready` handshake IPC** before any boot replay (os:action `create` is fire-and-forget — replaying surfaces before the renderer subscribes silently drops them).
- `patch_profile`/`save_layout`/`restore_layout`/`list_layouts` tools — **scoped to the localhost-trusted path** (a remote pasted-URL agent must not poison `bootIntent`, which survives restart).
- A **`transient` flag** on the descriptor so one-off "message + suggested replies" widgets are never persisted/resurrected stale.

**Resolved conflicts:**
- **Two-brain ownership.** The persistence proposal's `bootIntent` + deterministic baseline is a *parallel* control input to the moment-driven brain. **Decision:** the **resident agent (L3) is the single owner of what is on screen.** L4 provides a deterministic *baseline* assembly (time + welcome + connected-account tabs) that runs first so the desktop is never empty, then **hands `Profile` + last `Snapshot` to the brain as boot context** and the brain improvises on top. The baseline is a floor, not a competing authority.
- **Lossy projection.** Today the renderer's `sendState` projection drops `z`/`zoom`/`html`/`props`/`transform`/`mode` (App.tsx:163-173). Non-lossy restore *requires* widening it (an L1 change). Until then, restore geometry+identity and re-fetch library-widget html from the catalog. **Honest limit:** one-off agent-authored inline html is lost on restart unless persisted explicitly — which is *correct* for `transient` widgets.
- **Restore restores the tab, not the login.** In server mode the browser profile is ephemeral, so a restored Gmail tab comes back logged-out until the persistent-profile L1 change lands. Restore is honest about this.
- **Consent is deliberately NOT persisted** — re-prompt on restore is the safe default (consent is keyed to a surface generation; srcdoc ids aren't stable across restart).

### L5 — HCI / Attention / Consent — *the contract the others honor (NEW gates + reuse)*

**What it is.** The human-facing trust surface: **legibility** (you always know what the OS did and why) + **reversibility** (one gesture to undo/veto). Three rules: a **spatial contract** (one primary workspace; OS-spawned surfaces live in the periphery, never over primary); **attention is a request, not a seizure** (raise a flare/peek; only move the camera on accept; follow-mode is opt-in with a visible leash back to primary); **two-tier consent** (reads pre-authorized per account and shown passively; **writes** into a logged-in account always require a per-action confirm showing exactly what will be typed/clicked).

**Reuses:** the existing consent state machine (renderer-as-authority, held-reply queue, revoke-on-generation-change, the overlay UI, SurfaceFrame.tsx:128-203) — generalized from "read provider data" to "perform autonomous action"; `focusAndZoom`/`goToPrimary` + the ⌘0 keybind (App.tsx:74) as the follow-mode camera + leash-back; the single `osActions.ts` choke point so one write-gate covers everything.

**New:** a **write-action consent gate inside `osControlSurface`** (per-action confirm with a human-readable diff, Allow-once / Always-for-account-*per-verb* / Deny); a **global STOP / "take the wheel"** control that synchronously suspends all autonomy and follow-mode (must hard-abort in-flight CDP — a real reliability dependency); a passive "BlitzOS is reading this page" indicator + an **activity ledger** ("what the OS did") with undo where possible; the `request_attention` flare + `AttentionPeek` chip (Go/Later/Mute); implement the **widget→OS write path** for the suggested-reply send (see §4), scoped to a fixed `send_reply` verb on the grouped account surface, gated by both a human click *and* the write-confirm.

**Resolved conflicts:**
- **Proactivity vs. safety.** The HCI critique is right that "flare-only, never auto-act" quietly *replaces* the proactive vision with a careful assistant. **Decision:** make proactivity a **dial** the user sets, with a *safe default*, not a fixed posture. Default = **Observe→Suggest** (perceive + propose, never auto-write). The user can raise the dial toward auto-action *per verb per account* (e.g. auto-draft always, auto-send never). The vision's "feel" is delivered by *fast, legible suggestion* + one-click approval, not by removing the human from sends.
- **Close the existing ungated holes first.** `App.tsx:146-150` lets any sandboxed srcdoc navigate a shared "Sources" web tab with **no consent**, and `App.tsx:154` forwards `{__blitz:'action'}` into the agent stream. These are live confused-deputy surfaces. They must be folded under the same write-gate, or the "all mutations funnel through one gate" invariant is a fiction.
- **Canvas-for-humans is an open product bet, not a settled phase.** Putting the human into canvas mode to see a periphery ring contradicts CLAUDE.md:9/61 ("desert-fog disorientation; the human gets a bounded stage"). **Decision:** the human stays on the **bounded primary stage by default**; the periphery ring is a *zoom-out gesture*, and follow-mode camera moves are the only time the view leaves primary (and only on accept). Full canvas-as-home is deferred behind a real product decision (§7).

---

## 4. The core loop spec — perceive → reason → act

Walked through on the **real primitives** for the customer-support scenario. Steps marked **[BUILT]** exist today; **[NEW]** is this plan's work.

**Setup / boot (L4 → L3):**
1. **[NEW]** On launch, `runBoot()` waits for the `renderer:ready` handshake, reads `Profile` (role = "customer-support", `accounts:[{provider:'discord', openUrl:'https://discord.com/app'}, …]`), and emits the **deterministic baseline**: a clock+welcome `srcdoc` widget into an ambient slot, and an `osOpenWindow(account.openUrl)` per account — **[BUILT]** `osOpenWindow` (osActions.ts:138) — arranged in periphery slots around the primary rect (reusing the `setIntegrations` centering template, store.ts:150).
2. **[BUILT]** Each opened web surface registers its `<webview>` wcid (`os:webview` → `ensureCapture`, osActions.ts:38-41,88), which injects the `INJECT` sensors. The accounts are now *sensed*.
3. **[NEW]** L4 hands `Profile` + last `Snapshot` to the resident brain (L3) as boot context; the brain enters its `/events` loop.

**Perceive (L2 — mostly BUILT):**
4. A new Discord message arrives. The page DOM mutates; **[BUILT]** the `MutationObserver` in `INJECT` (osActions.ts:78) fires, pushes a `content` signal with a fresh `digest` into the in-page buffer.
5. **[BUILT]** The 350ms `DRAIN` pulls it; `ingestSignals` (osActions.ts:95) coalesces. **Key:** a content-only mutation with no user signal does *not* wake the brain (`flush` requires `p.hasUser`, events.ts:116) — it only refreshes the surface's `snapshot`. *This is the cost firewall that already exists.* The user glancing at / clicking the tab (a `click`/`pointer` user signal) **does** produce a moment.
6. **[NEW]** The brain, woken, calls a **site perceptor** for `discord.com` (a scripted `read_window` on the **localhost-trusted** path) and gets a *structured* record: `{author, snippet, permalink, threadId, unread:true}` — not the flat digest. **[NEW]** dedupe checks `threadId` against the seen-set; it's new.

**Reason (L3 — NEW):**
7. **[NEW]** The governor confirms the message is in the attention set and budget allows a reason call. The brain (Opus, per repo rule) composes 1–N context-aware suggested replies from the structured record + role context.

**Act — surface the widget (L3 → L1, gated by L5):**
8. **[NEW]** The brain authors a *standard context-widget* (message header + body + reply chips + editable draft + Send) and `spawn_widget`s it — **[BUILT]** spawn path (agentSocket.ts:312) — with a **[NEW]** `transient` flag (never enters the saved library) into a `role='reply'` periphery slot near primary, `group`-linked to the Discord surface.
9. **[NEW]** The reply text is pushed via **[BUILT]** `blitz.props`/`onProps` (widget-bridge.ts:13,24) — *not* an html rewrite — so there's no consent re-prompt (an html change clears consent by design, SurfaceFrame.tsx).

**Attention (L5 — NEW):**
10. **[NEW]** The brain calls `request_attention{surfaceId, reason:"Reply needed · Discord", severity}`. The OS does **not** teleport: the peripheral surface pulses and an `AttentionPeek` chip appears at the primary edge ("Reply needed · Discord — Go / Later / Mute"). On **Go**, **[NEW]** `focus` os:action drives the **[BUILT]** `store.focusAndZoom` (store.ts:131) with an eased tween and a visible "Back to work ⌘0" leash. Severity dedup + rate-limit prevent a notification hellscape.

**Act — send (L5 gate → L1):**
11. The human picks a reply chip → fills the editable draft → presses **Send**. **[NEW]** The widget calls `blitz.tool('send_reply', …)` over a **new** `op:'tool'` branch in the bridge (today only `op:'data'` exists; SurfaceFrame.tsx:177 rejects everything else). This is the **first widget→OS write path** — scoped to the single `send_reply` verb on `surface.group` only.
12. **[NEW]** Before any keystroke reaches the logged-in page, the **write-consent gate** in `osControlSurface` emits `os:confirm` with a diff ("Type \"…\" into Discord and press Enter? Allow once / Always-send-Discord / Deny"). Reads were pre-authorized; *writes always confirm* (until the user dials up per-verb auto-send).
13. On Allow, **[BUILT]** `osControlSurface` → `control-core` `type` + `key:Enter` (control-core.mjs) types into the real logged-in Discord compose box and sends. **[NEW]** a read-back-verify reads the compose box content before pressing Enter (best-effort against a structureless read — see risks). A "sent/failed" echo returns to the widget via props.

**Cost control throughout:** the moment coalescer + `hasUser` gate (BUILT) ensures the brain wakes on user-meaningful moments, not clock ticks; the governor's attention set + persisted budget (NEW) bounds reason calls; vision-fallback extraction is rate-limited and exception-only.

---

## 5. Persistence & profile model

**Storage:** atomic JSON under `app.getPath('userData')/state/` (same seam as `tokenStore.ts:15`), atomic temp+rename (as `widget-catalog.mjs:120`). teenybase-D1 schema designed-in for the later multi-device/hosted sync tier (local JSON authoritative until sync is explicitly enabled; `save_version` CAS guards D1 writes).

```ts
// profile.json (one)
interface Profile {
  userId: string
  displayName: string
  role: string                  // free-text, e.g. "customer-support"; agent interprets
  accounts: Array<{             // derived from integrations.connectedProviders()
    provider: string            // 'discord' | 'gmail' | ...
    openUrl: string             // the page to auto-open as a tab
    kind: 'web'
    label: string               // never a token
    autoOpen: boolean
  }>
  bootIntent?: string           // NL goal the agent expands; baseline runs first regardless
  preferences: { units?, timezone?, welcome?: boolean,
                 proactivity?: 'observe'|'suggest'|'act',         // L5 dial, default 'suggest'
                 writeGrants?: Record<string,string[]> }          // account -> allowed verbs (persisted)
  // NEVER stores tokens/secrets (schema-validated allowlist of fields)
}

// snapshot (current + 5-deep ring)
interface Snapshot {
  savedAt: number
  surfaces: Array<SurfaceDescriptor & {            // SurfaceDescriptor today (osActions.ts:9)
    z: number; zoom?: number                       // requires widening sendState (L1)
    role?: 'primary'|'account'|'ambient'|'context'|'reply'   // advisory
    group?: string                                 // links reply-widget -> account surface
    transient?: boolean                            // never persisted/resurrected
    // srcdoc html persisted ONLY for non-transient; library widgets re-fetched by name
  }>
  camera: { transform, mode: 'desktop'|'canvas', focusedId? }   // for follow-mode restore
}

// brain state (L3-owned, separate file)
interface BrainState {
  budget: { tokensSpent, dollarsSpent, actionsThisMinute }      // survives restart
  seen: Record<string, number>      // stable record id (threadId/permalink) -> ts; dedupe
  // consent grants deliberately NOT here — re-prompt on restore is the safe default
}
```

**Boot / onboarding assembly (L4 → L3):**
- **First run, no profile:** an onboarding `srcdoc` widget asks role + which accounts to auto-open, then writes `Profile` via `patch_profile` (localhost-trusted only).
- **Subsequent boots:** `runBoot()` (after `renderer:ready`) runs the **deterministic baseline** (welcome+clock + auto-open accounts into periphery) so the desktop is never empty — *independent of the brain*. Then it hands `Profile` + last `Snapshot` to the brain, which improvises on top. **The brain is the single owner of on-screen state**; the baseline is a floor.
- **Honest limits:** restored web tabs come back logged-out in server mode (ephemeral profile) until the persistent-profile L1 change lands; one-off inline widgets are not resurrected (`transient`); consent re-prompts on restore.

---

## 6. Roadmap — phased build plan with critical path

**The first thing to build (CRITICAL PATH step 0):** **Close the live moment-snapshot privacy leak.** Today `moment.snapshot` (a digest of a logged-in third-party page) ships to a pasted-URL relay agent via `waitForEvents` (events.ts → agentSocket.ts:396) with **no per-surface consent**. *Nothing else may be built on the moment stream until the relay defaults to metadata-only and raw content requires an explicit per-surface grant.* This is a present hole, not a future risk, and the entire perception story sits on top of it.

The critical path then follows: **P0 (privacy gate) → P1 (resident loop, observe-only) → P2 (governor + control gate) → P3 (attention + act tier through existing tools) → P4 (boot/profile/persistence) → P5 (server-mode parity + reliability) → P6 (deferred: D1 sync, multi-tenant).**

### P0 — Close the privacy leak + reach unblock *(prerequisite)* — ✅ LANDED (Electron) 2026-06-05
- **Builds from:** `events.ts` moment shape, `waitForEvents`, the existing consent ledger pattern.
- **Builds:** relay `/events` defaults to metadata-only (strip `snapshot`); raw content per-surface grant; **also** fold the existing ungated `__blitz:'navigate'` (App.tsx:146) and `surfaceAction` (App.tsx:154) paths under consent.
- **Unblocks:** any safe consumption of the moment stream.
- **Done:** per-surface `contentShared` consent in `events.ts` (`setContentShare`/`isContentShared`/`redactMoment`, default OFF). Relay gates all 3 content egresses (`/events` redacts to metadata, `read_window` + `surface_control:read/screenshot` → 403 `not_shared`); localhost control-server stays full (the brain's path). 👁 share toggle per web surface (`SurfaceFrame`, Electron-only) → `os:content-share` IPC; dropped on close. `__blitz:navigate` now http(s)-only; `surfaceAction` payload capped 4KB. Typecheck + build pass. *Remaining:* server-mode (`backend.mjs`) relay content gating → P5 (no `/events` kernel there, so no proactive leak today).

### P1 — Resident loop, OBSERVE-ONLY *(no mutations)* — ✅ LANDED 2026-06-05
- **Builds from:** `/events` (control-server.ts), `osReadWindow`, the moment stream, `index.ts` startup wiring.
- **Builds:** `brain/orchestrator.ts` started from `index.ts` alongside `startControlServer`; subscribes to `/events`, logs "world deltas," reasons into an activity-log summary, **zero osActions calls**. Decide: hosted API vs headless child (§7).
- **Unblocks:** proves a long-lived loop runs without acting. *Note: this is NOT a new perception subsystem — that exists; this is the missing consumer.*
- **Done:** `src/main/brain/orchestrator.ts` (`startBrain`, started from `index.ts` after `startAgentSocket`) consumes the moment stream IN-PROCESS via `waitForEvents` (trusted, full content — no relay round-trip) and reasons each significant moment into an Observation ring (console + localhost `GET /brain/log`). **Imports no osActions and hands the reasoner no tools → observe-only by construction.** `brain/reasoner.ts`: pluggable `Reasoner` — `deterministic` (default, zero-cost; significance = nav/idle/action) + optional headless `claude -p` (text-in/out, no tools) via `BLITZ_BRAIN=claude`; `off` disables. The §7 "where the brain runs" decision is deferred — both reasoners plug into this loop. Typecheck + build pass; deterministic reasoner unit-tested.

### P2 — Governor + human-control gate *(Suggest mode; no auto-act)*
- **Builds from:** P1 loop; the existing widget-consent ledger generalized to actions; the `AGENTS_MD`/tools.json prompt-cache blob; the `USER_TYPES` coalescing as the (already-built) cheap triage.
- **Builds:** `brain/governor.ts` (attention set, persisted budget, actions/min ceiling, degrade-to-observe); `consent.ts` + renderer control panel (Observe/Suggest/Act dial, **STOP/take-the-wheel** with synchronous CDP abort, budget meter, activity ledger).
- **Unblocks:** the brain may *propose* (queued for approval) but executes nothing.

### P3 — Act tier + attention/follow + suggested-reply widget *(the payoff)*
- **Builds from:** P2 gate; `spawn_widget`/`surface_control` (existing); the unreachable `store.focusAndZoom` (store.ts:131); `blitz.props` live-push.
- **Builds:** new `os:action` cases `focus`/`set_mode`/`follow` + `request_attention` flare/`AttentionPeek`; the **`op:'tool'` `send_reply`** bridge path (scoped, gated); **site perceptors** for gmail/discord returning structured records; the standard context-widget shape; `transient` lifecycle; read-back-verify before send.
- **Unblocks:** the full §4 scenario end-to-end (Suggest default; send always-confirm).

### P4 — Boot assembly + profile + persistence + dedupe memory
- **Builds from:** P3 act tier; `tokenStore.ts` userData seam; `widget-catalog.mjs` atomic write; `connectedProviders()`; the (widened) sendState projection.
- **Builds:** `StateStore` (atomic JSON + ring); `Profile`/`Snapshot` schema; `renderer:ready` handshake; `runBoot()` deterministic baseline + brain handoff; `patch_profile`/`save_layout`/`restore_layout` (localhost-only); persisted seen-set + budget; widen `sendState` to include z/zoom/transform/mode (L1).
- **Unblocks:** the OS boots assembled, remembers, and doesn't re-surface old messages.

### P5 — Server-mode perception parity + always-on reliability — 🟡 PARTIAL (perception/brain LANDED 2026-06-05)
- **Builds from:** `browser-host.mjs` `session(id)` + CDP event fan-out; P1–P4.
- **Builds:** port the sensor/moment machinery into server mode (it has none today); persistent/shared server browser profile (logins survive); respawn supervisor + CDP reconnect; idempotent `createSurface`.
- **Unblocks:** the previewed product (agentos.blitzmen.com) actually runs the brain; always-on is real.
- **Done (perception/brain half):** the perception kernel + brain were extracted to shared `src/main/perception-core.mjs` (coalescer + content-share + `INJECT`/`DRAIN` sensors) and `src/main/brain/{reasoner,orchestrator}.mjs`; `events.ts` re-exports them (one implementation, no per-transport drift). `preview/backend.mjs` now injects the sensors into each server Chromium target over CDP (`Runtime.evaluate(INJECT/DRAIN)` on a 350ms drain, supervised against live targets), feeds the SAME coalescer, exposes the `/events` tool (relay-redacted by the same content-share consent), runs the resident brain (`startBrain('server-brain')`), and adds `POST /api/os/content-share` + `GET /api/os/brain-log`. The 👁 share toggle now shows in server mode. **Verified end-to-end in headless Chromium:** click → idle moment → `/events` redacted un-shared / full when shared → brain observation. So the link (agentos.blitzmen.com) runs the autonomy loop.
- **Remaining (reliability/login half):** persistent/shared server browser profile (today `mkdtempSync` = logged-out each run), respawn supervisor + CDP reconnect, idempotent `createSurface` (the browser-host audit majors), and the server-mode `surfaceAction` callback (widget "approve" → moment). These are the always-on hardening.

### P6 — Deferred: teenybase-D1 sync + multi-tenant
- **Builds from:** repo teenybase core + `save_version` CAS; P1–P5 stable.
- **Builds:** D1 schema for profile+snapshot; sync adapter (local authoritative); per-tenant brain state (the single-window `getWin`/`cached` globals must be replaced for multi-user).
- **Unblocks:** multi-device + hosted always-on brain.

---

## 7. Risks & open questions

**Top risks (load-bearing):**
1. **Runaway autonomy on a logged-in session.** The brain can type into the user's real Gmail/Discord. Mitigation is non-negotiable and gates shipping any auto-act: Observe/Suggest default, hard synchronous STOP, per-action write-confirm with diff, per-verb (never per-account-blanket) grants, actions/min ceiling, undoable activity ledger. *Dropping the "in-process for eval" framing materially reduces this — the brain does not need eval to do its job.*
2. **The live privacy leak (P0).** Page digests already flow off-device to a remote agent with no consent. Highest-severity *present* issue; must be closed first.
3. **Cost blowup.** A model-in-a-loop is unbounded without the governor. The existing `hasUser` coalescing gate (events.ts:116) is the first firewall and already ships; the attention set + persisted budget + degrade-to-observe are the backstop. Vision-fallback extraction is the cost cliff — exception-only.
4. **Coarse/brittle perception → wrong sends.** `read_window` is structureless innerText; site perceptors add structure but rot against Gmail/Discord DOM churn. The send path types into a compose box guessed from that read — a wrong-field send into a logged-in account is worse than no automation. Mitigation: read-back-verify + staleness health-check + the human watches the send land until perceptors are proven. Acceptable in Suggest, dangerous unattended.
5. **Server-mode logins don't persist.** Ephemeral `mkdtempSync` profile = always logged-out. The vision's "accounts auto-open already logged-in" is not achievable until the persistent-profile change lands (P5). Restore is honest: it restores the tab, not the session.
6. **Reliability beneath an always-on loop.** No respawn supervisor, no CDP reconnect, single-client Electron debugger idle-detach. A long-running brain will outlive a dead browser and must detect+degrade. STOP must hard-abort in-flight CDP — today that can hang.
7. **Single-window/single-tenant globals** (`getWin`/`cached`/`osState`). Fine for the Electron MVP; structurally blocks the server-mode multi-user vision (the actual deploy target). Must be called out before anyone builds on them as multi-tenant.

**Open questions (need a user decision):**
- **Where does the brain run** — hosted Claude API call from main, or a spawned headless Claude Code/Codex child (the arch doc's plan)? The former is simpler to budget/cache; the latter matches the doc and the relay's existing "agent on the other end" model. Affects supervision and reliability.
- **Proactivity dial default** — Observe vs Suggest on first run; and is a persistent "always-send-to-Discord" grant ever acceptable, or must every *send* always confirm regardless of dial?
- **Canvas-for-humans** — does the human ever live in canvas mode (to see the periphery ring), or stay bounded with the ring as a zoom-out gesture? Contradicts CLAUDE.md's stated HCI rationale; needs a product call before full canvas-as-home.
- **Dedupe identity** when a site exposes no stable record id — accept content-hash with its edit/reorder failure modes, or invest in per-site id extraction (more rot)?
- **How much content leaves the device by default** — even metadata ("message from boss@corp needs reply") is sensitive. Opaque "surface X has an item" until the human grants content sharing?
- **Multi-account per provider** (two Gmail tabs) — `tokenStore` is single-record-per-provider and webviews share a partition; the periphery vision shows multiple logged-in accounts. Needs a model before that's real.

---

## 8. Primitive-reuse table

| Vision capability | Existing primitive it builds on (real) | New glue needed |
|---|---|---|
| Mutate the desktop (open/move/update/close) | `osActions.ts` send/os* helpers — single choke point, both transports | The brain calls these in-process via the localhost path; one consent gate here covers everything |
| Render logged-in 3rd-party pages, sidestep API scopes | Electron `<webview partition="persist:agentos">`; server `browser-host.mjs` top-level targets (XFO bypass) | Persistent/shared server browser profile (replace `mkdtempSync`) so logins survive |
| Read the open page (not the API) | `osReadWindow` `executeJavaScript` (osActions.ts:116); `control-core` `read` | **Site perceptors** — scripted structured extraction on the trusted path; vision fallback + staleness check |
| Wake on "something happened" | `INJECT` sensors + `events.ts` moments + `/events` long-poll (**built**, CLAUDE.md:60) | Consume `/events` from a resident loop; **do not rebuild** the bus |
| Don't wake on clock/animation churn | `events.ts` `hasUser`/`USER_TYPES` gate (events.ts:116) — **built** cheap firewall | Nothing — this is the (non-model) triage tier already shipped |
| The brain that initiates | `control-server.ts` localhost path + full tool set + `/events`; `AGENTS_MD`/tools.json contract | `brain/orchestrator.ts` + `governor.ts` (tiering, attention set, persisted budget, degrade-to-observe) |
| Suggest replies in a widget | `spawn_widget`/`save_widget`; `srcdoc` runtime; `blitz.props`/`onProps` live-push (no reload) | `transient` lifecycle (no library pollution); standard context-widget shape fed via props |
| Click "send" from a widget → real page | `blitz` bridge postMessage (object-identity auth); `surface_control` type/key (`control-core`) | **New `op:'tool'` `send_reply`** branch (today only `op:'data'`); scoped to `surface.group`; write-confirm gated |
| Move the human's attention | `store.focusAndZoom`/`setMode`/`panBy` (built, **unreachable**); `goToPrimary` + ⌘0 leash | New `os:action` `focus`/`set_mode`/`follow` cases in App.tsx dispatch; `request_attention` flare/peek; eased tween |
| Consent for autonomous actions | Per-(surface,provider) data-consent SM + revoke-on-change (SurfaceFrame.tsx:128); eval localhost/relay split | Generalize the SM to a **write-action gate** in `osControlSurface`; per-verb persisted grants; STOP/ledger; close `__blitz:navigate` hole |
| Boot assembly (welcome + accounts) | `osOpenWindow`; `setIntegrations` centering template (store.ts:150); PRIMARY_W/H | `runBoot()` deterministic baseline + `renderer:ready` handshake; periphery `ringSlot`; brain handoff |
| Survive a restart | os:state `cached` buffer (osActions.ts:35); `tokenStore` userData seam; atomic write (widget-catalog.mjs:120) | `StateStore` (atomic JSON + ring), `Profile`/`Snapshot` schema, widen `sendState` projection (L1) |
| Multi-device / hosted brain (later) | teenybase D1 core; `save_version` CAS (MEMORY.md); KV-pointer pattern | D1 schema + sync adapter (local authoritative); per-tenant brain state (replace single-window globals) |
