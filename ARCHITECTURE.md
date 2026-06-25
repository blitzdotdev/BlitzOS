# BlitzOS Architecture

BlitzOS is an Electron app for macOS that turns the **dynamic island** (the notch) into a
shared workspace for a human and an AI agent. The human drives it directly; an AI agent
drives it over a network relay or a localhost control server. **V1 is island-only** — there
is no canvas, no infinite plane, no surfaces, no windows-on-a-plane, no dock, no workspace
switcher. The island *is* the whole UI.

This document is the contributor-facing map of how the pieces fit together. For day-to-day
working rules and conventions, see `CLAUDE.md`.

---

## The big picture

BlitzOS is best understood as an **OS for an agent**. It does not contain task-specific
logic; instead it provides four general primitives, and the connected agent supplies the
intelligence that decides what to do with them:

```
                         ┌─────────────────────────────────────────┐
                         │                THE AGENT                  │
                         │       (swappable policy / intelligence)   │
                         └───────────────▲───────────────┬──────────┘
            perception (eyes)            │ wake          │ syscalls (hands)
                                         │               │
   ┌─────────────────────────┐   ┌──────┴───────┐   ┌────▼───────────────────────┐
   │  PERCEPTION KERNEL       │   │  SCHEDULER   │   │  AGENT-TOOL REGISTRY        │
   │  raw signals → moments   │──▶│  /events     │   │  (os-tools.mjs)             │
   │  (content-agnostic)      │   │  long-poll   │   │  say/ask, terminals,        │
   └─────────────▲───────────┘   └──────────────┘   │  agents, workflows,         │
                 │                                   │  connections, inbox, …      │
                 │ signals                           └────────────┬───────────────┘
                 │                                                │ ops
   ┌─────────────┴────────────────────────────────────────────────▼────────────┐
   │                          osActions  (control plane)                          │
   │            single source of truth for OS mutations + live state              │
   └──────────────▲───────────────────────────▲───────────────────▲─────────────┘
                  │ IPC                         │ HTTP/JSON          │ relay
        ┌─────────┴────────┐         ┌──────────┴───────┐  ┌────────┴─────────┐
        │  RENDERER         │         │ control-server   │  │ agentSocket      │
        │  (the island UI)  │         │ (localhost, 127) │  │ (relay, remote)  │
        └───────────────────┘         └──────────────────┘  └──────────────────┘
```

The design goal is **out-of-distribution generalization**: perception is dumb-but-rich, the
agent decides significance, and the action set is general. A brand-new task ("coach my
chess", "draft this email", "summarize this PDF") needs **zero new BlitzOS code**. The rule
contributors live by: never hand-build a per-task watch loop — make perception and wake
general, and let the agent's policy handle the task.

---

## 1. The island (the whole UI)

There is exactly **one `BrowserWindow`**, reconfigured as a notch overlay. It is transparent,
present on all Spaces, and spans the full display, but the renderer clips its `#root-canvas`
to the macOS notch shape — a rounded-bottom pill that gives the dynamic-island look. The clip
never grows past the pill.

The island UI is rendered **outside** that clip using **body portals**
(`createPortal(..., document.body)`), z-stacked above the clip so the notch always stays the
top hit-target:

- The `notch-handle` pill (always the top hit-target).
- The `NotchHost` chassis (the expandable island shell).

An always-interactive transparent **hit-window** sits over the physical notch and drives the
hover/click toggle, so the notch is clickable in every state with no click-through race. The
native notch geometry comes from a small Swift helper (`native/notch-geometry`).

### Island component tree (`src/renderer/src/notch/`)

```
notch-handle pill (body portal)  ── always the top hit-target
NotchHost.tsx ────────────────── stateful shell: owns the active page, tab nav,
  │                               wraps everything in the black .nh-chassis
  ├── IslandHome.tsx ─────────── the hover HOME GRID: a row of widget icons.
  │                               V1 ships ONE functional icon (Chat) flanked by
  │                               dotted placeholders. Tap Chat → agent '0'.
  └── IslandPanel.tsx ────────── the SESSION UI: tab strip, transcript,
        │                         status line, steer bar, "Details" expand
        ├── ChatInput.tsx ────── the steer bar / compose input
        └── AttachPanel.tsx ──── the "+" connections panel (browser / computer use)
```

The island React tree under `notch/` is **canvas-independent** — it imports nothing from the
legacy canvas store.

### Open / close behavior

- **Hover** (or the hit-window's reported hover) → opens to the **home grid**.
- **⌥Space** → show / hide the island (pinned open), restoring the last view + tab. It never
  spawns a session and never mutates state.
- **Esc** → closes the island.

Chat is the agent-session UI: a tab strip (a "pen" button spawns a brand-new agent and enters
it immediately, plus one tab per live agent — the primary agent "Blitz '0'" is first), an
iMessage-style transcript interleaved with the narrator's plain milestone steps, a live
status line, a steer bar, a "Details" expand for raw tool rows, and a "+" attach panel for
connections.

> **Off-screen liveness:** the window runs with `backgroundThrottling: false` so the agent
> keeps running while the island is collapsed.

> **Widgets are deferred** (experimental, post-V1). The agent generating / pinning its own
> island widgets is not in V1, which ships only Chat.

---

## 2. The control plane (`osActions` + control-server + agentSocket)

`osActions.ts` is the **single source of truth** for OS mutations and the live-WebContents
registry. Everything that changes OS state flows through it:

```
                 ┌──────────────────── osActions.ts ────────────────────┐
                 │  apply mutation → os:action IPC → renderer → store     │
                 │  renderer pushes os:state back → list_state works      │
                 └───────────────────────────────────────────────────────┘
                      ▲                    ▲                     ▲
       trusted        │       untrusted    │        in-process   │
   ┌──────────────────┴───┐   ┌────────────┴───────┐   ┌─────────┴──────────┐
   │ control-server.ts    │   │ agentSocket.ts     │   │ Electron main wiring │
   │ localhost HTTP/JSON   │   │ relay client       │   │ (index.ts)          │
   │ on 127.0.0.1          │   │ (agent-socket)     │   │                     │
   └──────────────────────┘   └────────────────────┘   └────────────────────┘
```

Two external transports both call into `osActions`:

- **Localhost control server** (`control-server.ts`) — a plain HTTP server on `127.0.0.1`,
  treated as **trusted** (a co-located agent on the same machine). It mints
  `~/.blitzos/session.json`, which carries a `local:{url,token}` block plus the relay URL; a
  co-located agent reads it for the trusted localhost path.
- **agent-socket relay** (`agentSocket.ts`) — connects to a public relay so a **remote**,
  untrusted agent can drive the island by pasting a URL ("connect to BlitzOS"). It mints the
  relay paste URL, surfaced by the in-app "Connect AI" button.

The agent ↔ OS contract is **plain HTTP / JSON, deliberately not MCP**. The agent applies a
mutation, the renderer applies it to the store, and the renderer pushes `os:state` back so
state reads (`list_state`) reflect reality.

---

## 3. The one shared agent-tool registry (`os-tools.mjs`)

The agent's "syscalls" are **defined exactly once** in `src/main/os-tools.mjs`
(`makeOsTools(ops)`), and shared across **all transports**. Each transport binds the same
registry to its own primitive `ops`:

- The Electron relay (`agentSocket.ts`) and Electron localhost (`control-server.ts`) bind via
  `electron-os-tools.ts` (`electronOps`).
- A headless / server runtime binds the same registry to its own ops.

To add or change a tool, you edit `os-tools.mjs` once — every transport gets it. Tools that
are not supported on a given transport return a `501` rather than silently doing nothing.

### The V1 syscall set

| Group        | Tools |
|--------------|-------|
| Talk to user | `say`, `ask` (decision cards in chat), `share_app` |
| Wake loop    | `/events` (the wake long-poll), `steer`, broadcast (steer-all) |
| Peer agents  | `spawn_agent`, `close_agent`, `rename_agent` |
| Terminals    | `open_terminal`, `send_to_terminal`, `read_terminal`, `close_terminal`, `remove_terminal`, `list_terminals` (real tmux terminals) |
| Workflows    | `start_workflow`, `run_workflow`, `set_orchestrators` (blitzscript workflows) |
| Human inbox  | `request_action`, `list_actions`, `resolve_action` (the action-items inbox) |
| Connections  | the `connection_*` family (the user's real browser / app — see §5) |
| Deliverables | `new_app` (provision a real deployable app deliverable) |

The pre-V1 canvas / web / widget tools (`create_surface`, `open_window`, `update_surface`,
`close_surface`, `surface_control`, `read_window`, `get_surface`, the widget tools, …) were
**cut in V1**. The underlying `ops` stay — connections and workflow runs call them
internally — but they are not exposed as agent tools.

---

## 4. The agent runtime (perception → moments → wake)

This is the autonomy half. Raw signals from the world funnel through a perception kernel,
which **coalesces** them into framed snapshots called **moments**. The agent runs **one loop**
and is **woken per moment** — never per keystroke.

```
   raw signals ─emit()─▶  COALESCER  ─▶  moments  ─▶  /events {since, wait}  ─▶  agent
   (messages,            batch on a       framed       long-poll              one loop,
    connections,         ~15s cadence,    snapshot                            woken per
    ticks, system)       or immediately   {trigger,                          moment
                         on a significant  signals,
                         transition        user[], snapshot?, url?, title?}
```

- **Kernel:** `events.ts` (Electron) and `perception-core.mjs` (shared core, also used by a
  headless server backend). `emit()` is the single funnel.
- **`/events {since, wait}`** long-polls moments. The agent wakes, reads the snapshot, decides
  significance, and acts.

### V1 wake sources (`trigger`)

- `message` — island chat.
- `connection` — the user's real browser / app changing or (dis)connecting. This is the
  **primary world signal** in V1.
- `tick` — the status-only supervisor heartbeat (below).
- `system` — e.g. a crash announced after an unclean shutdown.

> **Generalization rule:** keep perception **content-agnostic**. The agent interprets
> significance and acts. No per-task detection (e.g. no "game over" logic) belongs in BlitzOS.

### The supervisor tick (status-only in V1)

`emitTick` (in `perception-core.mjs`) snapshots the host world from a transport-registered
source, diffs it against the prior tick, and emits **one** `trigger:'tick'` moment **only if**
the diff is material — waking the primary agent `'0'` (the supervisor) so it can `steer` a
stalled / erred / diverged worker. V1 diffs **only** agent-status edges and terminal exits;
materiality is transition-shape only, with zero per-task heuristics. A quiet world emits
nothing. `steer` is the redirect mechanism (the island UI's steer bar = "message this agent").

### Boot-task seam (onboarding + the primary agent's duty)

`agent-runtime.mjs` exposes a policy-free `setBootTaskProvider` → `getBootTask`: an optional
duty string, re-read on every (re)launch and injected into an agent's bootstrap with a license
to act unprompted. Only the **primary agent `'0'`** gets a duty: the chat-only
onboarding / interview duty while onboarding is pending, then the resident initiative duty
after. The whole onboarding flow happens in **one agent chat** — there is no case-file board
and no seeded widgets. Duty docs live alongside the runtime as markdown
(`blitzos-agents.md`, `blitzos-interview.md`, `blitzos-onboarding.md`, `blitzos-orchestrator.md`).

---

## 5. Connections (browser + computer use)

The agent acts inside the user's real accounts by driving whatever the user **connects** into
BlitzOS — there is no token API and no BlitzOS-owned `web` surface. The user's own logged-in
browser / app **is** the integration, and auth is **browser-first**: the user's existing
session is the real auth, and the agent confirms the signed-in identity (`connection_read`)
before any outward action.

Two kinds of source can be connected:

- A **Chrome / Safari tab** — via the BlitzOS Connector browser extension (`extension/`,
  force-installed by `connection-install.ts`). Linked by `connection-tab-link.mjs` /
  `connection-safari-link.mjs`.
- Any **macOS app window** — via the computer-use helper (see §7). Linked by
  `connection-window-link.ts`.

A connection is a **per-source tool provider** (`connection-ops.mjs`). The agent drives it via:

- `connection_read` — a tab's DOM / text, a window's accessibility tree, or a screenshot.
- `connection_act` — click / type / set by ref. **Effect-verified**: it returns the observed
  `effect` (the value typed, the DOM / AX change) so the agent confirms the act actually
  landed.
- `connection_run_js` — tab only.
- `connection_save_tool` — persist a derived operation per `sourceId`, inherited by every
  future connection to that same source.

Saved tools can also come from the **Connection Tool Registry** (see §8): a vetted set of
pre-built ops for known sources, surfaced as `registryTools` when a tab is connected.

---

## 6. Persistence (the `.blitzos` journal)

State survives a restart in the workspace folder:

```
<workspace>/
  chat.md                    primary agent '0' transcript (reply lines + status)
  chat-N.md                  peer agent transcripts
  .blitzos/
    workspace.json           workspace state record
    state.json               runtime journal: pid + heartbeat + clean/unclean marker
    terminals/<id>/          tmux-backed, resumable terminal transcripts
    onboarding/              scan.json, context.md (the agent's context primer)
    workflows/<runId>/       workflow run state + result.json
```

- **Crash detection:** `state.json` is the runtime journal. A boot after an unclean shutdown
  announces the crash to the human (a chat line) and the agent (a `trigger:'system'` moment),
  enriched from macOS diagnostic reports when possible. `markClean` runs **last** on quit —
  "clean" means state was flushed first.
- **One instance per machine** (single-instance lock; a second launch focuses the first). Two
  hosts on one workspace root are detected via the journal's pid + heartbeat.
- Runtime-only panels (chat / terminal / inbox) are reconstructed on boot, not persisted as
  separate records.

> V1 targets **one implicit workspace** (no UI switcher, no `switch_workspace` tool), though
> the multi-workspace machinery still exists underneath.

---

## 7. Native helpers (`native/`)

Small Swift helpers, each a self-contained bundle with its own `build.sh`:

- **`native/notch-geometry`** — reports the physical notch shape / position so the renderer
  can clip the overlay to the real pill and the hit-window can sit over it.
- **`native/island-helper`** — the island overlay support helper.
- **`native/computer-use-helper`** — the backend for window (computer-use) connections,
  shipped as a separate Developer-ID-signed app, `BlitzComputerUse.app`. It is run as a
  background `LSUIElement`. The key design point: macOS **Accessibility** and **Screen
  Recording** permission grants would force the granted app to quit + reopen to take effect,
  which would be fatal mid-session if they lived on BlitzOS itself. So they live on this
  helper instead. The helper is launched via **LaunchServices** (`open -n`), which makes it
  its own *responsible process* with its own permission identity (a process we directly
  spawned would inherit BlitzOS's identity). IPC is a Unix socket BlitzOS owns plus
  newline-delimited JSON; liveness is the socket; "quit & reopen for the grant to take effect"
  relaunches the **helper**, leaving BlitzOS untouched. The lifecycle (install, supervise,
  RPC, relaunch-for-grant) lives in `src/main/computer-use-helper.ts`.

> The permission-identity separation is only real in a **signed, packaged** build; in dev you
> can verify the build / launch / socket / relaunch mechanics but not the identity split.

---

## 8. Ancillary services

These ship in the repo but run as their own deployables, separate from the desktop app.

### `registry-server/` — the Connection Tool Registry

A first-party registry of **vetted, pre-built connection tools** for known sources (e.g.
common web apps). When the agent connects a tab, the registry's tools surface as
`registryTools` so the agent can adopt a ready-made op instead of deriving JS from scratch.
The production transport is a Cloudflare Worker (`worker.mjs`); `server.mjs` is the
**local-dev** Node HTTP transport over the same router core + data (no parallel
implementation). Point BlitzOS at a local instance with
`BLITZ_TOOL_REGISTRY_URL=http://127.0.0.1:7700`.

```
registry-server/
  registry-core.mjs   the shared router
  registry-data.mjs   vetted sources + endpoints
  worker.mjs          Cloudflare Worker transport (prod)
  server.mjs          Node HTTP transport (local dev)
  tools/              per-source tool definitions (e.g. github.com.json)
```

### `telemetry/` — opt-in session telemetry backend

A Cloudflare Worker that ingests session metadata, gzipped event-log segments, and screen
frames into object storage, and serves a key-gated dashboard. All data routes are gated by an
ingest key.

### `site/` — the landing page

The static marketing / landing page (`index.html` + logo), styled with the BlitzOS island
design tokens.

---

## 9. File / layout map

```
src/main/                    Electron main (Node)
  index.ts                   the one BrowserWindow, notch overlay, boot-task seam, wiring
  notch-overlay.ts           the dynamic-island overlay window + the notch hit-window
  osActions.ts               control plane: IPC mutations + getState, live-WebContents registry
  control-server.ts          localhost HTTP control API (trusted; mints session.json)
  agentSocket.ts             relay client (remote agent path) → osActions
  os-tools.mjs               THE one shared agent-tool registry (all transports)
  electron-os-tools.ts       binds os-tools to the Electron ops
  events.ts                  perception kernel (Electron)
  perception-core.mjs        shared perception core + supervisor tick
  agent-runtime.mjs          managed-agent backend + boot-task seam
  terminal-manager.mjs       tmux-backed terminals
  connection-ops.mjs         connection tool-provider core
  connection-tab-link.mjs    Chrome tab connection
  connection-safari-link.mjs Safari tab connection
  connection-window-link.ts  macOS window connection (drives the computer-use helper)
  connection-install.ts      force-installs the connector extension
  computer-use-helper.ts     lifecycle for BlitzComputerUse.app
  persistence.ts             the .blitzos journal
  blitzos-*.md               the runtime agent's duty docs (read on connect)

src/preload/index.ts         contextBridge api: onAction, sendState, onAgentSocketUrl, notch.*

src/renderer/src/
  App.tsx                    notch wiring + body-portal of the island (no canvas render)
  notch/                     THE island UI (NotchHost / IslandHome / IslandPanel / ChatInput /
                             AttachPanel + supporting stores and styles)
  tokens.css                 design tokens
  components/                shared renderer components (ConnectPicker, Icons, …)

native/
  notch-geometry/            Swift: physical notch shape/position
  island-helper/             Swift: island overlay support
  computer-use-helper/       Swift: BlitzComputerUse.app (holds AX + Screen Recording grants)

extension/                   the BlitzOS Connector browser extension (manifest, service worker)

registry-server/             the Connection Tool Registry (Worker + local Node transport)
telemetry/                   opt-in session telemetry backend (Cloudflare Worker)
site/                        the landing page
vendor/agent-socket-sdk/     vendored agent-socket SDK (ESM; bundled into main)
```

---

## Key invariants for contributors

- **The island is the whole UI.** Don't reintroduce a canvas, surfaces, windows-on-a-plane, a
  dock, or a workspace switcher. V1 is island-only.
- **One control plane.** All OS mutations go through `osActions`; the renderer mirrors state
  back so reads are truthful.
- **One tool registry.** Add or change agent tools in `os-tools.mjs` once; transports inherit.
- **Perception is content-agnostic; the agent is the policy.** Never hand-build a per-task
  watch loop or per-task significance heuristic in BlitzOS.
- **Effect-verified acts.** A `connection_act` (or saved act tool) that does not return its
  observed effect is a silent no-op — re-derive the selector rather than trusting stale output.
- **Permission identity lives on the helper, not BlitzOS.** TCC grants are held by
  `BlitzComputerUse.app` so a "quit & reopen for the grant" never disrupts BlitzOS.

For working conventions (state management, design tokens, build gates, the SDK bundling
rules), see `CLAUDE.md`.
