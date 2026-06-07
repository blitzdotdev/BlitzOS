# BlitzOS — Working Stream

**My working notes — agent self-continuity, not a handoff doc.** For *me* to keep state across context compactions: current state, decisions + rationale, exact contracts, open threads, next actions, and the commands I use. Terse + operational + dense on purpose. I update it as I work and re-read it on resume. Last touched 2026-06-07.

---

## TL;DR — where I am

BlitzOS / "Agent OS" = an Electron macOS infinite-canvas spatial desktop of **surfaces** an AI agent drives; also runs as **server mode** (headless Chromium per web surface, streamed to a canvas, CDP-controlled — the VPS/hosted path). Live at **https://agentos.blitzmen.com**. **Core principle (2026-06-05 directive): BlitzOS is PURE SUBSTRATE — perception (sensors→moments→`/events`) + the tool surface + transports. The connected agent makes ALL decisions; BlitzOS never judges significance or chooses actions. No in-OS brain/governor.**

**Session arc (on `master`; user pushes from their machine, no SSH key here):** widget system (`52830bc`) → merged teammate autonomy kernel (`4781b47`) → dynamic-OS architecture doc (`8869776`) → P0 privacy gate (`f306423`) → P1 resident brain (`8e9e576`, later NUKED) → P5 server autonomy parity (`281eb21`) → nav-desync fix (`61b9d8a`) → in-canvas Chat + `say` (`c61cfca`) → **nuked the in-OS brain → pure substrate** (`1c1392c`) → professions catalog (`d995374`) → **agent-runner** (`59b2b84`+`b3b4bc9`) → **window-management perception** (`c0b90b0`) → chat pinned (`8d059cb`) → agent-opened pages readable + activity-log + chat scroll/resize (`ccbf471`) → **persistent server browser profile** (`9867ff8`) + Discord on-unload flush (`83cda05`) → merged teammate `agent-runtime-moments` again (journal + persistence.ts + unified blitzos-agents.md + select-signal) (`d253a6e`) → **WORKSPACES persistence design + Phases 0–3 + 2 adversarial reviews + cleanup** (`5d4b6c1`…`5c83128`) → relay `/events` wait:0 fix (`09c121f`). Demo self-supervises via `BLITZ_AGENT=claude bash preview/start-all.sh`.

**LATEST (the big recent work, 2026-06-06): WORKSPACES — folder-backed persistence/serialization. Phases 0–3 BUILT + reviewed (twice) + cleaned, all e2e-verified.** A workspace = a folder on disk; one `.blitzos/workspace.json` = layout; everything-is-a-file content; persist on push, hydrate on boot/connect, reconcile on external edit (the agent edits files directly → canvas updates live). **See the "Workspaces" section below + `agent-os-workspaces.md`.** `origin/master` last seen at `51edf06`; HEAD `09c121f` (ahead ~2: hydrate-review fold + wait fix). Window-management (`c0b90b0`) earlier work: `list_state` returns `viewport`/`view`/`z`/`mode`; AGENTS_MD + brain prompt carry the layout discipline; Chat + Activity panels pinned always-on-top.

## Post-merge UI cluster — FIXED + verified (2026-06-07)

User listed 6 post-merge UI bugs ("fix them systematically"). Resolved + headless-verified in the merged renderer (Connect AI hud shows the URL; chat marker survives a reload):
- **Fonts inconsistent** → `<button>`/`input`/`textarea`/`select` don't inherit `--font-ui` by default. Added a global `{ font: inherit }` to `styles.css` (after the html/body reset). Root cause: only `body` set the font; controls fell back to the UA font (ws-btn looked different).
- **Traffic-light 3-dots rendered as flat lines** → native `<button>` appearance overrides the custom circle on macOS/Safari. Added global `button { appearance: none; -webkit-appearance: none }`. `--control-active` (#5a5c60) was fine — NOT a missing token.
- **Resize distorts the stream** (= audit major #4) → `browser-host.mjs` gains `resize(id,w,h)` (debounced 140ms: `setDeviceMetricsOverride` + stop/start screencast at the new size); `surfaces.set` now stores `{width,height,quality}`; `backend.mjs reconcileSurfaces` calls `host.resize` for EXISTING web surfaces (no-ops when unchanged). Fixes both the stretch AND post-resize click-mismapping (shim `toPage` uses `canvas.width/rect.width`).
- **Missing bars / Connect AI does nothing / (and earlier) chat empty** → all STALE-VITE mid-merge artifacts, NOT code bugs. Clean `start-all.sh` restart fixes them. Verified: toolbar renders all 4 buttons; Connect AI hud shows the agent URL; chat round-trips.
- **Chat history persists on refresh** → already works (push carries `props:s.props` → `osState`; SSE-connect hydrate sends `osState.surfaces`; `store.hydrate` keeps props via `...w`). **CAVEAT (honest):** persists across a PAGE REFRESH (backend up) but NOT across a BACKEND RESTART — chat/activity are runtime panels, not workspace files, so a fresh boot reads `readWorkspace` (no chat). To survive restarts: persist runtime panels to `.blitzos/state/panels.json` (agent-read-denied) + merge on boot. NOT yet done — offered.

## GOAL (user-set 2026-06-07) — finish the whole backlog, systematically, track here

**Standing goal:** complete ALL discussed items one-by-one, keep this file + the task list updated, and fix every current/future reported bug as part of the goal. Task IDs #26–40 (see `TaskList`). Ultracode ON → adversarial subagent review of each chunk.

**Backlog (ordered):** Chunk 1 bug fixes (#26 overscroll, #27 chat-select, #28 eye, #30 blue indicator) → #31 primary 1080p → #32 control-mode model → #33 drag-cards-in-control → #34 snapping → #35 fullscreen→primary → #29 titlebar-disappears (folds into #32) → #36 agent MD → #37 files/folders-on-canvas → #38 chat-survives-restart → #39 dynamic-OS boot → #40 review. Then (future) multiple workspace areas.

**STATUS 2026-06-07 — ALL 18 TASKS BUILT (#26–42).** Commits (push pending): 189dd65, 0fe4d0b, f241f12, 638e20e, 51b1c85, 9760dae, bf03fdb, 2036cdd, 8628070, 820d435, 403af57, 9847d58 (+ the earlier 7d73073/5745dc7). Per-chunk adversarial reviews done + fixes folded for chunks 2/3/5; final reviews RUNNING: #37 files security (wg7nyjlsy), #40 gaps+integration (wcqczj9xi). On their return: fold any confirmed fixes → goal complete. #39 is agent-instruction-only (substrate principle); the live brain assembles the desktop. v2 follow-ups noted in files-folders-on-canvas.md + per-feature NOTES above (OS drag-drop, .app folders, Electron blitz-file://, multiple workspace areas).

### Spatial-model redesign (the crux — design locked from user's detailed spec)
- **Two modes of ONE app, both transports.** `store.mode`: `desktop` = **normal** (view LOCKED to the primary area, windows behave like a real OS desktop), `canvas` = **"Control mode"** (bird's-eye, own viewport, pan/zoom, drag cards but DON'T interact with content). Today server/Chrome force `canvas` on mount (App.tsx:64) — REMOVE that; default both transports to `desktop`, toggle into control mode.
- **Toggle:** double-tap ⌘ in BOTH transports (browser keydown 'Meta' works too; the existing double-⌘ → `panMode` becomes the mode toggle). Animate the `transform` on enter (→ control bird's-eye) and exit (→ snap back to the workspace area). The `.pan-overlay`/`.pan-hint` is the control-mode indicator.
- **Primary area = the on-screen desktop region** (dynamic `primaryRect(viewport)` in world coords; at scale 1 it's the same size as the screen — user refinement 2026-06-07, NOT a fixed 1080p rect). Normal mode = scale 1 (windows render at NATURAL size); control mode = scale 0.62 bird's-eye. Windows clamp to the primary rect so a title bar can't slide under the top titlebar (= #29 fix). (`PRIMARY_W/H` were DELETED in the review-fix pass — all consumers moved to `primaryRect`; mission-control cells hardcode their own aspect in CSS.)
- **Snapping (#34):** dragging a window in/near the primary area snaps to full / left-half / right-half (+ quarters) of the PRIMARY AREA, with a preview overlay.
- **Full-screen (#35):** the green traffic light fills the PRIMARY AREA rect (not the viewport — `toggleMaximize` currently uses the viewport, wrong in control mode).
- **Areas = macOS desktops.** Only `primary` now; more later (post-backlog). Agent told (#36) to keep surfaces inside workspace areas + save persistent memory as files in the workspace folder (instruction only; memory not engineered).

### Chunk 1 — DONE (2026-06-07, build+typecheck pass)
- #26 overscroll: `overscroll-behavior:none` on html/body/#root (kills Mac two-finger back/forward while panning).
- #27 chat-select: `userSelect:text` on the ChatPanel message area (body sets `user-select:none`).
- #28 eye button: removed the duplicate `.window-ico` rule (merge leftover); not-shared eye now `--text-secondary`/opacity .85 (was .45), shared stays green.
- #30 control-mode indicator: `.pan-overlay` z 4000→5500 (above titlebar 5000), border 2px→3px @70%, `.pan-hint` top 14→44px (below the titlebar).

### Chunk 2 — DONE (2026-06-07, build+typecheck+headless verified)
Control-mode redesign (#31 #32 #33 #35 #29). Headless test confirmed the toggle: default `scale(1)`/no frame → double-⌘ → `scale(0.62)` + PRIMARY frame + indicator → double-⌘ → back.
- store: `primaryRect(vp)` (screen-sized area), `viewTransform(mode,vp)` (desktop=scale 1 centered, control=0.62), `setTransform`, `desktopClamp`→clamp to primaryRect (vp param), `toggleMaximize`→fill primaryRect (#35), `goToPrimary`/`hydrate`→viewTransform. Dropped PRIMARY_W/H import.
- App: removed the force-canvas effect (server/Chrome now boot the normal desktop too); double-⌘ → `toggleControlMode()` in BOTH transports with an `animateTransform` rAF tween; hydrate/switch force `desktop` (control mode = transient, never persisted); the indicator renders in control mode (pointer-events:none); PrimarySpace is control-only.
- SurfaceFrame: `.drag-overlay.control` (top:0 + active) in control mode → the whole card is a drag handle, content non-interactive (#33).
- PrimarySpace + capture.ts now use the dynamic `primaryRect(viewport)`.
- #29 titlebar-disappears FIXED as a side effect: normal mode is the default + clamps windows inside the primary rect (its top maps to screen y≈32, just below the titlebar).
- **NOTE for review:** snapping (#34) NOT yet done; control-mode drag has no clamp (free placement, intended). `/code-review` pass requested after each commit (running a multi-agent review; the billed cloud `/code-review ultra` is user-triggered).
- **Chunk-2 review DONE (16 agents, 13 raised):** 3 real issues FIXED in the follow-up commit — (1) dead `PRIMARY_W/H` deleted (all consumers on `primaryRect`), (2) `onResize` now re-fits the camera in BOTH modes (control-mode drift), (3) stale `capture.ts` "fixed 1440x900" header comment corrected. 2 nits DEFERRED (documented): push leaks the transient `mode:'canvas'` into persisted workspace.json (harmless — hydrate always forces `desktop`); dock-click `focusAndZoom` in control mode zooms to a surface instead of holding the 0.62 bird's-eye (contested — control mode is a free pan/zoom plane, recoverable via Center/Cmd+0). Dismissed (intended): control-mode ~1.4% off-center (pure-scale tween about the area center), cards non-interactive incl. traffic lights (Mission-Control by design), persisted camera unused branch (dormant scaffolding).

### Chunk 3 — DONE (#34 window snapping, 2026-06-07, headless-verified)
Normal-mode edge snapping relative to the PRIMARY AREA. Headless test: drag a note's title bar to the left edge → left-half preview (left:-682, w:682 for a 1440×900 vp) → release → snaps to the left half at full primary height (804). Exact match.
- store: `snapTargetFor(wx,wy,vp)` — full at the top edge, left/right halves at the side edges, quarters at corners (thresholds 6% of the area); + `snapPreview` state + `setSnapPreview`.
- SurfaceFrame: onBarMove sets the preview (desktop mode, single-window drag, not over a folder); onBarUp applies it (a folder drop wins over a snap).
- App: renders `.snap-preview` in the world layer; CSS = translucent accent rect, z 1.5M (above windows, below the pinned chat/activity band), glides between zones.

### Chunk 4 — DONE (#38 chat/activity survive a backend restart, 2026-06-07, round-trip verified)
Runtime panels (chat/activity) persist to `.blitzos/state/panels.json` and merge back on boot (Phase-4 design that nodeKind always pointed at).
- workspace.mjs: `writeRuntimePanels(dir,panels)` (internal — called at the end of writeWorkspace; slims chat→props.messages, activity→props.events) + `readRuntimePanels(dir)` (export). The empty-canvas early-return now also keeps a chat-only workspace. `.blitzos/state` isn't watched (non-recursive watch on `.blitzos`) → no self-write loop.
- workspace-host.mjs: `hydrateOnBoot` merges `readRuntimePanels` into the boot surfaces (nodes + panels). reconcile/switch keep carrying the LIVE panels (unchanged) so the chat follows across switches.
- Verified (node round-trip): chat (2 msgs) + activity (1 event) → state; note stays a node; messages survive the re-read. Chat history now survives a backend RESTART, not just a page refresh.

### NEW user requests (2026-06-07) → #41 #42
- #42: snapping should work in CONTROL mode too (remove the desktop-only gate in SurfaceFrame onBarMove/onBarUp).
- #41: macOS-style resize from ALL sides + corners (8 handles, edges move the opposite side's position), and it must work in control mode (handles above the drag-overlay; traffic lights/eye stay clickable via higher z).

### Chunk 5 — DONE (#41 resize + #42 control-snap + snapping-review fixes, 2026-06-07, headless-verified)
- #41 macOS-style resize from all 8 sides/corners. SurfaceFrame: 8 `.rsz-*` handles (z4, above the drag-overlay → works in control mode), generalized `onResizeDown(e,dir)`/`onResizeMove` (a side moves the opposite edge's position; MIN 160×120 with the far edge anchored). Verified: E +100 → w+100/x-same; W −80 → x−80/w+80. Top handles clear the traffic lights (left) + eye (right). Dropped the now-unused `resizeSurface` hook.
- #42 snapping now works in BOTH modes (removed the desktop-only gate in onBarMove/onBarUp). Verified in control mode (scale 0.62): drag to the area's left edge → left-half preview + snap (x:-682, w:682, h:804).
- Snapping-review (chunk-3, 10 agents) fixes folded in: (1) snap apply clears `restore` (stale green-zoom jump); (2) `onPointerCancel→onBarUp` on the bar + drag-overlay + resize handles (snap/drag teardown on capture loss); (3) integer split points in `snapTargetFor` (no 1px seam on odd widths); (4) `toggleControlMode` clears snapPreview+dragTarget (mode switch mid-drag). Dismissed: pinned-panel snapping (acceptable), onBarUp isFolder re-check (move already nulls it).
- Chunk-5 review (12 agents) fixes (commit 820d435): MAJOR — resize was unclamped (N/W handles dragged a title bar under the top titlebar); onResizeMove now clamps to primaryRect in normal mode. Widened edge handles 5→8px (were ~3px at 0.62 scale). Removed the dead `resizeSurface` store action.

### Chunk 6 — DONE (#37 files & folders on the canvas, 2026-06-07, e2e-verified)
Real workspace-folder files + subfolders appear as canvas tiles, LIVE. Design: `plans/files-folders-on-canvas.md`.
- Backend (workspace.mjs, commit 8628070): `autoKind` surfaces ALL files (.html→srcdoc, else→'file') + 'dir' for subfolders; `nodeToSurface` materializes file/dir (stat only — never reads binaries); `writeWorkspace` records file/dir nodes LAYOUT-ONLY (never rewrites content); `reconcile` surfaces loose files + subfolders; the rename-heal skips file/dir. Round-trip verified.
- Renderer (commit pending): `FileWidget` (image preview via the file route / typed glyph + name + size; onError→glyph) + `DirWidget` (folder tile + entry count), wired into SurfaceFrame's native switch; CSS `.file-tile`/`.dir-tile`.
- File bytes: `GET /api/os/file?path=` — JAILED to the active workspace dir (no traversal, no `.blitzos`, 25MB cap). Verified: serves `image/png` 200; `../../etc/passwd` → 403.
- **Live update:** reconcile now broadcasts `type:'reconcile'` (was `'hydrate'`, which the first-hydrate-wins guard ignored → external edits only showed on reload). New store `applyReconcile` merges the file-backed surfaces, KEEPING the camera + the live chat/activity panels. Verified e2e: drop png+pdf+folder → 2 file tiles + 1 dir tile appear with the image rendered, NO reload.
- **Deferred to v2** (in the design doc): OS drag-drop IN; folder drill-in/open; the `.app`-like canvas-subitem folder; the Electron `blitz-file://` protocol (server route works; Electron image preview needs it).

### Chunk 7 — review fixes (#37 + #40 reviews, 2026-06-07, verified) — commit 55d770e
Two final reviews (#37 files-security `wg7nyjlsy` 18 agents, #40 gaps+integration `wcqczj9xi` 16 agents) found a BLOCKER + several majors; all fixed + re-verified.
- **SECURITY (file route, public tunnel):** BLOCKER symlink-escape → `realpathSync(root)` + `realpathSync(target)` + containment re-check (symlink→/etc/passwd = 403, curl-verified); `sameSiteOnly` gate; SVG/HTML → `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` (no stored-XSS); raster images stay inline.
- **#38 chat:** MAJOR a >1MB chat wrote fine but the reader rejected it → `slimByBudget` bounds the transcript on WRITE (2MB→595KB file, 59 recent msgs restored — verified). MAJOR switching overwrote the destination's saved chat → `performSwitch` loads the DESTINATION's own panels (per-workspace chat; flush already saved the source's). Activity default size; markWrite the state dir (no spurious reconcile).
- **#37 reconcile data-loss (MAJORs):** `applyReconcile` wholesale-replace dropped agent-created/in-flight surfaces + destroyed iPhone-folder groupings → `reconcileWorkspace` returns `knownIds`; the HOST now keeps runtime panels + folder groupings + genuinely-un-persisted surfaces (id ∉ knownIds ∧ ∉ reconciled) while still dropping DELETED files, and re-applies `groupId`. Verified reconcile still surfaces drops.
- **Misc:** Notepad ensured in server mode too (the brain's transport); file/dir tiles excluded from snapping + their futile close/min lights hidden; FileWidget image cache-buster + honest `blitz-file://` comment; #39 weather example corrected (srcdoc has no network → web window); brain assembles only if empty/sparse.
- **KNOWN RESIDUAL (documented):** an in-flight UNSAVED note edit during a CONCURRENT external reconcile has a ~500ms loss window (the host merge fixes the agent-created/folder cases; a full fix needs per-file versioning — flush-before-reconcile was rejected because it would un-delete externally-removed files). Electron `blitz-file://` image previews fall back to the glyph until the protocol is registered (server route works).

**GOAL RE-OPENED 2026-06-07 — I WRONGLY marked it complete.** The user tried dropping a file; it did nothing because I'd built only the folder→canvas reconcile path and DEFERRED the actual OS drag-drop. Lesson: no "v2 follow-up" deferring, and nothing is "done" without PROOF.
- **DONE + PROVEN this round (no longer deferred):** #43 OS drag-drop (drop a file → written to the workspace folder → tile at the drop position, image rendered — headless DataTransfer+drop proof); #44 folder tiles OPEN (double-click → DirOverlay lists contents + image thumbs + drill into subfolders — proven); #47 reconcile no longer clobbers the surface you're actively editing (editingId; proven). #46 Electron `blitz-file://` image previews registered (build-verified; Mac runtime pending — no display here). Commits d37dbaa · 0609d4a · bbd4515 · abc3f3d.
- **#48 PROVEN (2026-06-07):** booted the brain on an EMPTY workspace → within ~135s it assembled a desktop FROM the user's context — spawned a Discord widget (their connected account → consent prompt), created the Agent-activity panel, updated its Notepad memory. So the dynamic-OS boot genuinely works (the claude -p brain is slow + self-restarts every ~5–8 min — a known reliability limit — but it DOES assemble from context).
- **STILL OPEN:** #45 multiple workspace areas (the user's flagged next-big-thing). A transcript-audit workflow (subagents, the user's ask) is still synthesizing (many asks → many verify agents) → its findings become tasks. Do NOT call the goal done until every item is built AND proven.

## Workspaces — folder-backed persistence/serialization (Phases 0–3 DONE + reviewed, 2026-06-06)

**Spec:** `agent-os-workspaces.md` (synthesized from a 14-agent brainstorm; §10 KEEP/REWRITE/REMOVE, §11 build order, §12 open decisions). **Model:** a workspace = a FOLDER on disk; ONE `.blitzos/workspace.json` holds layout `{version,id,kind,camera,mode,stack,nodes[]}`; everything-is-a-file content (note→`.md`, web/app→`.weblink {url}`, srcdoc→`.html`); BlitzOS owns layout, content files own content. **Two big reversals from the chat's earlier ideas (the brainstorm overruled, user OK'd):** ONE central workspace.json (NOT per-item sidecar metas) + one-way layout authority with editor-style content reload (NOT three-way merge). `.group` cut from v1; secrets NEVER in the folder. Consent-persist = YES (decided), lands Phase 4 in agent-read-denied `.blitzos/state/consent.json`.

**Code — `src/main/workspace.mjs` (+`.d.mts`)**: shared serializer (control-core/perception-core pattern), plain Node, imported by `preview/backend.mjs`; Electron-main later.
- `writeWorkspace(dir, osState)` — canvas→folder. `writeMeta` (atomic temp+rename + keeps `workspace.json.bak`); content via `writeIfChanged`. Dedupes ids, skips blank ids, ext-checks path reuse, reserves BLITZOS.md/.gitignore, stack from kept nodes by z, skips empty-when-no-prior. `safeJoin` jail; `markWrite` stamps for self-write suppression; scaffolds BLITZOS.md + .gitignore once. `nodeKind` folds app→web; `slug` NFKD-folds accents; `viewFor` persists `title` (note/srcdoc) / `lastTitle` (web) + caps srcdoc props 8KB.
- `readWorkspace(dir)` — hydrate. `nodeToSurface` = jailed read (safeJoin) + size-cap (2MB) + url scheme-filter (`safeUrl` http(s) only) + title from `view.title`. `.bak` fallback on corrupt; z seeded above stack; `safeCamera` clamps scale 0.2–3 / finite.
- `reconcileWorkspace(dir,{cx,cy})` — idempotent re-scan: reload content, auto-place new `.md`/`.weblink` (`autoKind`), single-rename heal, drop missing, writeMeta only if changed.
- `wasSelfWrite(absPath)` — 900ms window so the watcher ignores our own writes.

**Backend (`preview/backend.mjs`)**: `WORKSPACE_DIR` = `BLITZ_WORKSPACE` || `preview/.workspace/Home` (gitignored). Boot: `readWorkspace`→osState + reconcileSurfaces. SSE connect → sends `{type:'hydrate',surfaces,camera,mode}`. `/api/os/state` POST → osState + `scheduleWorkspaceWrite` (trailing 500ms debounce → `flushWorkspace`). `startWorkspaceWatch` = fs.watch(root + .blitzos), 250ms-coalesced, self-write-skipped → `scheduleReconcile` → reconcile → **merge runtime chat/activity panels** (they're not files) → broadcast hydrate. `gracefulExit` flushes pending write. `list_state` trimmed to layout fields. `/events` honors explicit `wait:0` (`09c121f`).

**Renderer (`App.tsx`/`store.ts`/`preload`)**: push carries `html,props,zoom,camera` (camera = world-center `{view.cx,view.cy,scale}`, viewport-independent); chat capped `slice(-200)`. `store.hydrate()` replaces surfaces + computes transform from world-center+viewport (clamped scale) + lifts zCounter + clears layoutHistory. onAction `'hydrate'` = **FIRST-hydrate-wins** (`if (hydrated.current) return` — an SSE reconnect can't clobber the live canvas). Push gated on `hydrated.current`; the 1.5s fallback is **Electron-only** (server always hydrates on connect) + only pushes a non-empty store.

**Verified:** every phase e2e in server mode (create→folder materializes; restart→canvas restores via list_state + renderer DOM; external `.md` edit→note updates live; new `.md`→auto-placed). Two adversarial reviews folded + re-verified: Phase-1 (16 findings, `5c3845c`), hydrate/round-trip (9 findings, `5c83128`). Dead-code sweep + wait fix. **Gotcha:** NoteWidget text is a `<textarea>.value`, NOT innerText (a DOM check must read `.value`).

**Workspaces NEXT (NOT started):** (1) **journal re-root** — `journal.mjs` ROOT → active workspace; delete `shFs`; realpath jail; expose relay `workspace_read/write/list/mv` verbs + rewrite `blitzos-agents.md`/`BLITZOS.md` to teach the folder model (so relay agents get file-memory). (2) **Phase 4 security** — `app` iframe drop `allow-same-origin` (`SurfaceFrame`); `.blitzos/state` agent-read-deny; snapshot allow-list; full realpath jail; consent-persist in `state/`. (3) **Phase 5 Electron hydrate parity** — `osActions` has NO hydrate/write path yet (code-only, untestable headless). Note: the demo's relay brain is remote → uses tools, NOT direct file edits; the file-peer-editor path is for co-located/Electron agents + the (pending) relay `workspace_*` verbs.

## Run it

```bash
cd packages/BlitzOS
bash preview/start-all.sh            # restart (clean) — live at https://agentos.blitzmen.com
bash preview/start-all.sh stop       # kills everything incl. headless Chromium
bash preview/start-all.sh status
```
Server mode default (`BLITZ_SERVER_MODE=1`, Chromium auto-detected at `/usr/bin/chromium`). Backend **:8799** (NOT 8787 — wrangler's default; the other agent runs the relay there). Vite :5174. Hard-refresh the tab after restart (shim is page-cached → re-mints the agent URL). Recipe + one-time tunnel setup: `preview/RUNNING.md`.

## Three run modes

1. **Electron desktop** — the real app (`npm run dev`, macOS only). `src/main/*` + React renderer. Can't run here (needs a display).
2. **Browser preview** — Vite renderer + Node backend (`preview/`) + cloudflared tunnel. Web surfaces = empty frames (no `<webview>` in a browser).
3. **Server mode** (NEW) — each `web` surface is a **server-side headless Chromium** top-level target (bypasses X-Frame-Options), streamed to a `<canvas>` via CDP `Page.startScreencast`, controlled via the shared CDP vocabulary. The VPS-deployable path. **Fully testable here** (headless Chromium, no display needed).

## Decisions log (so I don't relitigate)

- **CDP (`webContents.debugger` / raw CDP), not `WebContentsView`, for web surfaces.** Verified: CDP is the only mechanism with trusted input (`isTrusted`), no same-origin requirement, AND off-screen reach. `WebContentsView` is a native overlay positioned by `setBounds` → can't honor the `#world` CSS transform → breaks the canvas. (`<webview>` stays for Electron; server uses a streamed `<canvas>`.)
- **Server mode = top-level Chromium target per web surface.** A `Target.createTarget(url)` is an address-bar navigation, so framing headers (X-Frame-Options / frame-ancestors) never apply — recovers exactly what the plain-browser iframe/webview path can't do. JPEG screencast ~4–12 fps (paint-gated); fine for forms/reading/agent-watching, not smooth video.
- **Widgets = `srcdoc` + a bridge, NOT compiled `native` React.** An agent must be able to read/fork/author widgets at runtime → they must be source (HTML/JS), which only `srcdoc` gives. `native` (compiled React) stays only for built-in chrome primitives (note). See "Widget system" below.
- **`claude-mono`** (`claude-mono (1).md`, gitignored) = a broader cloud-SaaS "run a whole startup with AI employees" vision. **Parked** ("ignore Claude Mono"). Different deployment model than BlitzOS (local/desktop); shares the integrations + agent-as-operator thesis only.
- **agent-socket** is the user's own relay project (separate repo `packages/agent-socket`, github `blitzdotdev`). BlitzOS is one consumer. The other agent owns agent-socket now.

## Architecture + key files

- **Surface model** — `src/renderer/src/components/SurfaceFrame.tsx`, `store.ts`. Kinds: `web` (Electron `<webview>` / server `<canvas>`), `app` (`<iframe>` first-party, same-origin), `srcdoc` (sandboxed iframe of agent-authored HTML — no network/same-origin), `native` (React component by name, e.g. `note`/`NoteWidget`). Store `mode` ('desktop'|'canvas'); preview forces `canvas` (App.tsx effect: `if serverMode setMode('canvas')`). Descriptor: `{id, kind, x, y, w, h, z, title, url?, html?, component?, props?}`.
- **Shared control core** — `src/main/control-core.mjs` (+ `.d.mts`): transport-agnostic CDP vocabulary over a `{send(method,params)=>Promise}` session. Functions: `evaluate, dispatchClick, clickSelector, KEYMAP/pressKey, typeText(perKey), read, screenshot`, and `controlSession(session, action)` returning `{ok,result?}|{ok:false,error}`. Electron adapter = `cdp.ts` `ElectronCdpSession` (wraps `webContents.debugger.sendCommand` + lazy attach/idle-detach). Server adapter = `browser-host.mjs` `session(id)` (CDP over the DevTools WS).
- **Server mode files** — `preview/backend.mjs` (`BLITZ_SERVER_MODE`): HTTP + SSE `/api/os/events` (agent actions to renderer) + `/api/os/stream` WS (screencast frames out, input in) + OAuth + agent-socket session + `reconcileSurfaces`. `preview/browser-host.mjs` (headless Chromium + CDP-over-WS). `preview/agentos-shim.js` (browser `window.agentOS`). `vite.renderer.preview.mjs` (injects `__BLITZ_SERVER_MODE__`, proxies `/api` with `ws:true`, target `:${BACKEND_PORT||8799}`).
- **Agent transport** — agent-socket relay (paste a URL into any chat, no MCP). Tools in `agentSocket.ts` (Electron) + `backend.mjs` OS bridge (server). Backend's `OS_AGENTS_MD` ships the calling-instructions preamble (the relay also prepends one now).

## Tool contracts (the 9 agent-socket tools)

All POST `$BASE/<tool>` (JSON body). `$BASE` = paste-URL minus `/agents.md`.
- `create_surface {kind, x?,y?,w?,h?,title?, url?(web/app), html?(srcdoc), component?,props?(native)}` → `{id}`. Server mode: web kind also creates the host target directly.
- `open_window {url, x?,y?,w?,h?,title?}` → `{id}` (web shortcut; server creates target).
- `move_surface {id, x, y}` → `{ok}`.
- `update_surface {id, html?,props?,url?,title?,x?,y?,w?,h?}` → `{ok}` (broadcasts `os:action {type:'update', patch}`; server navigates the host target on `url` change).
- `close_surface {id}` → `{ok}` (server closes the host target + disposes context).
- `go_to_primary` → `{ok}`.
- `list_state` → `osState` (`{surfaces:[{id,kind,x,y,w,h,title,url}]}`, pushed by the renderer via `sendState`).
- `read_window {id}` → `{result:{title,url,text}}` — **safe DOM read only** (the `script` param was REMOVED — it was an eval bypass; see audit).
- `surface_control {id, action:{action:'click'|'type'|'key'|'read'|'screenshot', selector?,x?,y?,text?,perKey?,key?}}` → web surfaces only; server mode. **`eval` action is rejected over the relay** (localhost-bearer only).

SDK handler return shape gotcha: a return with no numeric `status` is wrapped as HTTP 200 → map failures to `{status:4xx, body:{error}}`; success returns `{result}`/`{image}`/`{text}`/`{ok}`.

## `window.agentOS` surface (shim ↔ preload parity — keep in sync!)

The renderer calls these; the browser shim (`agentos-shim.js`) MUST mirror the Electron preload (`src/preload/index.ts`) or the renderer crashes (that's the onMetaTap bug). Required methods: `serverMode`(bool), `mountServerSurface`, `serverNavigate`, `serverReload`, `onAction`, `sendState`, `onAgentSocketUrl`, `registerWebview`, `unregisterWebview`, `reportWebview`(electron-only→shim no-op), `onMetaTap`(electron-only→shim no-op returning unsub), `integrations.{list,connect,disconnect,openExternal,onUpdated}`. **When the teammate adds a preload method, add a shim equivalent.** `mountServerSurface(canvas, surfaceId)` opens the stream WS, draws JPEG frames, forwards pointer/wheel/key as CDP (`Input.*`), `stopPropagation` so it doesn't pan the canvas.

## browser-host.mjs internals (the audit majors live here)

- `CdpClient(wsUrl)`: `send(method,params,sessionId?)` id-correlated via a `pending` Map; `onEvent(cb)`; `_msg` routes replies by id, events to handlers. **Only `once('open')/once('error')` — no persistent close/error drain (audit major #2).**
- `startBrowserHost({onFrame, chromiumPath})`: spawns chromium (`--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=0 --user-data-dir=<mkdtemp blitz-chrome-*>`), parses stderr for the `ws://…` DevTools URL, connects `CdpClient`. On `Page.screencastFrame`: **ack first** (`Page.screencastFrameAck`) then `onFrame(surfaceId, base64jpeg, metadata)`. **`child.on('exit')` only inside the startup promise — no supervisor (major #3).**
- Returns: `createSurface(id,{url,width,height,quality})` = `Target.createBrowserContext` → `createTarget` → `attachToTarget({flatten:true})` → `Page.enable` → `Page.startScreencast({format:jpeg,quality,maxWidth,maxHeight})`. **`surfaces.set` runs after 3 awaits → `has()` false during creation → race + leak (major #1); no try/catch → partial-failure leak (major #5).** `closeSurface(id)` = `closeTarget` + `disposeBrowserContext`. `session(id)` → `{send:(m,p)=>client.send(m,p,sessionId)}`. `has/ids/navigate(id,url)/stop()`.

## Integrations data (for widgets)

Tokens: `preview/.tokens.json` (gitignored). Shape `{provider:{provider,label,secrets:{access_token,...},connectedAt}}`. Read token = `rec.secrets.access_token`. **Connected:** discord (palash, **65 guilds** verified), gmail, github, jira (slack not configured).
- discord guilds: `GET https://discord.com/api/v10/users/@me/guilds` (Bearer) → `[{id,name,icon,owner,...}]`; icon URL `https://cdn.discordapp.com/icons/{id}/{icon}.png`.
- github repos: `GET https://api.github.com/user/repos?sort=updated` (needs `User-Agent`).
- gmail/jira: more API shape work (gmail messages = list+get; jira needs `cloudId`+`siteUrl` from `secrets`).
- **NOTE:** I designed a `GET /api/integrations/:provider/:resource` route + a `PROVIDER_DATA` registry but did NOT add it (pivoted to the bridge after the alignment chat). Build it as the bridge's data backend.

## Widget system — BUILT (full loop verified in a real browser, 2026-06-05)

**The "agent OS" thesis, working:** agents browse a library, read/fork widget source, spawn them, OR author new ones at runtime — all backed by the user's connected integrations, over a consent-gated bridge. Verified e2e (headless Chromium + real relay): spawn discord-servers → consent overlay → Allow → 73 real Discord guilds render in the sandbox; author via save_widget → appears in library; code-swap re-prompts consent.

**Pieces (all built):**
1. **Shared catalog** `src/main/widget-catalog.mjs` (+`.d.mts`) — ONE source of truth for BOTH transports (mirrors control-core.mjs). `listWidgets/getWidgetSource/saveWidget`, the **closed** `PROVIDER_DATA` registry (`discord/guilds`, `github/repos`) + `fetchProviderResource(provider,resource,token)` (10s timeout, 5MB cap, own-property guard), and `WIDGET_AUTHORING_MD`.
2. **Library** `widgets/` — `widgets.json` manifest + `discord-servers.html` + `github-repos.html` (builtin, tracked). Authored widgets → `widgets/authored/` (gitignored). Each uses `window.blitz`.
3. **Bridge** `src/renderer/src/widget-bridge.ts` (`BRIDGE_SHIM`, the injected `window.blitz`: `data/tool/props/onProps/ready`, per-instance nonce reqId) + `SurfaceFrame.tsx` srcdoc branch (ref + shim-injected srcDoc + `onLoad` init + `window 'message'` listener authenticated by **`event.source===iframe.contentWindow`**). Consent overlay + per-generation local consent gate.
4. **Data + consent (server)** `preview/backend.mjs` — `GET /api/integrations/:provider/:resource?surface=ID` (closed registry, **consent-gated per (surface,provider)**, rate-limited), `POST /api/os/consent`, `POST /api/os/consent/revoke`, `GET /api/widget-authoring.md`. Consent pruned on close + revoked on code-swap.
5. **Tools (both transports)** — `list_widgets, get_widget_source, spawn_widget, save_widget, list_integrations, get_widget_authoring`. Server in `backend.mjs`; Electron in `agentSocket.ts` (+`widgets.ts` ipc `widget:req/consent/consent:revoke` via tokenStore Keychain, `dropConsent` from osActions on close). OS_AGENTS_MD + AGENTS_MD have a `## Widgets` section.

**Security model (post-review, 8 findings fixed):** token NEVER crosses into the widget (only normalized `{items}`). **srcdoc surface ids are server-minted** (agent can't pick one to inherit a grant). Consent is keyed `(surfaceId,provider)`, **revoked when html changes** (renderer clears a per-generation `consented` set → new code re-prompts; deterministic, not race-dependent) and **pruned on close**. Bridge replies are **window-checked** (`postRes` only delivers to the issuing `contentWindow`) so a reload can't cross-deliver. Closed `PROVIDER_DATA` (own-property lookup) = no SSRF. Rate-limited + size-capped + timed-out fetches.

**Not yet done (widget follow-ups):** generic consent-gated `op:'fetch'` escape-hatch so an authored widget can hit a NOT-yet-registered provider/resource without a backend edit (today PROVIDER_DATA is the closed allowlist — discord/guilds, github/repos only); a CSP on the srcdoc iframe to block data egress (defense-in-depth; deferred — the data is already user-consented); more provider resources (gmail messages, jira issues).

## Verify commands I use (re-runnable)

- **Status/up:** `bash preview/start-all.sh status`; `curl -s -o /dev/null -w '%{http_code}' https://agentos.blitzmen.com/`.
- **Get the live paste URL:** `curl -s http://127.0.0.1:8799/api/os/agent-url` → `{url}`; `$BASE = url - /agents.md`.
- **Server-mode e2e (relay):** node script — `open_window {url:example.com}` → `read_window {id}` (expect "Example Domain") → `surface_control {id,action:{action:'screenshot'}}` → `update_surface {id,url:news.ycombinator.com}` → `read_window` ("Hacker News") → `close_surface`. (Poll `/api/os/agent-url` in-process with `setTimeout` — the agent URL mints a few s after backend start; shell loops without sleep spin uselessly.)
- **Blocker re-check:** `read_window {id, script:'(document.title="PWNED")'}` must return the normal title (script ignored); stream WS `{t:'cdp',id,method:'Runtime.evaluate',...}` must NOT change the page; `{method:'Page.navigate'}` must work.
- **Renderer render check:** headless chrome via `browser-host.mjs` → `createSurface('v',{url:'http://127.0.0.1:5174'})` → `controlSession eval` → `document.getElementById('root').childElementCount` >0, `typeof window.agentOS.onMetaTap === 'function'`.
- **Real-agent test:** `claude -p "<paste-URL>; fetch it, follow it, open example.com + read the title" --dangerously-skip-permissions` (claude has Bash/curl → it POSTs the tools).
- Write throwaway node tests INSIDE `preview/` (so `ws` resolves from node_modules), run with `dangerouslyDisableSandbox`, then `rm`.

## Git state (IMPORTANT)

- **No SSH key in sandbox → the USER pushes** (`git push origin master`). My `origin/*` refs are STALE (I can't fetch) — verify against the user, don't trust the ref.
- **As of last visible state:** `origin/master` = `51edf06`; local HEAD = `09c121f` (ahead ~2: `5c83128` hydrate-review fold + `09c121f` wait-fix — tell the user to push these).
- **Recent (newest→older):** `09c121f` /events wait:0 fix · `5c83128` hydrate-review fold + dead-code sweep · `51edf06` cleanup · `5c3845c` Phase-1 review fold · `a0eb7ac` BLITZOS.md scaffold · `051bb9a` Phase 3 watch+reconcile · `629df37` Phase 1+2 write+hydrate · `63b9b8e` Phase 0 stable ids · `5d4b6c1` workspaces design doc · `83cda05` Discord on-unload flush · `9867ff8` persistent browser profile · `d253a6e` merge agent-runtime-moments (journal/persistence.ts/unified-agents.md) · `ccbf471` agent-readable + activity-log · `8d059cb` chat pinned · `c0b90b0` window-mgmt.
- **DOCS:** `agent-os-workspaces.md` (the persistence/serialization spec — the active build) · `agent-os-dynamic-architecture.md` (dynamic-OS L1–L5 + roadmap) supersedes `agent-os-desktop-architecture.md` · `agent-os-server-mode.md` · `professions-agent-fit-catalog.md`.
- **agent-socket** (separate repo) — my relay fix `f5b12d2`; the other agent owns it. Not mine to push/deploy.

## Open audit findings (we3qbpvd3; 2 blockers FIXED, majors OPEN)

**Blockers FIXED (`6281066`):** read_window-script eval bypass (→ safe read only); /api/os/stream open WS (→ cross-origin reject + Input/Page method allowlist).

**Majors OPEN (fix before relying on server mode / deploy):**
1. `createSurface` race → double-creates + leaks a Chromium target (`surfaces.set` after awaits). Fix: synchronous `inflight` Set; `has()` checks both.
2. Browser/WS death never rejects in-flight CDP → `send()`/agent request hangs forever. Fix: `_fail()` rejecting `pending` on close/error + per-cmd timeout.
3. No respawn supervisor (`child.on('exit')` only in startup). Fix: persistent exit handler clears surfaces + nulls/respawns `host`.
4. Resize not propagated (viewport/screencast pinned at create; `update_surface` only handles url). Fix: `host.resize` → `Emulation.setDeviceMetricsOverride` + restart screencast. (Clicks land fine — `toPage` rescales.)
5. `createSurface` partial-failure leaks the context (no try/catch). Fix: try/catch disposes partial + emits error.
6. Plaintext tokens (`.tokens.json`) — AES-256-GCM (`BLITZ_TOKEN_KEY`) before off-localhost.

**Minors:** `mountServerSurface` 3-arg contract lie (drop the 3rd arg + w/h effect deps — real fix = server resize #4). Per-mousemove CDP flood (throttle `onMove`).

## In-canvas Chat (DONE) — message the OS directly

A first cut of the architecture's "built-in chat client". `ChatPanel.tsx` (native component `chat`, opened via the toolbar 💬 Chat button). User types → `window.agentOS.sendMessage` → `emitUserMessage` → a **`trigger:'message'` moment** (carries the text in `message`; **exempt from relay redaction** since the user authored it for the agent) → a watching agent sees it on `/events`. Agent replies via the **`say { text }` tool** → broadcast `os:action 'chat'` → `App.tsx` appends it to the Chat panel. Both transports (Electron `osSay`/ipc; server `/say` + `POST /api/os/user-message` + shim `sendMessage`). Verified e2e in server mode (message moment not redacted; say broadcast reaches renderers). AGENTS_MD/OS_AGENTS_MD tell the agent: trigger:'message' = the user messaging you → always reply with `say`.

## Agent runner — BlitzOS boots + auto-restarts the brain (DONE, `59b2b84`+`b3b4bc9`)

Fixes the recurring "agent ended → nothing listening → nothing happens". `src/main/agent-runner.mjs` (+`.d.mts`): `startAgentRunner({getUrl, cmd, label})` spawns `claude -p <brain-prompt> --dangerously-skip-permissions` at the live agent URL and **re-spawns on exit** (fast-fail backoff 1.5–30s). Brain prompt reads `latest` at startup so a restart doesn't replay old moments. Wired opt-in (env `BLITZ_AGENT=claude|<cmd>`) into `backend.mjs` (relay url) + Electron `index.ts` (`getAgentSocketUrl`); `start-all.sh` passes `BLITZ_AGENT` through. **It is supervision, NOT decision-making** — agent stays the sole decider. Single-instance via a `blitz-brain-session` marker on the FIRST prompt line (busybox `pkill -f` truncates long cmdlines, so a trailing marker never matched → brains piled up; front-load fixes `killStaleBrains`). Verified: stub auto-restart 3×; clean start = 1 brain; no-manual-kill restart still 1 (no accumulation); message → single reply + action. **Run it:** `BLITZ_AGENT=claude bash preview/start-all.sh` → the OS keeps a brain alive; the user just opens the canvas + 💬 Chat.

## NEXT — priority

**>>> CURRENT ACTIVE TRACK = WORKSPACES (see the "Workspaces" section above). Phases 0–3 DONE + reviewed. Next, in order: (1) journal re-root + `blitzos-agents.md`/`BLITZOS.md` rewrite (relay `workspace_*` verbs; agent memory = the workspace folder); (2) Phase 4 security (`app` iframe `allow-same-origin` drop, `.blitzos/state` agent-read-deny, snapshot allow-list, full realpath jail, consent-persist); (3) Phase 5 Electron hydrate parity (`osActions`, code-only). See `agent-os-workspaces.md` §10/§11/§12.** Also open (pre-workspaces roadmap, not abandoned): human **STOP / take-the-wheel** (hard-abort in-flight CDP), **follow-mode** (drive `store.focusAndZoom` so reactions come to the user). The items below are the older dynamic-OS roadmap (mostly DONE/superseded — kept for context).

---

0. **P0 — close the `/events` privacy leak — ✅ DONE (Electron).** Per-surface **content-share consent** (`events.ts` `contentShared` Set + `setContentShare`/`isContentShared`/`redactMoment`/`dropContentShare`, default OFF). The **relay (untrusted)** now gates ALL 3 content egresses by `isContentShared`: `/events` redacts un-shared moments to metadata (`redactMoment`), `read_window` + `surface_control:read/screenshot` 403 `not_shared`. The **localhost control-server (trusted, where the resident brain runs) stays full**. UI: a 👁 share toggle on each web surface's title bar (`SurfaceFrame`, Electron-only via `!serverMode`) → `preload.setContentShare` → `os:content-share` IPC. Dropped on close (`osCloseSurface`). App.tsx hardening: `__blitz:navigate` requires http(s); `surfaceAction` payload capped 4KB. Typecheck + build pass. **Follow-up:** server-mode (`backend.mjs`) has no `/events` kernel so no proactive leak there, but its relay `read_window`/`surface_control` content isn't yet gated — fold into P5 server parity. Runtime behavior verifiable only via `npm run dev` on the Mac (Electron, no display here).
1. **First-milestone arc = the end-to-end vertical slice** (decided): **P0 ✅ → P1 ✅ → P2 → P3.**
   - **P1 in-OS brain — BUILT then NUKED (2026-06-05 directive: "BlitzOS should not try to be the agent").** `src/main/brain/{orchestrator,reasoner}.mjs` + the governor concept are DELETED. BlitzOS is **pure substrate**: perception (sensors→coalescer→`/events`) + tools + transports, **no in-process decision logic** (no resident reasoner, no governor, no code judging significance). **The connected agent IS the brain** — relay Claude or `claude -p` long-polls `/events` and decides + acts. Removed: `startBrain` (index.ts, backend.mjs), `getObservations`, `/brain/log`, `/api/os/brain-log`. KEPT (substrate, not policy): the `events.ts`/`perception-core.mjs` coalescer (incl. `hasUser` wake-gate — scheduling, not policy), `startServerPerception` (produces moments). Doc §0 decision #6 + L3/P1/P2 rewritten. Typecheck + build pass.
   - **Next: P2-as-safety-only** — the human-control layer (consent already shipped; add a **STOP/"take the wheel"** that hard-aborts in-flight CDP). NO governor. Then **P3** act tier (`focus`/`follow` os:action driving the built-but-unreachable `store.focusAndZoom`; `op:'tool'` `send_reply` bridge; suggested-reply widget) — all driven BY THE AGENT.
2. ~~Widget system~~ **DONE** `52830bc`. Follow-ups folded into the roadmap: generic `op:'fetch'` escape-hatch (= the perception-framework decision), srcdoc CSP, more provider resources.
2.5. **P5 server-mode autonomy parity — 🟡 PARTIAL (perception/brain LANDED).** Extracted the kernel to shared `src/main/perception-core.mjs` (coalescer + content-share + INJECT/DRAIN) + `src/main/brain/{reasoner,orchestrator}.mjs`; `events.ts` re-exports (one impl, no drift). `preview/backend.mjs` injects sensors into each server Chromium target over CDP (Runtime.evaluate INJECT/DRAIN, 350ms drain, supervised) → same coalescer; `/events` tool (relay-redacted); resident brain (`startBrain('server-brain')`); `POST /api/os/content-share` + `GET /api/os/brain-log`; 👁 toggle un-gated in server mode. **Verified e2e in headless Chromium** (click→idle moment→/events redacted/full→brain obs). So the link now runs the autonomy loop. **Remaining (reliability/login half):** persistent server browser profile (logins survive — today mkdtempSync=logged-out), respawn supervisor + CDP reconnect, idempotent createSurface (= the browser-host audit majors), server-mode surfaceAction callback.
3. **Audit majors #1–#3, #5** (server-mode reliability, browser-host.mjs) — still OPEN; = the P5 "remaining" reliability half above.
3. **Server-mode polish** — binary WS frames, DPR/zoom/scroll coord transform, off-screen fps throttle.
4. **Deployment** (parked) — `issues/open/server-mode-deployment.md` (static-serve, bind 0.0.0.0 + bearer everywhere, Docker + Caddy, then multi-tenant). Note: user said CF Access handles external auth on the tunnel, so app-layer `/api` gate is deprioritized.
5. **OS's own headless agent** — BlitzOS runs its own Claude/Codex that perceives (`list_state`/`read_window`) + acts. Now buildable.

## Widget system verify recipe (re-runnable, server mode)

Bring up backend+vite (no tunnel): two background tasks running `node preview/backend.mjs` (env `BLITZ_SERVER_MODE=1 BACKEND_PORT=8799 PUBLIC_BASE_URL=http://127.0.0.1:5174`) and `npx vite --config vite.renderer.preview.mjs` (env `BLITZ_SERVER_MODE=1 BACKEND_PORT=8799`). **Run node in the task's foreground (NO `&`)** or it gets orphaned/killed. Restart vite after editing `agentos-shim.js` (it `readFileSync`s the shim once at config load).
- **Catalog** (no server): `node` import `../src/main/widget-catalog.mjs`; `fetchProviderResource('discord','guilds', <token from preview/.tokens.json>)` → 65 guilds; `'__proto__'`/`'constructor'` → 404.
- **Relay tools + data route + consent**: `$BASE` = `GET :8799/api/os/agent-url` minus `/agents.md`; POST `$BASE/{list_widgets,get_widget_source,spawn_widget,save_widget,list_integrations,get_widget_authoring}`. Data route is backend HTTP (not a relay tool): `GET :8799/api/integrations/discord/guilds?surface=ID` → 403 w/o consent; `POST :8799/api/os/consent {surfaceId,provider}` → 200; revoke → 403; close_surface prunes; 2 rapid → 429.
- **Full bridge render** (headless chromium, auto-attach to the iframe target via `Target.setAutoAttach`): load `:5174`, spawn_widget over relay, poll for the parent's "Allow" button, `.click()` it, read the iframe session's `document.body.innerText` → guild names. Code-swap test: `update_surface {id, html:new}` → "Allow" button RE-APPEARS (consent-reuse fix). NOTE: discord rate-limits guild fetches hard after many runs (their 429 → our 502); retry with delay.

## Key docs

- `agent-os-desktop-architecture.md` — Electron-mode plan/backlog.
- `agent-os-server-mode.md` — server-mode architecture + capability matrix + verified decisions.
- `../issues/open/server-mode-deployment.md` — VPS deploy checklist (parked).
- `../preview/RUNNING.md` — how to run on the domain.
- `../CLAUDE.md` — BlitzOS guidance (teammate-authored).

## Gotchas / lessons

- **Process mgmt:** ALWAYS use `preview/start-all.sh` (setsid groups + pidfiles). Never `nohup &` + `pkill` ad-hoc — caused recurring zombies / stale-shim / port-squat chaos all session. `pkill -f` patterns self-match shells whose cmdline contains the word; kill by exact PID or `[x]` regex trick.
- **Sandbox is musl** (Alpine): `workerd`/`wrangler dev` won't run (glibc). `ss`/`fuser` flaky. Headless Chromium at `/usr/bin/chromium` works → server mode testable here; Electron GUI is NOT (needs display) → typecheck/build only, behavior = `npm run dev` on the user's Mac.
- **Foreground `sleep` is blocked** by the harness — use `curl --retry` or in-process `setTimeout` (node), never `sleep` in a script I run via Bash.
- **Backend :8799** (8787 = wrangler default; other agent's relay).
- **No SSH key** → user pushes.
- **Tokens on the sandbox** (plaintext, gitignored), not a Keychain.
- CF tunnel hostname mapping persists on the user's CF account; token saved → next time just `start-all.sh`.
- After any restart: **hard-refresh** the tab (cached shim) + the agent URL re-mints.
