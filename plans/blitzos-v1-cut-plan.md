# BlitzOS V1 cut plan (island-only)

**TL;DR.** V1 is the dynamic island, nothing else. Rip out the entire infinite canvas (camera, slot lattice, stages, workspaces, surfaces-as-canvas-nodes) and every canvas word an agent can see. The island becomes: a home grid of widgets (Chat + agent-made), full-markdown chat per agent session, tool attachments (browser/computer use) added pre-spawn, and blitzscript workflows the agent triggers itself. Older branches preserve everything we cut, so cut hard.

**Source.** Synthesized from the 12-subsystem cut analysis (ultracode workflow, branch `blitz-v1`). The widgets-pipeline reader + the 3 adversarial critics were rate-limited, so the review below was done by hand (grounded in the 12 inventories + targeted code checks), not by the critic agents.

---

## The one blocking decision: do web surfaces survive?

Browser-use in V1 = the user's **real Chrome** via the connector extension (out-of-process). Computer-use = the native helper. **Neither needs a BlitzOS-owned `web` surface.** The only thing that does is the agent opening its *own* pages (`open_window`/`read_window`/`surface_control` over CDP on an in-DOM `<webview>`).

**Recommendation:** BlitzOS owns **no `web` surface** in V1. Agent web research is routed through the connection or deferred. This unblocks cutting `WebTabView` + `BrowserNav` and the web renderer. **Confirm before anyone touches the surface layer** — it gates the biggest cut.

---

## Adversarial review (done by hand — replaces the rate-limited critics)

1. **`SurfaceFrame` is the widget HOST, not just a canvas renderer — do NOT just delete it.** It carries the srcdoc widget bridge (`serveTool`/`serveChat`/the `blitz.tool` allowlist + `useJsxWidget`) that the widgets tab depends on. **Extract that host (with `widget-jsx.ts` / `widget-bridge.ts` / `widget-ui-kit.ts`, all KEEP) into an island widget host BEFORE deleting `SurfaceFrame`.** This is B's foundational task; deleting SurfaceFrame first kills the entire widget pipeline.
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
- **Surfaces (pending the web decision):** `BrowserNav.tsx`, `WebTabView.tsx`. `SurfaceFrame.tsx` is **extract-then-cut** (it holds the widget host — see review finding 1), not a plain delete.
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
4. **Resolve the web decision**; **extract the widget host from `SurfaceFrame`** (finding 1), then cut `WebTabView`/`BrowserNav` + `SurfaceFrame`.
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
