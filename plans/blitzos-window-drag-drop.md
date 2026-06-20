# BlitzOS window drag-and-drop picker

**TL;DR.** Drag ANY macOS window into the island attach dropbox to connect it as agent context. A browser window
connects its **active tab** via the Chrome extension (real DOM + `run_js`); anything else connects as a **native
window** via the computer-use helper (AX tree + screenshot + coordinate clicks).

## How it works

- **Native picker** (`native/computer-use-helper/main.swift` `PickController`): while the attach panel is open a
  `CGEventTap` watches the cursor; `CGWindowListCopyWindowInfo` (layer 0) hit-tests the window under it; a borderless
  overlay glows that window + shows its app icon. Mousedown anywhere on it grabs (icon snaps to the cursor); release
  over the dropbox emits `pick_drop {windowId, pid, app, bundleId, title, icon, x/y/w/h}`. The island chassis rect
  (`selfRect`) is a no-grab zone so the island chrome wins its own clicks. Glow + drag run on the HID tap, so the
  overlay can be click-through (Dock/menu bar stay usable).
- **Commands:** `pick_start {dropZone, selfRect, excludePids}` / `pick_stop`. **Events:** `pick_hover` / `pick_over`
  / `pick_drop` / `pick_cancel`.
- **Routing** (`src/main/index.ts`): on `pick_drop`, ask the extension for its windows+bounds
  (`tabLink.listWindows` → `extension/sw.js`); match the dropped CGWindow to a Chrome window by **bounds** (~120pt
  tolerance). Match → `connectionConnectTab(activeTabId)` (tab-level); no match → `connectionConnectWindow(windowId)`.
- **The bridge:** a `CGWindowID` and Chrome's `tabId` never meet, so on-screen **bounds** is the only shared key.
  No hardcoded browser list — the extension's own window list defines what's a connectable browser tab.
- **UI** (`notch/AttachPanel.tsx`): the dropbox shows the dropped windows' real app icons; tap one to see its window
  title (Ghostty = dir, Chrome = page). The right pane is the live connectors list.

## Key files
`main.swift` (picker) · `computer-use-helper.ts` (multi-listener onEvent) · `index.ts` (pick IPC + drop router +
`matchBrowserTab`) · `extension/sw.js` + `connection-tab-link.mjs` (`listWindows`) · `App.tsx` (island pin +
click-through in attach mode) · `NotchHost.tsx` (arm picker, measure rects) · `AttachPanel.tsx`/`attach.css` ·
`IslandPanel.tsx`/`island.css` (hide tabs+chat in attach mode).

## Done
Hover-glow picker, whole-window grab, icon-on-cursor · Dock/menu-bar stay clickable · island stays open + on-top in
attach mode · attach mode hides tabs + chat (grid-rows collapse) · skill bar removed · bounds bridge (tab vs native)
· dropbox app icons + click-to-detail. Commits: `2f0a39e` (picker), `be7f5a2` (whole-window grab + macOS clickable);
the rest is uncommitted.

## NEEDS VERIFICATION (MJ)
- [ ] **Reload the BlitzOS Connector extension** in Chrome (`chrome://extensions` → reload) so it has `listWindows`,
  else Chrome drops fall back to native.
- [ ] Drop a **Chrome window** → connects the **active tab** (`type:'tab'`, real DOM/run_js); connector list marks it.
- [ ] Drop **Ghostty/Finder/non-browser** → native **window** connection (computer use).
- [ ] **Bounds match / Retina risk:** if Chrome drops still land as window connections, Chrome is likely reporting
  bounds in device pixels on Retina (I assumed DIPs/points) → divide bounds by `devicePixelRatio`, or widen tolerance.
- [ ] Dropbox styling (icon spacing + detail clipped inside the box) — just fixed, eyeball it.

## TODO / known limits
- Helper rebuild needs a `CFBundleVersion` bump (install() skips a same-version copy) + a clean restart (the hot-swap
  can spawn a duplicate helper — two event taps).
- Bounds tolerance (120pt) may need tuning; two windows stacked at the exact same spot are ambiguous.
- Drag has no threshold: a plain click on a window grabs+cancels (a harmless icon flash).
- Active tab only — a window drag can't single out a background tab.
- Multi-display: the overlay coordinate flip assumes the primary display height.

---

## E2E audit + checklist (2026-06-19) — agent chat + attachments

**Verdict:** the connection machinery is REAL and fully wired (UI → preload → IPC → connection-ops → tab/window
adapters → the 14 `connection_*` agent tools). Both attach paths create real connections; a chat agent can genuinely
`connection_read`/`run_js`/`act` on the connected tab/window. AttachPanel is 100% real (no mock import; `notch/mock.ts`
is dead). The gaps are agent AWARENESS + a few unverified heuristics, not the plumbing.

**✅ done, needs live testing** (reload the Connector ext first — must match the loaded id + have `listWindows`):
- [ ] Chrome window drop → `type:'tab'` (right-list row marks connected); non-browser drop → `type:'window'`.
- [ ] dropbox icon + hover tooltip; same-window dedup; right list is real; click connects; click again/drop disconnects.
- [ ] "+ Connect Chrome" install (or load-unpacked).
- [ ] THE REAL TEST: agent in that chat `connection_read`s the tab (page text) + `run_js`/`act`; window → AX read + click/type.

**🟡 adhoc / hardcoded / unverified:**
- Bounds match assumes Chrome reports points/DIPs. If it's device pixels on Retina, every Chrome drop falls back to a
  WINDOW connection (no tab). #1 risk. Tolerance `120pt` is a hardcoded heuristic.
- Drag has no threshold (click = grab+cancel flash); active-tab only; multi-display flip = primary height.
- The `connection` moment is visible ONLY to agent `0` (`perception-core.mjs` `visibleTo` → `sid==='0'`).

**⬜ TODO for "fully functional"** — full design + seams in `blitzos-attachment-agent-wiring.md` (the 3 gaps share one
root: the active session id never reaches the connect path):
- Wake the ACTIVE chat's agent on attach (not just `0`): thread the session id UI → connect handler → moment target.
- Inject pre-spawn attachments into a new agent's first message (notch-send passes `contextRefs: []` today).
- Per-session scoping — connections are process-global + ungated; scope by self-reported agent id (like `/events`).

**🧹 cleanup:** delete dead `notch/mock.ts`; the disconnected-widget "Reconnect" button calls a `connection_reconnect`
tool that isn't defined (op `connectionReconnectSource` exists but isn't exposed at that path).
