# BlitzOS V1 cut plan (island-only)

**TL;DR.** V1 is the dynamic island, nothing else. Rip out the entire infinite canvas (camera, slot lattice, stages, workspaces, surfaces-as-canvas-nodes) and every canvas word an agent can see. The island becomes: a home grid of widgets (Chat + agent-made), full-markdown chat per agent session, tool attachments (browser/computer use) added pre-spawn, and blitzscript workflows the agent triggers itself. Older branches preserve everything we cut, so cut hard.

**Source.** Synthesized from the 12-subsystem cut analysis (ultracode workflow, branch `blitz-v1`). The widgets-pipeline reader + the 3 adversarial critics were rate-limited, so treat the widget-host details and this synthesis as **review-pending** (re-run the critic pass to harden).

---

## The one blocking decision: do web surfaces survive?

Browser-use in V1 = the user's **real Chrome** via the connector extension (out-of-process). Computer-use = the native helper. **Neither needs a BlitzOS-owned `web` surface.** The only thing that does is the agent opening its *own* pages (`open_window`/`read_window`/`surface_control` over CDP on an in-DOM `<webview>`).

**Recommendation:** BlitzOS owns **no `web` surface** in V1. Agent web research is routed through the connection or deferred. This unblocks cutting `SurfaceFrame` + `WebTabView` + `BrowserNav` (~6 files). **Confirm before anyone touches the surface layer** — it gates the biggest cut.

---

## KEEP (the V1 product)

- **Island:** `notch/NotchHost.tsx`, `IslandPanel.tsx`, `ChatInput.tsx`, `IslandHome.tsx` (new), `types.ts`, `notch.css`, `island.css`, `main/notch-overlay.ts`
- **Agent runtime:** `terminal-manager.mjs`, `control-server.ts`, `agent-narrator.mjs`, `agent-transcript.mjs`, `agent-runtime.mjs`*, `blitzscript/*` runtime, `workflow-host.mjs`, `workflow-bus.mjs`
- **Attachments (browser+computer use):** `connection-{tab,window,safari}-link`, `connection-install.ts`, `extension/*`, `computer-use-helper.ts` + `native/computer-use-helper/`, `browser-import.ts`
- **Perception loop:** `events.ts`, `perception-core.mjs`*, `telemetry.ts`
- **NEW:** markdown chat in `IslandPanel` (react-markdown + remark-gfm + block memoization)

## CUT (delete — recover from older branches if ever needed)

- **Canvas/nav:** `cameraController.ts`, `stage-core.mjs`(+`.d.mts`), `stages-core.mjs`(+`.d.mts`), `PrimarySpace.tsx`, `Sidebar.tsx`, `capture.ts`, `Overview.tsx`, `RadialSurfaceMenu.tsx`, `AnnotationLayer.tsx`, `FolderOverlay.tsx`, `FolderWidget.tsx`, `SurfaceLauncherButton.tsx`, `SurfacePreview.tsx`
- **Surfaces (pending the web decision):** `SurfaceFrame.tsx`, `BrowserNav.tsx`, `WebTabView.tsx`
- **Onboarding board:** `onboarding-board.mjs`(+`.d.mts`), `onboarding-layouts/`, `UnlockWidget.tsx`, `test-onboarding-seed.mjs`
- **Legacy island:** `notch/mock.ts`, `main/island.ts`, `island-bridge.mjs`, `launcher.ts`
- **Docs/tests:** `plans/blitzos-single-canvas-navigation.md`, `test-canvas-perception.mjs`, `test-tick-diff.mjs`

## SIMPLIFY (gut the canvas, keep the core)

- `store.ts` → a flat island store (drop camera/transform, slots, folders, marquee, annotations, undo). A fresh minimal store is cleaner than gutting in place.
- `App.tsx` → remove `.world` render + all gesture handlers (wheel pan/zoom, Shift-freeze, ESC switcher, ⌘T, splay, radial, drag-drop); keep the notch wiring.
- `styles.css` → strip canvas/dock/toolbar/marquee/snap/primary-space/radial/overview/folder selectors.
- `os-tools.mjs` → cut `place_widget`/`move_surface`/`bring_home`/`send_offscreen`/`go_to_primary` + the workspace tools; **add `pin_widget {size: short|tall}`**; rewrite all descriptions to island language.
- Also: `widget-tools.mjs`, `electron-os-tools.ts`, `osActions.ts`, `workspace.mjs`, `workspace-host.mjs`, `index.ts`, `agentSocket.ts`, `activity.mjs`, `connection-ops.mjs`, `ConnectPicker.tsx`, `preview/backend.mjs`, `onboarding.ts`, `onboarding-scan.mjs`, `OnboardingFlow.tsx`, `NotchHost/AttachPanel/attach.css` (remove the **Deep toggle + skill bar**).

## Doctrine sweep — erase canvas from the agent world-model

These reach an agent's eyes. Delete or rewrite every spatial word (canvas / home / slot / lattice / park / zoom / stage / workspace-switcher / `place_widget` / `bring_home` / `send_offscreen` / `trigger:'canvas'`) into island language ("pin a widget" short/tall, "agent tabs", the chat):

`blitzos-agents.md` · `os-tools.mjs` (tool descriptions) · `agent-runtime.mjs` (the `stage` bootstrap fragment) · `perception-core.mjs` · `widget-catalog.mjs` · `blitzos-interview.md` · `blitzos-onboarding.md` · `blitzos-externalize.md` · `onboarding.ts` · `agent-os/CLAUDE.md`

---

## Owner split (from the whiteboard)

- **MJ — island spine.** Markdown chat; sever notch→canvas; gut `store.ts` → flat island store + fix `App.tsx`; `os-tools` de-canvas + `pin_widget`; remove Deep toggle + skill bar; the doctrine sweep.
- **R — tool attachments.** Browser-use (extension) + computer-use (helper) as **pre-spawn** attachments; re-home `ConnectPicker` into the new-session composer; rebuild the TCC grant prompt outside onboarding.
- **B — island home + widgets (experimental).** The 2-row×3-col home grid (**Chat tile done this session**); extract the widget host out of `SurfaceFrame`'s srcdoc bridge; pin/gallery + short/tall sizing; `wf-graph`/`wf-kanban` live-viz as pinned widgets.

## Cut order (safe sequence)

1. **Doctrine sweep** — zero compile risk, unblocks agents immediately.
2. **Sever notch→canvas expand** (`App.tsx` `'open'` clip-grow → panel/peek only).
3. **Delete leaf canvas components** (only `App.tsx` imports them).
4. **Resolve the web decision**, then cut `SurfaceFrame` + `WebTabView`/`BrowserNav`.
5. **Gut `store.ts`** → flat island store; fix `App.tsx` consumers.
6. **Delete `stage-core`/`stages-core` + `onboarding-board`** (the lattice).
7. **`os-tools`:** cut placement/workspace tools, add `pin_widget`.
8. **Collapse persistence** to one implicit workspace (chat.md + sessions + `state.json`).

## Open product calls (MJ to confirm)

1. **Web surfaces** — recommend extension-only, no BlitzOS `web` surface (see top).
2. **Interview duty** — keep it (de-canvased) or cut to the permission/sign-in frontload only? The agent-runtime + onboarding readers disagree; needs a call.
3. **Single implicit workspace** + collapse persistence to one store — confirm (kills the switcher, `switch_workspace`, multi-folder).
4. **Island chat is native React** (`IslandPanel`) → cut the `blitz-chat` srcdoc system-renderer family (`ensureSystemRenderer`/`customize_widget`)?
5. **`run_workflow` live-viz** → a pinned widget (B owns), or degrade to headless `result.json`?
