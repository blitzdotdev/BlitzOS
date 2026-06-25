# Contributing to BlitzOS

Thanks for your interest in BlitzOS — an Electron macOS AI-agent OS rendered as a
**dynamic island** (the notch). This guide covers how to set up the project, the
conventions we hold to, and what we expect in a pull request.

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0](./LICENSE) license.

---

## What BlitzOS is (so your change fits)

V1 is **island-only**: a black pill at the macOS notch that opens — on hover or
⌥Space — into the whole UI. **The island IS the UI.** There is no canvas, no
infinite plane, no surfaces, no pan/zoom, no dock or sidebar. V1 ships exactly
one functional widget, **Chat** (the agent session UI), flanked by placeholders.

BlitzOS is an *OS for an agent*: it turns any connected agent into an autonomous
one with zero per-task code. It supplies the loop (syscalls, a content-agnostic
perception stream, a scheduler that wakes the agent on coalesced "moments", and
the agent as swappable policy); the agent supplies the intelligence. The guiding
principle is out-of-distribution generalization — **never hand-build a per-task
watch loop or per-task detection.** Keep perception dumb-but-rich and let the
agent's policy decide what matters. See `CLAUDE.md` for the full architecture.

---

## Prerequisites

- **macOS.** BlitzOS is a macOS app (notch overlay, native helpers, TCC). It will
  not run on Linux/Windows.
- **Node via nvm.** Use [nvm](https://github.com/nvm-sh/nvm) to install/manage
  Node; source nvm in each shell before running `node`/`npm`. A current LTS Node
  works.
- **Xcode / Command Line Tools.** Required to build the native helpers (the
  notch-geometry shim and the computer-use helper). `xcode-select --install` at a
  minimum.

---

## Setup

```bash
npm install
npm run dev        # electron-vite dev — launches the GUI (macOS only)
```

`npm run dev` runs a `predev` step that ensures the native helpers are built
before Electron starts. On first launch the app boots into the onboarding flow
(an agent chat); see `CLAUDE.md` for how onboarding works.

There is **no display in CI / headless sandboxes**, so the GUI can't be seen
there. To verify behavior without a display, launch dev with logging
(`npm run dev > /tmp/aos.log 2>&1`) and read the log for `did-finish-load`, the
printed control-API token, and the agent-socket paste URL; then drive the app
via the control API or agent-socket tools and check `list_state`. Never claim the
pixels look right — that is the user's to confirm.

---

## Commands

```bash
npm run dev        # electron-vite dev (the GUI; macOS only)
npm run build      # electron-vite build → main + preload + renderer into out/
npm run typecheck  # tsc --noEmit -p tsconfig.json
npm run parity     # scripts/check-parity.mjs (cross-transport tool-registry parity)
npm run check      # typecheck + parity + build — the green-it gate (see below)
npm run dist       # package the .app (signed + notarized when Apple creds present)
```

### The green-it gate

Before you open or update a PR, **`npm run check` must pass.** It runs, in order:

1. `npm run typecheck` — `tsc --noEmit`, the whole project must type-check.
2. `npm run parity` — `scripts/check-parity.mjs`, which verifies the agent-tool
   registry is consistent across its transports (see "Agent tools" below).
3. `npm run build` — a full electron-vite build of main + preload + renderer.

If any step fails, the change is not done.

### Tests

Tests are **plain-node** scripts (no GPU, no display) and most run with just
`node`:

```bash
node scripts/tests/test-root-state.mjs
node scripts/tests/test-popup-policy.mjs
node scripts/test-notch-hit-window.mjs
```

There are many focused test scripts under `scripts/` and `scripts/tests/`
covering the perception kernel, workflows, connections, the popup/consent
policy, the notch hit-window, and more. Run the ones relevant to your change.
A few require **native helpers** (e.g. the computer-use helper:
`node scripts/tests/test-computer-use-helper.mjs`) or **network** access; those
won't pass in a fully isolated sandbox, which is expected. Note that TCC identity
separation for the computer-use helper is only real in a signed packaged build;
in dev these tests verify the build/launch/socket/relaunch mechanics only.

---

## Key conventions

These are the ones contributions get bounced on most often. Read `CLAUDE.md` for
the complete list.

### NO new zustand — use the external-store pattern

Do **not** add zustand for any new state (it is unoptimized). For state that must
live outside a component (shared, or surviving a remount), write a tiny
module-level external store plus `useSyncExternalStore`. The reference pattern is
`src/renderer/src/notch/stagingStore.ts`:

- a module-level `let` holding the data,
- a `Set` of listeners,
- mutator fns that replace **only** the changed slice (so `getSnapshot` returns a
  stable reference and only the affected subscribers re-render),
- a `useX()` hook wrapping `useSyncExternalStore`.

The legacy canvas store (`src/renderer/src/store.ts`) is the only zustand store
and is being phased out — do not extend it or copy it. And never persist UI state
by mirroring it into a remounting component (seed-on-mount + write-through is
fragile); put it in a store that never remounts.

### The island IS the UI — no canvas

The canvas (infinite plane, surfaces, camera, dock, sidebar, overview, radial
menu, folders) was cut in V1 and is gone from this branch. Don't re-introduce a
canvas concept. New UI belongs in the island tree under
`src/renderer/src/notch/`, which is canvas-independent.

### Design tokens, no AI slop

UI you build (the island chassis, the home grid, the session/chat UI) must match
the real BlitzOS design. Read the design tokens at
`src/renderer/src/tokens.css` and use them — don't hardcode colors/spacing. When
you fix a visual flaw, fix **every** instance (all corners, all overflow, all
intersecting chrome), not only the one called out.

### Agent tools are defined ONCE

Every agent syscall is defined a single time in `src/main/os-tools.mjs`
(`makeOsTools(ops)`) — the one shared registry for all transports (agent-socket
relay, localhost control server, and the server backend). To add or change a
tool, edit `os-tools.mjs` once; `npm run parity` enforces consistency across the
transports. The agent↔OS contract is plain HTTP/JSON, **not MCP** (deliberate).

### Generalization over per-task code

Perception is content-agnostic: raw signals coalesce into **moments** that wake
the agent, and the agent decides significance and action. Do not add per-task
detection or per-task watch loops to BlitzOS (e.g. no "game over" logic, no
threshold heuristics in the supervisor tick). Keep perception and wake general.

### Don't break load-bearing heuristics

A few small behaviors are intentionally fragile and have been silently dropped by
merges before — preserve them if you touch the surrounding code. The most cited
is the **attach-close hold** in `src/renderer/src/App.tsx`
(`NOTCH_ATTACH_CLOSE_HOLD_MS`): when the attach panel closes, the island is held
open ~1.5s so it never yanks shut under the user. See `CLAUDE.md` "Gotchas" for
the others.

### Never commit secrets

`node_modules/`, `out/`, and `release/` are gitignored. Verify a clean diff
before any commit — no tokens, no credentials, no personal paths.

---

## Project layout

```
src/main/        Electron main (Node)
  index.ts            the one BrowserWindow, notch overlay, boot-task seam, wiring
  notch-overlay.ts    the dynamic-island overlay window + the notch hit-window
  osActions.ts        control plane: IPC mutations + getState, live-WebContents registry
  control-server.ts   localhost HTTP control API (trusted local-agent path)
  agentSocket.ts      connects to the agent-socket relay (remote agent path)
  os-tools.mjs        THE one shared agent-tool registry (all transports)
  agent-runtime.mjs / terminal-manager.mjs   managed-agent backends + tmux terminals
  events.ts / perception-core.mjs            the perception kernel → moments → wake
  blitzos-agents.md   the runtime agent's island doctrine
src/preload/index.ts  contextBridge api: onAction, sendState, onAgentSocketUrl, notch.*
src/renderer/src/
  App.tsx          the notch wiring + body-portal of the island; NO canvas render
  notch/           THE island UI: NotchHost / IslandHome / IslandPanel / ChatInput / AttachPanel
  tokens.css       design tokens
  store.ts         legacy zustand (being phased out — do not extend)
extension/         the BlitzOS Connector browser extension (connections)
native/            native helpers (notch geometry, computer-use helper)
scripts/           dev + build scripts and plain-node tests (scripts/tests/)
site/              the public site
telemetry/         telemetry service
registry-server/   the registry server
vendor/            vendored dependencies (e.g. the agent-socket SDK)
```

---

## Pull requests

- **Branch off the default branch.** Don't commit directly to it.
- **`npm run check` is green** (typecheck + parity + build), and the test scripts
  relevant to your change pass.
- **Keep PRs focused.** One concern per PR; explain the *why*, not just the
  *what*.
- **Match existing conventions** — especially the external-store pattern, design
  tokens, and the single-source tool registry.
- **No secrets, no generated artifacts** (`out/`, `release/`, `node_modules/`) in
  the diff.
- **Describe how you verified** the change. Since the GUI can't be seen in CI,
  say what you ran (which test scripts, what you observed in the dev log or via
  `list_state`).

Welcome aboard, and thank you for contributing to BlitzOS.
