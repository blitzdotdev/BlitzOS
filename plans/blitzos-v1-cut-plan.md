# BlitzOS V1 cut plan (island-only)

**TL;DR.** V1 is the dynamic island, nothing else. Rip out the entire infinite canvas (camera, slot lattice, stages, workspaces, surfaces-as-canvas-nodes) and every canvas word an agent can see. The island becomes: a home grid of widgets (Chat + agent-made), full-markdown chat per agent session, tool attachments (browser/computer use) added pre-spawn, and blitzscript workflows the agent triggers itself. Older branches preserve everything we cut, so cut hard.

**Source.** Synthesized from the 12-subsystem cut analysis (ultracode workflow, branch `blitz-v1`). The widgets-pipeline reader + the 3 adversarial critics were rate-limited, so the review below was done by hand (grounded in the 12 inventories + targeted code checks), not by the critic agents.

---

## The big decision — RESOLVED: web surfaces are axed

Browser-use in V1 = the user's **real Chrome** via the connector extension (out-of-process). Computer-use = the native helper. Neither needs a BlitzOS-owned `web` surface.

**DECIDED (MJ): web surfaces are AXED.** BlitzOS owns **no `web` surface**. This cuts `WebTabView` + `BrowserNav` + the web renderer, **and the in-page `INJECT`/`DRAIN` perception sensors** (there is no BlitzOS page to inject into — the browser is perceived via `connection` moments instead). Agent-initiated web research routes through the connection or is deferred.

---

## Adversarial review (done by hand — replaces the rate-limited critics)

1. **`SurfaceFrame` is also the srcdoc widget HOST** (`serveTool`/`serveChat`/`blitz.tool` + `useJsxWidget`, with `widget-jsx`/`widget-bridge`/`widget-ui-kit`). Since **widgets are deferred** (see Deferred), V1 doesn't use this host — cut it with `SurfaceFrame` and restore from branch history when the experimental surfaces work lands, or leave it dormant (unwired). No extract-before-cut pressure for V1.
2. **Lattice cut-order (dangling deps, verified):** `stage-core`/`stages-core` are imported by `store.ts`, `types.ts`, `os-tools.mjs`, `osActions.ts`, `island-membership.mjs`, `workspace-host.mjs`, `onboarding-board.mjs`. Gut/cut every one of those before deleting the lattice files (adds `types.ts` + `island-membership.mjs` to SIMPLIFY).
3. **The island core is canvas-independent** (verified: `notch/` imports nothing from `store`/canvas). The KEEP island stands alone; all the risk lives in the SIMPLIFY bridge files.
4. **`os-tools.mjs` is the doctrine epicenter** (~109 canvas-ish lines) — both the heaviest SIMPLIFY and the heaviest agent-visible doctrine. Do it early, carefully, and re-read it as an agent would.
5. **Completeness gap filled:** the one reader that didn't run was widgets-pipeline; finding 1 covers it (the host = `widget-jsx`/`widget-bridge`/`widget-ui-kit`, KEEP-and-extract).

---

## KEEP (the V1 product)

- **Island:** `notch/NotchHost.tsx`, `IslandPanel.tsx`, `ChatInput.tsx`, `IslandHome.tsx` (new), `types.ts`, `notch.css`, `island.css`, `main/notch-overlay.ts`
- **Agent runtime:** `terminal-manager.mjs`, `control-server.ts`, `agent-narrator.mjs`, `agent-transcript.mjs`, `agent-runtime.mjs`*, `blitzscript/*` runtime, `workflow-host.mjs`, `workflow-bus.mjs`
- **Attachments (browser+computer use):** `connection-{tab,window,safari}-link`, `connection-install.ts`, `extension/*`, `computer-use-helper.ts` + `native/computer-use-helper/`, `browser-import.ts`
- **Perception loop:** `events.ts`, `perception-core.mjs`*, `telemetry.ts`
- **NEW:** markdown chat in `IslandPanel` (react-markdown + remark-gfm + block memoization)

## CUT (delete — recover from older branches if ever needed)

- **Canvas/nav:** `cameraController.ts`, `stage-core.mjs`(+`.d.mts`), `stages-core.mjs`(+`.d.mts`), `PrimarySpace.tsx`, `Sidebar.tsx`, `capture.ts`, `Overview.tsx`, `RadialSurfaceMenu.tsx`, `AnnotationLayer.tsx`, `FolderOverlay.tsx`, `FolderWidget.tsx`, `SurfaceLauncherButton.tsx`, `SurfacePreview.tsx`
- **Surfaces (web axed):** `BrowserNav.tsx`, `WebTabView.tsx`, `SurfaceFrame.tsx` (its srcdoc widget host is deferred — cut & restore later, or leave dormant; see finding 1).
- **Onboarding board:** `onboarding-board.mjs`(+`.d.mts`), `onboarding-layouts/`, `UnlockWidget.tsx`, `test-onboarding-seed.mjs`
- **Legacy island:** `notch/mock.ts`, `main/island.ts`, `island-bridge.mjs`, `launcher.ts`
- **Docs/tests:** `plans/blitzos-single-canvas-navigation.md`, `test-canvas-perception.mjs`, `test-tick-diff.mjs`

## SIMPLIFY (gut the canvas, keep the core)

- `store.ts` → a flat island store (drop camera/transform, slots, folders, marquee, annotations, undo). A fresh minimal store is cleaner than gutting in place.
- `App.tsx` → remove `.world` render + all gesture handlers (wheel pan/zoom, Shift-freeze, ESC switcher, ⌘T, splay, radial, drag-drop); keep the notch wiring.
- `styles.css` → strip canvas/dock/toolbar/marquee/snap/primary-space/radial/overview/folder selectors.
- `os-tools.mjs` → cut `place_widget`/`move_surface`/`bring_home`/`send_offscreen`/`go_to_primary` + the workspace tools; **no new widget tool** (widgets are deferred); rewrite all descriptions to island language.
- Also: `widget-tools.mjs`, `electron-os-tools.ts`, `osActions.ts`, `workspace.mjs`, `workspace-host.mjs`, `index.ts`, `agentSocket.ts`, `activity.mjs`, `connection-ops.mjs`, `ConnectPicker.tsx`, `preview/backend.mjs`, `onboarding.ts`, `onboarding-scan.mjs`, `OnboardingFlow.tsx`, `NotchHost/AttachPanel/attach.css` (remove the **Deep toggle + skill bar**).

## The autonomy engine (perception / moments / steering) — KEEP, minus the canvas eyes

This is *why BlitzOS exists* (the agent is woken by coalesced "moments" and acts, not a chatbot). It survives V1; only its canvas-specific senses go.

- **KEEP — the wake loop:** signals → `events.ts` coalescer → moments → `/events` long-poll wakes the agent. This is the engine; do not touch it.
- **KEEP — steering:** `/steer` (and the island's chat/steer bar) injects a *waking* message into an agent (`osUserMessage(text, agentId)`). It's how you redirect a running agent. The mechanism stays; in the UI it's just "message this agent."
- **KEEP — signal sources (V1):** `message` (chat), `connection` (the user's real browser/app via the extension + helper — now the **primary** world signal), `tick` (status-only — wakes the supervisor, see below), `system` (crash). (`action` = a widget-button click wakes the agent — **deferred with widgets**.)
- **CUT — the canvas eyes:** `trigger:'canvas'` (surface geometry), `trigger:'annotation'` (spatial xPct/yPct), and the **`INJECT`/`DRAIN` in-page DOM sensors** (web surfaces axed → no page to inject into).
- **RESOLVED — the supervisor tick (`emitTick` / `trigger:'tick'`): KEEP it, STATUS-ONLY.** The BlitzOS supervisor agent (`'0'`)'s **only** job is to keep the other agents on-track. **V1:** the tick keeps the **agent-status edges + terminal-exit** diff and wakes `'0'` to `/steer` a stalled / erred / diverged worker; the **surface-geometry/props diff is cut** (`getTickSnapshot` drops everything but agent status + terminal state). `/steer` stays. **Deferred (experimental, todo-last, same bucket as widgets):** on each wake `'0'` also **reads the woken worker's session `.jsonl`** (its transcript via `agent-transcript`) and judges whether it's actually doing its job, not just whether its status changed.

## Doctrine sweep — erase canvas from the agent world-model

These reach an agent's eyes. Delete or rewrite every spatial word (canvas / home / slot / lattice / park / zoom / stage / workspace-switcher / `place_widget` / `bring_home` / `send_offscreen` / `trigger:'canvas'`) into island language ("pin a widget" short/tall, "agent tabs", the chat):

**Concepts to delete everywhere:** canvas / infinite plane / home / off-home / park / off-screen / offstage / "arrange the desktop" · slot lattice / `place_widget` / spans / S-M-L-XL → **removed** (no widget tool in V1; widgets deferred) · stages / "each agent gets its own stage" → "one tab per agent" · workspaces / `switch_workspace` / Mission-Control switcher → single implicit workspace · `bring_home` / `send_offscreen` / `go_to_primary` · the radial create-at-cursor menu · "show me → open the source on the canvas" → an island target (a pinned widget) or just chat.

**Cut (delete the file) vs rewrite (keep the function, delete the spatial words):**
- **Cut:** `blitzos-externalize.md` (no externalization in V1 — the externalize-work-into-widgets doctrine defers with widgets).
- **Rewrite:** `blitzos-agents.md`, `os-tools.mjs` (tool descriptions), `agent-runtime.mjs` (the `stage` bootstrap fragment), `perception-core.mjs` (the standing nudge + `canvas`/`annotation`/`tick` triggers), `widget-catalog.mjs`, `onboarding.ts`, **`blitzos-interview.md` + `blitzos-onboarding.md` (chat-only, de-externalized — no board)**, `agent-os/CLAUDE.md` (dev doctrine for the team's coding agents).
- **Keep untouched:** `blitzos-orchestrator.md`, `plans/siri-prompt.md`, the prose/style rules.

---

## Deferred (post-V1, experimental — needs a notion of surfaces)

Explicitly NOT V1. The "notion of surfaces" V1 removes (canvas surfaces) returns here in a new form (island app surfaces).

- **Widgets** — the agent generating widgets, pinning, a queue/gallery, sizing. **No widget tool, no widgets tab in V1.**
- **Agent-generated icons + app-transform** — the agent creating a new island **icon** that transforms the dynamic island into a complete app UI (the way the built-in **Chat** icon transforms it into the chat UI today). V1 ships only the Chat icon.
- **Island-native surfaces** — the surface concept comes back here, distinct from the canvas surfaces V1 deletes. The `SurfaceFrame` srcdoc widget host + `widget-*` modules feed this (kept in branch history).
- **Deep supervision** — on wake, the supervisor (`'0'`) reads the woken worker's session `.jsonl` and judges whether it's actually on-task, beyond the status-edge wake. V1 is status-only.

**V1's island is:** a **1×3 icon bar** (just **Chat** → the chat/session app), full-markdown chat, tool attachments (browser/computer use), and workflows that report progress **in chat**.

## Owner split (from the whiteboard)

- **MJ — island spine.** Markdown chat; sever notch→canvas; gut `store.ts` → flat island store + fix `App.tsx`; `os-tools` de-canvas + `pin_widget`; remove Deep toggle + skill bar; the doctrine sweep.
- **R — tool attachments.** Browser-use (extension) + computer-use (helper) as **pre-spawn** attachments; re-home `ConnectPicker` into the new-session composer; rebuild the TCC grant prompt outside onboarding.
- **B — the icon / app-transform framework (light in V1).** Generalize the **1×3 icon bar** + the island "transform into an app UI" mechanism (the **Chat icon → chat app is done this session**). Agent-generated icons/apps + the widgets they'd pin = **deferred** (experimental, post-V1).

## Cut order (safe sequence)

1. **Doctrine sweep** — zero compile risk, unblocks agents immediately.
2. **Sever notch→canvas expand** (`App.tsx` `'open'` clip-grow → panel/peek only).
3. **Delete leaf canvas components** (only `App.tsx` imports them).
4. **Resolve the web decision**; **extract the widget host from `SurfaceFrame`** (finding 1), then cut `WebTabView`/`BrowserNav` + `SurfaceFrame`.
5. **Gut `store.ts`** → flat island store; fix `App.tsx` consumers.
6. **Delete `stage-core`/`stages-core` + `onboarding-board`** (the lattice).
7. **`os-tools`:** cut placement/workspace tools, add `pin_widget`.
8. **Collapse persistence** to one implicit workspace (chat.md + sessions + `state.json`).

## Open product calls (MJ to confirm)

1. ~~Web surfaces~~ — **RESOLVED: axed** (browser-use = the user's real Chrome via the extension; no BlitzOS `web` surface). Supervisor tick — **RESOLVED: keep status-only** (see autonomy engine).
2. ~~Interview duty~~ — **RESOLVED: keep the onboarding, chat-only.** The whole flow (scan → interview → personalization) happens in **one agent chat** (agent `'0'`) with **no externalization** — no case-file board, no seeded widgets, the agent just talks. Rewrite the duty docs chat-only; the board planner is cut, the scan survives as the chat agent's context primer.
3. **Single implicit workspace** + collapse persistence to one store — confirm (kills the switcher, `switch_workspace`, multi-folder).
4. **Island chat is native React** (`IslandPanel`) → cut the `blitz-chat` srcdoc system-renderer family (`ensureSystemRenderer`/`customize_widget`)?
5. ~~`run_workflow` live-viz~~ — **RESOLVED: deferred.** Widgets are deferred, so workflow progress reports **in chat** for V1; the live graph returns with the experimental surfaces.
