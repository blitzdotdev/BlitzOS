# BlitzOS

A macOS dynamic island (the notch) that turns any AI agent into an autonomous one — with zero per-task code.

BlitzOS is an Electron app whose entire UI lives in the notch. A black pill opens into a chat-first chassis where you talk to an agent, and the agent talks back. What makes it an *OS for an agent* (rather than just a chat window) is the runtime underneath: the agent is given a set of syscalls (hands), a content-agnostic perception stream (eyes), and a scheduler that wakes it when something material happens. The agent supplies the intelligence; BlitzOS supplies the loop. Connect Claude Code (or any tool-capable agent) over the [agent-socket](https://agentsocket.dev) relay or the localhost control API, and it can drive your real browser, native apps, terminals, and workflows on your behalf.

This is V1: **island-only**. There is no canvas, no infinite plane, no desktop — the notch is the whole interface, and the one functional widget it ships is Chat.

## How it works

- **The dynamic island.** A pill at the notch opens on hover or `⌥Space`. Hover shows a home grid of widget icons (V1 = one Chat icon); `⌥Space` shows/hides the island, restoring your last view. Chat is the agent session UI: a tab strip (one tab per live agent, plus a pen to spawn a new one), an iMessage-style transcript interleaved with the agent's plain milestone steps, a live status line, a steer bar, a "Details" expand for raw tool rows, and a "+" panel for connections.
- **Agent runtime: perception → moments → wake.** Raw world signals (a chat message, your connected browser changing, a terminal exiting, a crash on relaunch) funnel through a coalescer that batches them into *moments* — framed snapshots emitted on a cadence or immediately on a significant transition. The agent runs ONE loop and is *woken* per moment, never per keystroke. Perception is deliberately dumb-but-rich: it never decides what matters; the agent's policy does. That is the whole point — a new task (coach my chess, draft this email, summarize this PDF) needs no new BlitzOS code.
- **Connections to your real apps.** The agent acts inside your own accounts by driving what you connect: a Chrome/Safari tab (via the BlitzOS Connector extension) or any macOS app window (via a separately signed computer-use helper). Your logged-in browser *is* the integration — there is no token API and no BlitzOS-owned web view. Each connection is a per-source tool provider (read DOM/AX/screenshot, click/type by reference, run JS in a tab, and persist derived tools).
- **Syscalls.** The agent's tools are defined once and shared across all transports: talk to the user (`say`/`ask`), the wake loop (`/events`), peer agents (`spawn`/`steer`/`close`), real tmux terminals, blitzscript workflows, a human action-items inbox, the connection family, and provisioning a real deliverable.

## macOS only

BlitzOS is macOS-only. It depends on the system notch geometry, macOS accessibility/screen-recording (TCC) for computer use, and LaunchServices behavior. It does not run on Linux or Windows.

## Prerequisites

- **macOS on Apple Silicon (arm64).** BlitzOS is arm64-oriented — the bundled `tmux` (which backs the agent's terminals) is arm64-only.
- **Node ≥ 20**, via [nvm](https://github.com/nvm-sh/nvm) (source it in your shell first). `EBADENGINE` warnings on Node 20 during install are benign.
- **Xcode command-line tools** — `xcode-select --install` (for `swiftc`). `predev` builds the native Swift helpers; without them the notch hit-window and the computer-use helper are skipped.
- **An agent CLI on your `PATH`** for the built-in/managed agent: `claude` (Claude Code) or `codex`. Without one, onboarding dead-ends with "no agent backend is available" (see [Agent paths](#agent-paths)).

## Quick start

```bash
npm install
npm run dev      # electron-vite dev — the island GUI (macOS only)
npm run build    # build main + preload + renderer to out/
npm run check    # typecheck + parity + build — the green-it gate
```

### Agent paths

There are two ways to put an agent behind the island:

- **Managed-local agent.** BlitzOS launches an agent for you in a tmux terminal — this is what onboarding uses. It needs the `claude` (or `codex`) CLI on your `PATH`; without it you'll get "no agent backend is available". Pick the runtime with `BLITZ_AGENT_RUNTIME` (`claude` default, or `codex`).
- **External agent over the relay.** `npm run dev` prints an agent-socket paste URL **to the console** (the line `[agent-socket] paste this into an AI chat to drive BlitzOS:`). Paste that URL into any tool-capable agent (e.g. Claude Code) and ask it to act; it drives BlitzOS over the agent-socket relay as plain HTTP/JSON — no MCP. There is no in-app "Connect AI" button.

Both the relay URL and a localhost control-API URL + bearer token are also written to `~/.blitzos/session.json` (`local = { url, token }`); the console prints the localhost line too (`[blitzos] local control API: …  token=…`). A co-located agent reads `session.json` for the trusted localhost control server instead of the relay.

To package a `.app`:

```bash
npm run dist     # signed + notarized when Apple credentials are present
```

## Features

- Dynamic-island UI clipped to the macOS notch; chat-first agent session with tabs, transcript, status, and steer.
- Agent runtime with content-agnostic perception, coalesced wake moments, and a status-only supervisor tick.
- Connections: drive your real Chrome/Safari tab or any macOS window; effect-verified actions (an act returns the observed effect).
- Real tmux-backed terminals the agent can open, write to, read, and resume.
- blitzscript workflows and a human action-items inbox.
- Multiple peer agents (spawn / steer / close / rename), with a primary supervisor agent.
- Chat-only onboarding (no setup board) driven by a boot-task seam.
- Crash-aware kernel: an unclean shutdown is announced to both the human and the agent on next launch.

## Environment variables

Most behavior works out of the box; these tune it. Copy `.env.example` to `.env` for local overrides — that file is the full, authoritative list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BLITZ_AGENT_RUNTIME` | `claude` | Which runtime drives managed agents: `claude` (Claude Code) or `codex`. |
| `AGENT_SOCKET_RELAY` | `https://agentsocket.dev` | agent-socket relay URL for the external-agent path. |
| `BLITZ_TELEMETRY` | off | Session telemetry is **OFF by default** — it stays disabled unless `~/.blitzos/telemetry.json` exists (`{url, key}`). It captures screen-frame JPEGs + events, so it is strictly opt-in. Set `BLITZ_TELEMETRY=0` to hard-disable. |

`ONBOARDING_MODE` is **not** an env var — it's a build-time constant in `src/renderer/src/onboarding/config.ts`.

## Testing

`npm test` runs the aggregate test runner (`scripts/run-tests.mjs`), which executes every dependency-light `scripts/**/test-*.mjs` harness (a few that need a signed native helper or a running server are skipped). `npm run check` (typecheck + parity + build) is the green-it gate. To run a single harness, invoke it directly, e.g. `node scripts/tests/test-root-state.mjs`.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — the island, control plane, syscalls, perception/wake, connections, and computer-use helper.
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, conventions, and how to send changes.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities.

## License

BlitzOS is licensed under the [Apache License 2.0](LICENSE). Third-party dependency licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The BlitzOS name and logo are trademarks and are **not** licensed under Apache-2.0. You may build on the code, but the project name and logo may not be used to endorse or brand derived works without permission.
