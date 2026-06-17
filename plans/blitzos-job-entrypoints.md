# BlitzOS — Job Entry Points (A macOS helper, B in-app HUD) + Outward Status Surfaces

Status: SPEC FOR REVIEW, no code. Terse companion to `plans/blitzos-user-journey.md` (Phase 2). Glue + shells over existing primitives; the `Job` it composes is `plans/blitzos-job-task-model.md` (build first).

## Decision (made)
A and B share ONE Raycast-like input component (prompt + drag-drop files/folders + add-browser-window + Send) behind TWO shells: A = a global non-activating `NSPanel`; B = the same component as an in-app keybind HUD over the BlitzOS window. Same affordances, same Send IPC.

## Verified anchors (refs only)
- Clone the onboarding dragHelper `NSPanel` pattern: `onboarding.ts:230-264` (`type:'panel'`+`focusable:false`+`showInactive()`).
- NO `globalShortcut` and NO `Tray` in the tree today (each is a first-ever primitive).
- Localhost control server binds an EPHEMERAL port (`control-server.ts:163` `server.listen(0)`); `/user_say` is localhost-only (forges real user input).
- The only `.hud` is the passive Connect-AI modal (`App.tsx:2537`).
- Kickoff primitives: `osSpawnAgent` (`osActions.ts:880`), `osIngestPaths` (`osActions.ts:909`, copy-only), `osSay`→`emitUserMessage` (`osActions.ts:799-819`).
- Chrome extension has ZERO BlitzOS link (`/Users/minjunes/agent-socket/chrome-extension`).
- Chat status fabric (`workspace-host.mjs` chatStatus) + action-items feed A5.

## What to build
- Shared input component + `NSPanel` shell + a new `globalShortcut`.
- A4 Send IPC (glue): `osSpawnAgent` → `osIngestPaths` → `create_surface{web}` per tab → `osSay`.
- A2: a `copy|symlink` mode flag + `Job` context association on ingest.
- A3: extension add-to-context.
- The outward surfaces (dock badge, `[N]` notifications, A5 Tray).

## Sign-off decisions
1. A1/B2 shell: add a 2nd always-on-top `NSPanel` + the first Electron `globalShortcut` (recommend; vs B-only for v1).
2. A2: extend `copyDroppedEntry`/`ingestPaths` with a `copy|symlink` flag + a `jobId` association (touches persistence / three-serializer rule).
3. A3 discovery: a sandboxed extension cannot read `~/.blitzos/session.json` + the ephemeral port. RECOMMEND the reframe: the extension hands BlitzOS a URL to OPEN and read in the logged-in `persist:agentos` tab (sidesteps discovery).
4. Native-notification WHITELIST taxonomy (lifecycle transitions only) + quiet hours / per-event opt-out.
5. Dock/Tray badge source of truth (action-items, unread say, or both); main owns the unread count.
6. A5 as an Electron `Tray` (recommend) vs a separate signed helper.

Risks: focus theft, ephemeral-port discovery, macOS notification permission in the signed build.

## Sequencing
Job first → dock badge + crash-path notify → A2 mode flag → shared component + Shell B + A4 Send → Shell A → A3 (c) → A5 Tray.

## Cross-references
`plans/blitzos-user-journey.md` (index) · `plans/blitzos-job-task-model.md` (the `Job` spine: the Send payload + context association depend on it; build first) · `plans/blitzos-plan-widget.md` (E3 in-app job status) · `plans/blitzos-agent-autonomy-guardrails.md` (the Job's Planning duty lives in the agent boot duty, not the Send IPC) · `plans/onboarding-case-file.md` (Phase 1).
