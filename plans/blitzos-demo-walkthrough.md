# BlitzOS — live demo walkthrough

A verified tour of what the app does **today**, captured by driving the running dev app. Companion to
`blitzos-feature-inventory.md` (the full DONE/PARTIAL/PLANNED map). Every step below was executed live against
the running app on 2026-06-22 via the localhost control API and/or the island UI; screenshots are real captures,
and where a feature is control-verified rather than pixel-captured that is stated plainly.

**The app is seeded and ALIVE right now** — open the island (⌥Space) and you'll see the state described here:
a custom theme, a connected Google-Doc tab with banked + registry tools, two completed workflow boards, a
terminal, and a blitz.dev deliverable. This doc is the guide; the running app is the demo.

How it was driven: localhost control server (`POST $url/<tool>` with the bearer token from the dev log),
plus CGEvent mouse/keys for the island gestures. Screenshots in `plans/demo-assets/`.

---

## The story in one line
BlitzOS is a macOS **dynamic-island** shell over a real **multi-agent OS runtime**: you talk to it in the
notch, it spawns/*drives* agents, works your **real logged-in apps** through connections, runs **orchestrated
workflows** with a live board, runs **terminals**, and ships **blitz.dev deliverables** — all from one pill.

---

## 1. The island shell  → `demo-assets/01-island-home-grid.png`
**Gesture:** ⌥Space (global shortcut → `os:notch-toggle`).
**What you see:** the notch expands into the black chassis — the **home grid** with the one functional V1
widget, **Chat** (blue bubble), an **agent rail** on the right ("No active agents" when idle), and a settings
gear. This is the whole V1 UI: no canvas, no windows — just the island. *Works; captured live.*

## 2. Multi-agent session + composer  → `demo-assets/02-session-composer-multiagent.png`
**Gesture:** click **Chat** → the session view.
**What you see:** the **tab strip** — a pen (new-session) + one tab per agent: **Main / Agent 1 / Agent 2**,
each with a gradient avatar and a status dot — the **+** attach button, and the **"Ask Blitz, or describe a
task"** composer. Multiple independent agents, each its own chat thread. *Works; captured live.*

## 3. Chat transcript + steer  → `demo-assets/03-chat-transcript.png`
**Gesture:** click the **Main** tab.
**What you see:** the agent's **iMessage-style transcript** (real history), an **idle** status line, a
**Steer this agent…** bar, a **Details** expand (raw tool rows), and the **+** attach. Markdown renders safely
(react-markdown + remark-gfm). *Works; captured live.*

## 4. Live theming
**Action:** `set_theme {accent:"#e31c30"}` → `{ok:true}`.
**Result:** the OS accent recolors instantly across the chrome and persists. *Works; control-verified.*

## 5. Connections — work your real logged-in apps
**Actions (all returned ok against the running app):**
- `connection_connect_tab {tabId:"safari:1:1"}` → connected the real Safari **Google Doc** tab (`conn_…`,
  signed in as the user) — no API tokens, the logged-in browser IS the integration.
- `connection_registry_add {name:"rename_doc"}` → installed a **vetted registry tool** into the source's
  `tools.json` (`{ok, version, count}`).
- `connection_save_tool {name:"word_count", …}` → banked a bespoke per-source tool.
- `connection_list` now shows `docs.google.com` with **savedTools: [rename_doc, word_count]** + the same set
  surfaced as `registryTools` in the connect briefing.
*Works; control-verified. (Earlier this session, `rename_doc` was run live and renamed the real Doc in ~0.3s.)*
**Honest note:** the registry only lights up when `BLITZ_TOOL_REGISTRY_URL` is set (it is, for this demo, →
the local registry server on :7700); undeployed, it's dark. Chrome's `run_js` needs Developer mode; Safari acts
via Apple Events.

## 6. Orchestrated workflows + the kanban board
**Action:** `run_workflow {file:"…/wf-demo.js", agent:"0"}` → `{ok, runId}` (ran twice).
**Result:** two real workflows completed — a parallel fan-out of 4 "coiner" leaves → 1 judge — producing
`.blitzos/workflows/<runId>/result.json`:
- run 1 → ideas [Nook, Mindwhisper, Zenith, Forge] → **pick: Nook** (5 calls).
- run 2 → → **pick: Anchor**.
*The runtime works; control-verified.* **Honest note:** the **inline kanban board** renders for a workflow an
agent launches through its own live loop; a board for a run triggered externally via the control API on an idle
agent does not bind to the chat UI — so the board is not in the screenshots here. To see it live: open Main,
ask the agent to run a workflow, and watch the phase columns fill.

## 7. Terminals
**Actions:** `open_terminal {title:"demo shell"}` → a real tmux-backed terminal; `send_to_terminal
{data:"echo … && sw_vers … && date\n"}` → ran it.
**Result:** a persistent terminal (survives app restart) with real output. *Works; control-verified.*

## 8. blitz.dev deliverables
**Action:** `new_app {slug:"blitz-demo-notes-…"}`.
**Result:** provisioned a live app → **https://blitz-demo-notes-9854.app.blitz.dev** (real, claimable). The
agent builds anything the user will keep/ship as a real deployed app. *Works; control-verified (network).*

## 9. Under the hood (not pixel-demoable, but real + tested)
- **Perception/wake loop** — agents are woken by coalesced `/events` moments, not polled (test-perception-scope;
  the `wait.sh` CPU-spin fix landed this session).
- **Agent resilience** — tmux supervision + session resume across restart, Haiku auto-naming, narrator
  milestones, wake-watchdog self-healing, full process-tree teardown (the zombie-kill fix landed this session).
- **Onboarding** — a chat-only interview (≤4 choice cards) + pre-board TCC permissions.
- **Persistence/safety** — single Home workspace persists; crash announce on boot; permission/consent prompts
  remembered per origin; downloads land in the workspace.
- **Prod** — CI builds + OTA "Restart Now" updates.

---

## What's captured vs verified vs left
- **Pixel-captured live:** the island shell, home grid, multi-agent tab strip, composer, chat transcript+steer.
- **Control-API verified (real, this run):** theme, connection+tools+registry, two workflow runs, terminal,
  deliverable.
- **Honest gaps** (see `blitzos-feature-inventory.md` for the full list): registry is dark unless the env var is
  set; the inline kanban board needs the agent-driven path; relay-driven agents are slower/flakier than the
  localhost path; force-install is MDM-only; Opt+Space restores the last view (not a forced new session); the
  Peek toggle button is commented out; JSX widgets / MCP connections / CDP browser are PLANNED.

## Re-run it yourself
The app is seeded now — ⌥Space, click Chat, click Main, and you'll see the transcript; the connection +
workflow results are on disk. To drive it fresh: the control token is in `/tmp/blitzos-dev.log`
(`local control API`), and `node scripts/agent-trace.mjs --replay` shows any agent's tool timeline.
