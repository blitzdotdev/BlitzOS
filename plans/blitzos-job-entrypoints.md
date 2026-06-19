# BlitzOS — Job Entry Points and Outward Status Surfaces

Status: SPEC FOR REVIEW (no code written). This is the Phase 2 entry-points spec for A macOS helper, B in-app HUD, A5 menubar, native notifications, and dock badge. It depends on `plans/blitzos-job-task-model.md`: the central finding is still that there is no first-class Job/Task work-unit object in BlitzOS today, and that object is the linchpin for B3 job framing, W1 widget binding, W2 steering target, E1 continuation arming, and the A4 Send payload. Any change that adds a Job/Task primitive, a context association, or persistence fields is a DECISION THAT NEEDS USER SIGN-OFF.

## Decisions Already Made

- W2 boundary: BlitzOS only ticks, diffs, and emits the diff as perception, while the agent owns steering judgment. Verified current code matches this doctrine: `perception-core.mjs:310` says "ZERO per-task/stuck/threshold", and `perception-core.mjs:467` says the heartbeat emits only if the diff is "MATERIAL".
- A/B simplification: A and B share one Raycast-like input component with two shells. Current source already points at that convergence: `launcher.ts:31` says "same UI behind an in-app keybind HUD", and `launcher.ts:32` says "share the HTML".
- The entry-point layer is glue. It must compose existing OS primitives and hand a typed Job/Task payload to the spine in `plans/blitzos-job-task-model.md`; it must not invent a second wake, delivery, planning, or steering mechanism.

## Current State (Verified)

- No first-class Job/Task work unit exists in the current runtime. The boot mapper explicitly says "The Job model is retired" at `index.ts:1058`; `electron-os-tools.ts:79` says "`start_workflow` replaces the retired `start_job`"; `os-tools.mjs:641` exposes `/spawn_agent`; and `os-tools.mjs:643` describes it as "a fresh peer agent". This is the core gap this doc depends on, not a local entry-point detail.
- A Shell A prototype exists, but it is a workflow launcher, not the desired Job/Task entry point. `launcher.ts:1` calls it the "STANDALONE Launcher"; `launcher.ts:10` says Send calls `electronOps.startWorkflow`; `electron-os-tools.ts:84` implements `startWorkflow`; and `electron-os-tools.ts:85` calls `osSpawnAgent`. It passes attachment strings as context text only: `electron-os-tools.ts:86` checks `contextRefs`, and `electron-os-tools.ts:88` appends them into `osUserMessage`.
- The current launcher intentionally diverges from the requested NSPanel recipe. `launcher.ts:18` says it is "NOT a macOS panel"; `launcher.ts:23` says it "takes key focus on reveal"; `launcher.ts:315` constructs a `BrowserWindow`; and `launcher.ts:342` sets `focusable: true`. That prototype is useful input, but the target A/B architecture remains one shared input component with two shells.
- The known non-activating helper-window recipe is the onboarding drag helper. `onboarding.ts:230` creates a `BrowserWindow`; `onboarding.ts:237` sets `type: process.platform === 'darwin' ? 'panel'`; `onboarding.ts:238` sets `frame: false`; `onboarding.ts:239` sets `transparent: true`; `onboarding.ts:246` sets `focusable: false`; `onboarding.ts:257` calls `setAlwaysOnTop(true, 'floating')`; `onboarding.ts:258` calls `setVisibleOnAllWorkspaces`; and `onboarding.ts:264` calls `showInactive()`.
- The focused BlitzOS keybind route exists but is not a job HUD. `index.ts:211` sends `os:keybind` with `{ id: 'tile' }`; `preload/index.ts:144` exposes `onKeybind`; and `App.tsx:1047` registers a handler that only checks `k.id === 'tile'`. This is enough for B2 when BlitzOS is focused, not for a backgrounded macOS helper.
- Electron `globalShortcut` is not unused in the current tree. `index.ts:1` imports `globalShortcut`; `index.ts:613` registers `Alt+Space` for `os:notch-toggle`; and `index.ts:1162` unregisters `Alt+Space`. The entry-point spec therefore needs a shortcut ownership decision, not a first-ever global shortcut claim.
- The only renderer `.hud` is the Connect-AI modal, not an input launcher. `App.tsx:2663` gates `showAi`; `App.tsx:2665` renders `className="hud"`; `App.tsx:2666` labels it "Drive BlitzOS from an AI chat"; and `App.tsx:2675` shows a read-only `hud-input` containing `aiUrl`.
- The rail is an icon dock, not a prompt HUD. `Sidebar.tsx:26` calls it "Left dock"; `Sidebar.tsx:30` exports `Sidebar`; `Sidebar.tsx:144` renders `<div className="sidebar">`; and `Sidebar.tsx:148` maps surfaces into buttons.
- Localhost ingress exists, but discovery is hard for an external extension. `control-server.ts:17` says it is "Bound to 127.0.0.1 on an ephemeral port"; `control-server.ts:25` checks the bearer token; `control-server.ts:144` dispatches shared tools with `transport: 'localhost'`; and `control-server.ts:171` calls `server.listen(0, '127.0.0.1')`.
- `/user_say` is trusted localhost-only user input. `os-tools.mjs:603` defines `/user_say`; `os-tools.mjs:605` says "localhost transport ONLY"; `os-tools.mjs:608` rejects non-localhost with 403; `osActions.ts:827` documents `USER -> agent`; and `osActions.ts:836` calls `emitUserMessage`.
- The relay paste URL exists but is a separate remote-agent path. `agentSocket.ts:69` receives `onUrl`; `agentSocket.ts:71` calls `setRelay(url)`; and `agentSocket.ts:74` sends `agentsocket:url` to the renderer.
- Canvas file ingest is copy-only into the active workspace. `osActions.ts:968` says dropped files and folders are copied; `osActions.ts:974` calls `wsHost.ingestPaths`; `workspace-host.mjs:211` says "copied recursively into the workspace"; `workspace-host.mjs:218` calls `copyDroppedEntry(activeWorkspace, p)`; and `workspace.mjs:1004` uses `cpSync` for directories while `workspace.mjs:1007` uses `copyFileSync` for files.
- The Chrome extension has no BlitzOS add-to-context action. `popup.html:42` has only `Connect this tab`; `popup.js:143` binds that button; `popup.js:148` sends `{ type: "connect" }`; `background.js:149` creates its own relay session with `connect`; and `background.js:187` calls `mintAgentToken({ label: "chrome-extension" })`. Its manifest lists browser permissions at `manifest.json:7`, including `tabs` at `manifest.json:9`, but no native app discovery channel.
- In-app status exists and can feed A5. `workspace-host.mjs:393` defines `CHAT_STATUSES`; `workspace-host.mjs:459` implements `setChatStatusLocal`; `workspace-host.mjs:477` exposes `chatStatusSnapshot`; and `workspace-host.mjs:487` implements `noteAgentActivity`.
- Action-items are the structured human-action channel. `action-items.mjs:56` documents `requestAction`; `action-items.mjs:73` stores `status: 'pending'`; `action-items.mjs:80` emits an `action-item`; and `action-items.mjs:85` exposes `listActions`.
- Native outward status is not implemented as an Electron surface. The Electron entrypoint import at `index.ts:1` includes `app`, `BrowserWindow`, `Menu`, `globalShortcut`, and `screen`, but no `Tray` or `Notification`; current "tray" strings are the launcher attachment tray, for example `launcher.ts:156` and `launcher.ts:171`; and `wallpaper.ts:1` is the only verified `nativeImage` import.

## What To Build

1. Shared input component, two shells. Extract the existing prompt/tray affordance from `launcher.ts:80` `launcherHtml()` into a shared job-entry input that both A and B use. Preserve the affordances decided for both shells: text prompt, drag-drop files/folders, add-browser-window, and Send. Shell B can first render inside the L1 UI window through the existing keybind route (`preload/index.ts:144`, `App.tsx:1047`). Shell A must be its own global helper window, with the target recipe cloned from `onboarding.ts:230-264`. Because current launcher code documents a normal-window workaround at `launcher.ts:18-24`, validate the final NSPanel behavior with drag-drop before replacing the prototype.
2. Shortcut ownership. Decide whether A/B takes `Alt+Space`, moves the notch, or uses a new default accelerator. This is required because `index.ts:613` already owns `Alt+Space`. The implementation should centralize shortcut registration and unregister on quit, following the existing cleanup at `index.ts:1162`.
3. A4 Send job-kickoff IPC. Replace the current `launcher:start-workflow` path (`launcher.ts:397`) with a Job/Task-aware Send IPC after `plans/blitzos-job-task-model.md` is approved. The glue sequence should be: create the Job/Task work unit, spawn the owning agent through the existing agent primitive (`osActions.ts:917` `osSpawnAgent`), ingest dropped files through the extended ingest path (`osActions.ts:972`), create or associate web context surfaces through `osCreateSurface`, then deliver the prompt through `osUserMessage` and `emitUserMessage` (`osActions.ts:827-836`). Do not use `osSay` for kickoff, because `osActions.ts:812` says it is "Agent -> user".
4. A2 context ingest. Extend `ingestPaths` and `copyDroppedEntry` with an explicit mode, `copy`, `symlink`, or `mirror`, plus a Job/Task context association. Today it copies into the active workspace only (`workspace-host.mjs:218`, `workspace.mjs:1004`, `workspace.mjs:1007`). The association shape belongs to the Job/Task spine: either Job `contextRefs[]` points at ingested artifacts, or surfaces/files gain a `jobId` or `contextOf` field. This is a DECISION THAT NEEDS USER SIGN-OFF because it touches core persistence.
5. A3 browser add-to-context. Add a new "Add to BlitzOS" button beside `popup.html:42` "Connect this tab". The hard part is discovery: the extension cannot read the session file, and BlitzOS listens on an ephemeral port (`control-server.ts:171`). Options: fixed-port localhost handshake, relay-advertised context session, or the simpler reframe where the extension hands BlitzOS the current URL and BlitzOS opens it in its own logged-in `persist:agentos` web surface. Recommend the reframe for v1: it avoids token bridging and makes the context a normal BlitzOS web surface.
6. A5 menubar. Add an Electron `Tray` owned by a new main-side module and instantiated from the `app.whenReady` area (`index.ts:294`). Feed it from `chatStatusSnapshot` (`workspace-host.mjs:477`) and action-items (`action-items.mjs:85`). It should show high-signal state only: error, job done, action needed, and crash recovered.
7. Native notifications. Add a thin `notify.ts` around Electron `Notification`, called only from a content-agnostic whitelist. Candidate trigger seams: crash/system moment (`perception-core.mjs:606`), chat status `error` (`workspace-host.mjs:459`), action item created (`action-items.mjs:80`), and Job status `done` once the Job model exists. Skip routine `working` and `watching` churn, mirroring W2's "quiet desktop" rule at `perception-core.mjs:485`.
8. Dock badge first slice. Add `app.setBadgeCount` from main for pending action-items and, later, unread job-agent messages. The renderer already computes an inbox count: `App.tsx:2307` defines `inboxPending`, and `App.tsx:2608` renders `inbox-badge`. Main needs its own source of truth rather than scraping renderer state.

## Sequencing

1. Get sign-off on the Job/Task spine in `plans/blitzos-job-task-model.md`, especially persistence and context association.
2. Decide shortcut ownership and Shell A window policy, because current `Alt+Space` and current normal-window launcher conflict with the desired global NSPanel shell.
3. Refactor the existing launcher UI into the shared input component, keeping Shell A behavior isolated from `App.tsx`.
4. Build Shell B over focused BlitzOS first using the existing `os:keybind` route, then wire Shell A as the background helper once shortcut/window policy is settled.
5. Replace `start_workflow` launcher Send with the Job/Task-aware A4 Send IPC and preserve the current primitive order: spawn, ingest, web context, user-message wake.
6. Extend A2 ingest modes and context association after persistence sign-off.
7. Ship the cheap dock badge and crash/error/action-needed notifications before the full A5 Tray.
8. Add A3 "Add to BlitzOS" with the URL-open reframe first; revisit fixed-port or relay-advertised discovery only if v1 cannot capture logged-in context.

## Risks

- Focus theft and drag-drop regression. The onboarding helper proves the non-activating pattern (`onboarding.ts:246`, `onboarding.ts:264`), while the current launcher documents an NSPanel drag blocker (`launcher.ts:18-24`). This needs a runtime validation pass before replacing Shell A.
- Shortcut collision. `index.ts:613` already registers `Alt+Space`, so a second helper shortcut can double-fire or fail registration.
- Ephemeral-port discovery. `control-server.ts:171` binds port `0`, which blocks a Chrome-extension localhost probe unless BlitzOS adds a fixed discovery surface.
- macOS notification permission. Electron `Notification` must be verified in the signed packaged build, not only in dev.
- Sandwich focus on notification click. Click handlers should focus the real UI window, not the parent pages layer; `index.ts:308` already has `focusPages`, and `index.ts:309` has `focusUi`.
- Context persistence drift. A2 and A3 context association must not silently disappear on restart, which is why the decision belongs to `plans/blitzos-job-task-model.md`.

## Open Decisions

1. DECISION THAT NEEDS USER SIGN-OFF: Job/Task persistence shape, either the spine's lighter agent-meta option or a dedicated Job entity. Entry points must not settle this locally.
2. DECISION THAT NEEDS USER SIGN-OFF: A2 context association, either Job-owned `contextRefs[]` or persisted `jobId`/`contextOf` fields on surfaces/files.
3. DECISION THAT NEEDS USER SIGN-OFF: Ingest mode semantics, especially symlink safety, copy/mirror lifecycle, and whether linked files survive workspace moves.
4. Shortcut owner: keep `Alt+Space` for the notch, move notch, or make the shared job input the owner.
5. Shell A window class: enforce the decided global non-activating NSPanel, or accept the current normal-window workaround if validation shows NSPanel cannot support the attachment-gathering workflow.
6. A3 discovery: fixed-port localhost handshake, relay-advertised context session, or recommended URL-open reframe.
7. Native notification taxonomy: exact whitelist, quiet guard, foreground suppression, and user opt-out policy.
8. Badge source of truth: pending action-items only for v1, or pending action-items plus unread job-agent messages.

## Cross-References

- `plans/blitzos-user-journey.md`, index and journey phase ordering.
- `plans/blitzos-job-task-model.md`, the spine: Job/Task work unit, Send payload, lifecycle, and context association.
- `plans/blitzos-plan-widget.md`, W1 editable plan widget and E3 job-status widget that the Job binds.
- `plans/blitzos-tick-diff-steer.md`, W2 supervisor heartbeat and content-agnostic steering boundary.
- `plans/blitzos-agent-autonomy-guardrails.md`, E1 continuation engine and the agent's Phase 1 plan-authoring duty.
- `plans/onboarding-case-file.md`, Phase 1 onboarding dependency.
