# Connecting external apps & tabs to BlitzOS

Connect a **Chrome (or Safari) tab** or a **macOS app window** into BlitzOS. A connection gives the agent **tools to read and act on that source**, lets the agent **save its own reusable tools** for that source, and spawns a **widget that represents it** — an agent-authored summary/view, kept fresh as the source changes. No screen streaming, no window mirroring.

Mostly wiring into things BlitzOS already has (all named internals are verified to exist). New builds: a Chrome extension, the extension↔main link, AX + vision verbs in the existing helper, and the per-source tool store.

---

## Architecture

```
agent ──(agent-socket: connection tools)──┐
                                          ▼
        connection registry (main) ──spawns──▶ representation widget (srcdoc)
         │         │                              │ (buttons call saved tools)
   tab adapter  window adapter      per-source tool store (tools.json + scripts)
   (extension)  (AX + vision,                ▲
                 BlitzComputerUse)           └── agent saves/reuses named scripts
```

- **Connection registry** (one small module in main): holds `connId → { type, sourceId, adapter, surfaceId }`. Everything dispatches through it. Same `makeOsTools(ops)` discipline as the OS tools — one registry, not parallel stacks.
- **Two adapters, one interface:** each adapter is just `call(verb, args) → result` + an event stream ("source changed"). Tab = a Chrome extension; window = AX + vision verbs in the `BlitzComputerUse.app` helper. A connection advertises its **capabilities** so the agent knows what it can do (e.g. `run_js` is tab-only; a window may be AX-mode or vision-mode).
- **Per-source tool store:** the agent's saved scripts for a source (see "Agent-authored tools").
- **Representation widget:** agent-authored srcdoc; renders the source and can trigger the saved tools.

Two ids: a **`connId`** per connection (this specific tab/window — the widget binds here) and a **`sourceId`** = a stable site/app identity (a tab's origin `mail.google.com`, a window's bundle id `com.tinyspeck.slackmacgap`). The **saved tools key on `sourceId`** so they're reused across instances and sessions (both your Gmail tabs share its learned tools); the **connection + its widget are per-`connId`**. Reconnecting the same source re-attaches to its tools. **When `sourceId` changes under a live `connId`** — a tab navigating cross-origin (every login flow: `mail.google.com → accounts.google.com`), or an SPA switching product area — emit a moment and **re-brief**: the connection and its widget stay (same `connId`), but the tool library **re-keys** to the new `sourceId`, so the agent never silently runs Gmail's tools against an OAuth page. Where bare origin/bundle is too coarse, `sourceId` may be **composite** — origin + path-prefix for an SPA, bundle + window-role for a multi-window app (Slack DM vs huddle have different AX trees) — so distinct surfaces don't share one `tools.json`.

---

## Starting a connection (the user's entry point)

The user triggers **Connect** (from the create/radial menu or a toolbar action) → picks the source:
- **a tab** — from the extension's tab list (`chrome.tabs.query`, real tab ids), or Safari's via Apple Events;
- **a window** — from the running apps/windows list (`NSWorkspace` + AX).

BlitzOS binds the connection (`connId` + `sourceId`), marks it shared, and wakes the agent with a moment; the agent reads it and spawns the representation widget. (A connection can also be initiated by the agent itself — "connect the user's Gmail tab" — same path.)

---

## The connection tools (agent-socket-shaped)

Defined in the **shared** tool registry (`os-tools.mjs`-style) and bound for **both** transports — Electron (`electron-os-tools.ts` → relay + local control server) **and** the server backend (`serverOps` in `preview/backend.mjs`) — so the agent vocabulary is identical in app mode and server mode (see "Running modes" — the *adapters* differ, the tools don't). Every call carries `{ connection }`. Fixed vocabulary (the relay registers tools once at startup — see "Agent-authored tools" for how the agent extends it *without* new relay tools).

| Tool | Does |
|---|---|
| `connection_list` | what's connected: `connId`, type, `sourceId`, capabilities |
| `connection_read` | read the source — tab: DOM/text; window: AX tree/value; **screenshot** when structure is thin. **Scoped + capped by default** (a selector/subtree + a size cap) — never dump a whole DOM/AX tree into context |
| `connection_act` | click / type / set — **by ref** (tab JS, window `AXPress`; works in background) **or by coordinate** (`CGEvent`; needs the window raised; **macOS-local** capability) |
| `connection_run_js` | arbitrary JS in the page (**tab only**) |
| `connection_save_tool` | save a named reusable script for this `sourceId` (see below) |
| `connection_call_tool` | run a saved tool by name `{name, args}` |
| `connection_list_tools` | list the saved tools for this `sourceId` |
| `connection_drop` | disconnect |

Capabilities tell the agent which apply (a vision-mode window has no `run_js`; a saved tool may be read-only). A call to an unavailable verb returns `capability_unavailable`, never a hard error. **Acts return an `effect`** (the resulting url / DOM / value change) so the agent verifies the action landed in-band — the same "effect-verified syscall" contract `surface_control` uses, not a blind `ok`. (`connection_act` and `connection_run_js` deliberately overlap for tabs: `act` is the **uniform** click/type/set verb across tab *and* window so the agent drives both the same way, while `run_js` is the tab-only escape hatch for arbitrary code — keep both. Coordinate-acts are window/macOS-local only.)

### Access model (no extra gates)

**Connecting a source is the consent.** From then on the connection's tools — including `run_js` — work like every other agent-socket tool: no per-action confirmation, no transport restriction, over the relay ("Connect AI") or localhost alike. The agent drives a connected tab/window as freely as it drives the rest of BlitzOS. The scope is just the connection: the agent can only touch sources the user connected, nothing else in the browser/OS.

(The one real caution, and it's not a gate: a connected page's **content** is untrusted input — the agent shouldn't blindly believe text on the page, same as any web content. "Don't trust what it says," not "restrict what you do.")

---

## Agent-authored tools (the per-source `tools.json`)

This is the agent-socket `tools.json` / `agents.md` idea, but **per source and authored by the agent itself** — so work it figures out once becomes reusable.

When the agent works out a useful operation on a source (e.g. on `mail.google.com`, "unread count" is a specific DOM query; on a Jira board, "my open tickets" is a specific scrape), it calls **`connection_save_tool`**:

```jsonc
// .blitzos/connections/mail.google.com/tools.json   (durably flushed, like every workspace file)
[
  { "name": "unread_count", "description": "number of unread threads in the inbox",
    "kind": "read", "code": "return document.querySelectorAll('tr.zE').length" },
  { "name": "archive_top",  "description": "archive the top thread; returns the archived subject as its effect, or throws if no unread row",
    "kind": "act",  "code": "const r=document.querySelector('tr.zE'); if(!r) throw 'no unread row'; const subj=r.innerText.slice(0,80); r.querySelector('[aria-label=Archive]').click(); return { archived: subj };" }
]
```

- **Storage:** a file per `sourceId` under the active workspace (`.blitzos/connections/<sourceId>/tools.json`), durably flushed — reuses the filesystem-is-canvas + `durableFlush` path the rest of BlitzOS uses. Reusable across reconnects and sessions; a fresh agent run reads the file (or `connection_list_tools`) and inherits everything already built.
- **Execution:** `connection_call_tool {name, args}` looks the script up and runs it through the connection's adapter — for a **tab** the `code` is JS run in the page; for a **window**, a tool is a small recipe of AX/coordinate steps (`{find: "AXButton 'Send'", action: "AXPress"}` / `{click: [x,y]}`) the helper executes. Same named-tool surface either way.
- **Rot-detection (mandatory for `act`).** A saved `act` tool MUST return an `effect` — the concrete change it made (archived subject, new value, url/DOM delta) — never a bare `ok`. The worst failure is a stale selector that **silently no-ops** (a `.click()` on a vanished node) and reports success, feeding back wrong/empty data; an empty-or-throwing effect is treated as **stale → re-derive** and surfaced, so the agent re-authors the tool instead of trusting it. Bias the store toward *stable, expensive-to-derive* recipes (a multi-step flow, a known data endpoint) — a one-line selector the agent could just re-read rots fastest and saves least.
- **Not new relay tools (deliberate):** the relay's tool list is fixed at startup, so saved tools are invoked through the **one** `connection_call_tool` dispatcher (name = a parameter), not registered as new endpoints. The per-source `tools.json` is a library the dispatcher reads — this is the correct shape given the relay constraint, and it's how BlitzOS discovers everything (read state, call a generic tool) rather than minting tools at runtime.

**"Can the scripts live in the widget?"** The scripts live in the per-source store (reusable beyond any one widget), and the **widget is a consumer**: a widget button calls `connection_call_tool {name}` through the existing widget→tool bridge (`widget-tools.mjs` `WIDGET_TOOLS` + `makeWidgetToolHandlers`). **Prerequisite — the bridge has no per-surface scoping today:** any widget can name any surface/connection id (`makeWidgetToolHandlers` doesn't bind a widget to a connection). Before widget buttons may invoke `connection_call_tool` (which dispatches `act`/`run_js` against an untrusted page), bind each widget to **its own `connId` only** — derive the connection from the calling surface, reject any other id. Until that scoping lands, saved-tool execution stays **agent-only** (the widget emits an intent the agent runs). With it: the agent authors a representation widget whose buttons *run* its saved tools ("Archive", "Refresh count"), and the same tools are callable headless by the agent. One library, two callers (agent + widget).

---

## Discoverability, status & instrumentation (the rest of the agent-socket parity)

- **Per-connection briefing (the `agents.md` analog).** On connect — and in `connection_list` — the agent gets a short brief: what the source is (`sourceId`, title, type), its capabilities, and its saved tools. So a fresh session knows how to drive a source it (or a past session) already learned, without re-deriving. The agent can also write a one-line `description` for the source (stored next to `tools.json`) — its own notes on what this connection is for.
- **Status / liveness.** A connection has a status — `live` / `disconnected` / `reconnecting` — surfaced to the **user** (on the widget) and the **agent** (in `connection_list`, and a moment on transition), so the agent knows a call will fail because the tab/window is gone, instead of erroring blind. Driven by the **adapter noticing the source is gone** (tab-closed event; the window/app vanishing from AX) or the link dropping (extension SW evicted / helper down).
- **Activity feed + telemetry (free wiring).** Add the connection tools to `ACTIVITY_TOOLS` + `activityText` so calls show in the on-screen Agent-activity panel ("agent clicked Send in Slack"); the existing `setToolTap` / `setMomentTap` taps capture them in telemetry/session-tape automatically — exactly as `withActivity(...)` wraps the OS tools today.
- **Consent.** Connecting a source **is** the user granting the agent read access to it — wire it into the existing per-surface content-share consent mechanism (`setContentShare`): a connected source is shared; disconnecting revokes it.

---

## The two adapters

### Tab adapter — Chrome extension
A Manifest V3 extension connects to BlitzOS main and, via `chrome.scripting.executeScript` (Chrome 95+): reads the DOM, runs JS, clicks/sets values — **all on a background tab, no banner** (`chrome.scripting` injects into the page renderer; unlike `chrome.debugger` it never attaches the DevTools protocol, so there's no "being debugged" infobar). It lists its own tabs (`chrome.tabs.query`, real tab ids — this is the tab picker), reports navigation/title/close events, and reconnects if Chrome evicts the service worker (heartbeat <20s + a `chrome.alarms` wake). Coordinate clicks / key events / screenshots of a tab do **not** use `chrome.debugger` — they use the native path below (a Chrome window is just a macOS window), so they're a **macOS-local capability**: off-macOS/remote tabs are ref/`run_js`-only (no coordinate-input, no screenshot).

**World:** inject in **ISOLATED world by default** (reading the DOM, `.click()`, setting input values need nothing more); escalate to `world:'MAIN'` **per-connection** only when a source genuinely needs page globals (framework internals, a page-defined function). MAIN lets a connected page's own JS see more of ours, so it's opt-in per source, not the default.

### Window adapter — the BlitzComputerUse helper
Add verbs to `main.swift` (the helper already holds Accessibility + Screen Recording grants):
- **AX (good-AX apps — native + Electron):** read the AX tree, read a value, `AXPress`, set `AXValue`, watch via `AXObserver` (debounced; recreate the element handle from the app's pid each call — never cache it). Works on background windows. Set `AXManualAccessibility` on Electron targets, retry once. Capability is really **per-element, not per-connection**: if a nominally-AX app returns an **empty subtree** for a given window/state (an Electron app hosting a `<canvas>` editor), fall back to vision for that read rather than reporting nothing.
- **Vision (apps AX can't read — Qt/OpenGL/Metal/canvas/games):** **no OCR.** Screenshot the window (ScreenCaptureKit — `SCScreenshotManager` with a desktop-independent single-window `SCContentFilter`; **not** `CGWindowListCreateImage`, which is obsoleted in macOS 15) → return the image to the model, which reads it with its own vision; the model picks a point → **coordinate** click/type/scroll/key via `CGEvent`. This is the Computer-Use loop: screenshot in, coordinates out. Caveat: coordinate input is OS-level, so it needs the window **raised/visible** (AX presses and tab JS-clicks stay background-capable).

This native pixel layer (screenshot + `CGEvent`) is **one mechanism for both tabs and windows** — no third input system. Treat pixel/coordinate acts as a **distinct contract** from structured ref-acts, though: they **raise the window** (a visible side effect the agent should announce), are non-deterministic (the model picks the point), and verify only by a follow-up screenshot — advertise them as their own capability so the agent reasons about that blast radius, instead of hiding them behind the same silent-background `act`.

### Safari
No Safari extension (it can't be force-installed — always a user toggle). Safari tabs use **Apple Events `do JavaScript`** (Safari is scriptable) behind the same vocabulary; one-time setup (Develop → "Allow JavaScript from Apple Events" + Automation grant). A native Safari Web Extension only if Safari becomes a priority. (Honest caveat: `do JavaScript` is **synchronous/blocking**, needs per-user Develop-menu + Automation grants, and has **no background event-stream or reconnect** — it's a third adapter wearing the tab vocabulary, not free parity. Keep it last in the build order; don't assume drop-in.)

---

## The representation widget

The agent authors a srcdoc widget from what it reads (`create_surface{kind:'srcdoc'}`), stores `connId ↔ surfaceId`, and refreshes it via `update_surface{props}` — re-renders in place (the existing `blitz:props` loop, no reload; props are **live-only**, see Risks). Its buttons can call the source's saved tools (above).

**"Changed" needs a significance classifier.** BlitzOS perception only wakes the agent on *user* signals — an external tab/window produces none, so the adapter can't lean on the existing wake path; it must decide, per source, which `MutationObserver`/`AXObserver` deltas matter. A **significant** change (nav, a new message, a status flip) emits a moment on the **immediate** transition path (the same one `nav` uses) so the agent wakes at once — not after the ~15s batch cadence, and *not* the 25s figure (that's only the long-poll's max idle wait when nothing is happening; a real moment returns the poll instantly). Routine **churn** (a clock tick, an animation, a re-poll with no delta) refreshes the cached snapshot silently and does **not** wake. Debounce within each class. A faster refresh also wants a *fast model* on the relay; for genuinely real-time sources the non-LLM fast path is split into `plans/connection-widget-fast-refresh.md` (future).

---

## Installing the Chrome extension

Not publishing initially (it'll change a lot), so the extension is **self-hosted** — bundle the `.crx` + a tiny `updates.xml`, point the policy's update URL at it. Changes freely, no Web Store review.

Install = **consented force-install** (`ExtensionInstallForcelist` managed-prefs policy), with a popup, two entry points:
- **At BlitzOS install / first launch:** popup "BlitzOS wants to install a Chrome helper extension" → Yes → write the policy. Chrome installs + enables it (~10s, "installed by administrator"; Chrome also shows a persistent "Managed by your organization" while the policy is present — expected, and worth saying in onboarding).
- **At connect-time, if missing:** "Connect a tab" → extension absent → popup "Allow installing the helper to connect this tab?" → Yes → write the policy, then connect.

**Dependency:** writing `/Library/Managed Preferences/com.google.Chrome.plist` needs **root** → BlitzOS ships as a `.pkg` (admin once at install) or prompts for admin via AuthorizationServices at the moment. BlitzOS ships a ZIP today, so this is new installer infra. Remove the extension by deleting the policy key. Dev: load-unpacked, skip all this.

---

## Build order (all of it — order, not scope)

1. **Connection registry + tools + the per-source store.** New module; append the connection tools to `OS_TOOLS`; `save/call/list_tool` read+write `.blitzos/connections/<sourceId>/{tools.json, description}` under the active workspace; `connection_list` returns type + status + saved tools; wire the activity/telemetry taps + mark a connected source shared (content-share consent). Returns empty until an adapter binds; testable over the socket.
2. **Tab adapter (Chrome extension + extension↔main link).** Link: a small localhost WebSocket server in main, **or** reuse the existing localhost control server (long-poll + POST) for zero new infra — whichever is less code. Connect a tab → read/run_js/save_tool → agent authors the widget → refresh on navigation.
3. **Window adapter.** AX verbs + the vision (screenshot + `CGEvent`) verbs in `main.swift`; window picker; same vocabulary, same tool store, same widget loop. Tab coordinate input reuses these verbs.
4. **Safari** via Apple Events `do JavaScript`, behind the same vocabulary.

---

## Connect to main: extension↔main link

The extension reaches main over a localhost link. The real authenticator is a **per-install session token**, locally generated, presented on every message — **not** the `Origin` header. `Origin: chrome-extension://<our-id>` is browser-set and unforgeable *by a page*, but any non-browser local process can open the socket and send any `Origin` string it likes, so Origin is **defense-in-depth, not the gate**. The token must reach the extension over a channel a sibling process can't read — a **native-messaging handshake** (a native host BlitzOS controls hands the extension a per-launch token) or a one-time user-copied pairing code — **never baked into the self-hosted `.crx`** (that ships one token to everyone who downloads it). Fixed localhost port (small fallback range the worker probes). Remote/server mode rides the same token over an authenticated WSS session (entropy + expiry + channel-bound).

---

## Running modes (Electron app vs server; macOS vs Linux)

The feature's premise — bring the user's tabs/windows in — assumes BlitzOS is **co-located with the user's machine**. True for the Electron app and a self-hosted *local* server; it changes for a remote server and for Linux. The **shared layer is mode-agnostic** (registry + tools + widget loop + per-source store, bound via `serverOps` too); the **adapters and delivery differ**.

- **Tab connect — works in every mode, link differs.** Local (Electron / local server): extension ⇄ **localhost**, force-install OK. Remote server: the extension runs in the user's **own browser** and pairs to the remote BlitzOS over an **authenticated WebSocket** (server URL + pairing token), **user-installed, not force-installed** (a remote server has no root on the user's machine). On Linux (and any remote/off-macOS tab) the DOM/`run_js` path is unchanged — it's the user's own browser; only the native pixel layer (coordinate-input + screenshot, which is macOS-local) is unavailable there.
- **Window connect — macOS-and-local-only.** Needs AX / `CGEvent` / ScreenCaptureKit, which exist only on macOS and only reach windows on the **same machine**. So it works where BlitzOS runs on the user's Mac (Electron, or a local Mac server). A **remote** server can't reach the user's windows without a **local companion** on the user's Mac that holds the grants and bridges to the server (a bigger lift). **Linux has none of these APIs → no macOS window adapter**; a Linux adapter (AT-SPI read / XTEST or uinput input / PipeWire or X11 screenshot) is a separate future build. **Net: Linux = browser tabs only.**
- **Delivery:** force-install (managed-prefs plist) is **local-only**; remote/server uses user-install + pairing.
- **Unchanged across modes:** the representation widget + `tools.json` are just surfaces + files — server mode already renders srcdoc surfaces and persists workspace files, so they work as-is.

---

## Risks

- **Security/trust** — the extension installs with broad host access (`<all_urls>` for `chrome.scripting`), but the agent only ever drives a tab **the user explicitly connected** — connecting is a deliberate, per-tab act and the user picks which tabs, so *usage* is user-scoped even though the installed *capability* is browser-wide. Be honest about that gap in onboarding (the capability is all-sites; the policy limiting it to connected tabs is enforced by BlitzOS, not Chrome — not "narrowly scoped"). Mitigations that cost nothing: **ISOLATED world by default** (escalate to MAIN only per-connection); scope hosts to connected origins where the flow allows. No per-action gates (connecting is the consent). Treat a connected page's *content* as untrusted input (prompt-injection — don't blindly believe it); a widget may call tools only for *its own* connection — which **requires per-`connId` scoping on the widget bridge** (none today, see "Agent-authored tools").
- **Vision path plumbing** — (a) a screenshot is an *image* tool-result; verify it traverses the agent-socket relay (the "Connect AI" path) — if not, vision works only on image-capable transports. (b) Map coordinates carefully: screenshot pixels are retina-2×; `CGEvent` needs screen *points* offset by the window origin.
- **Saved-tool rot** — a saved selector breaks when a site changes its markup; a failed/empty tool result must signal "stale → re-derive" so the agent re-authors it, not return wrong data silently.
- **AX flakiness** — empty trees on some apps; stale handles after an app relaunch (recreate from pid); after a macOS update the grant can read as on but fail until the helper is relaunched (`relaunchForGrant` already does this).
- **Refresh cost & prop limits** — connection/representation widget props are **live-only (non-durable): never written to `workspace.json`**. Two confirmed-in-code reasons: (a) `update_surface{props}` does a *synchronous* `durableFlush` today (`osActions.ts`) — a chatty source would hammer disk on the perception hot path; (b) props >8 KB are **silently dropped** on persist (`workspace.mjs`), so a real payload (an inbox list, a board scrape) would vanish and the widget reload empty with no error. Live props sidestep both — the widget is regenerated from the source on reconnect anyway (the live connection doesn't persist). Persist only the saved tools + `description` (those *are* durable). Also debounce the "source changed" wake.
- **Restart** — the **saved tools + `description`** persist (keyed by `sourceId`); the **live connection** (tab id / window / socket) and the widget's **live props** do not. On restart the widget shell rehydrates **empty/stale** and the connection is marked disconnected — the user reconnects, the agent repopulates from the source, and the saved tools are immediately reusable. (So a representation widget should render a sensible "disconnected — reconnect" state, not assume its props survived.)
