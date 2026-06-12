# Terminal / Agent rename (DEEP) — authoritative plan + mapping

User decisions (locked):
- **Model:** ONE primitive — a **Terminal** (a program in a tmux window). An **Agent** = a Terminal running `claude` + its chat widget + auto-restart supervision. Agents run *inside* a terminal; they are not a separate thing.
- **Depth:** DEEP — rename code identifiers, files, on-disk layout, and `meta.kind` too (not just the UI). With a safe one-time migration of existing workspaces.
- Retire the word **"session"** from the BlitzOS-terminal namespace everywhere it's ours.

## EXCLUDED — three foreign "session" namespaces (DO NOT rename)
A blanket find/replace MUST NOT touch these:
1. **CDP** — `sessionId`/`CdpSession`/`controlSession`/`host.session(id)`/`RemoteCdpSession` in `control-core.{mjs,d.mts}`, `browser-host.mjs`, `cdp.ts`, `test-server-browser.mjs`, and the CDP attach boilerplate in every `drive-*.mjs`/`shot.mjs`/`probe-render.mjs`. Chrome DevTools Protocol term.
2. **Electron `session` API** — `persistence.ts` (`import {session, Session}`, `defaultSession`, `fromPartition`, `flushStorageData`, localStorage/sessionStorage). Browser/login sessions.
3. **External contracts** — `~/.blitzos/session.json` + `sessionFile.ts` (app connection-state discovery file, read by local agents + named in the manual); the agent-socket SDK `session` object in `relay.mjs`; claude CLI `--session-id`/`--resume` + the persisted `claudeSessionId`/`claudeEstablished` meta keys (claude's API — rename = lose `--resume` continuity / crash-loop). The POSIX process-session wording in `start-all.sh` (`setsid`).

Also keep: the **tmux** session name (`SESSION='blitz'`, one tmux session holding one window per terminal) — that's tmux's own term; only the BlitzOS `sessions` Map/wording inside `tmux-host.mjs` is ours.
The agent **chat** files (`chat.md`, `chat-<id>.md`, `blitz-chat.html`, `blitz-<id>-chat.html`) keep their names — "chat" is not "session", and keeping them means zero migration for the transcript/widget files.

## Identifier mapping (BlitzOS-session → terminal/agent)

### Files (git mv + update all imports)
- `src/main/session-manager.mjs` (+`.d.mts`) → `terminal-manager.mjs`
- `src/main/session-ops.mjs` (+`.d.mts`) → `terminal-ops.mjs`
- `src/main/agent-session.mjs` (+`.d.mts`) → `agent-runtime.mjs`
- `src/renderer/src/sessionStream.ts` → `terminalStream.ts`
- `src/renderer/src/components/SessionTerminal.tsx` → `TerminalView.tsx`
- `src/renderer/src/components/SessionsPanel.tsx` → `RuntimePanel.tsx` (lists Terminals + Agents)
- `scripts/drive-sessions.mjs` → `drive-terminals.mjs`

### Core engine (terminal-manager / terminal-ops)
- `createSessionManager`→`createTerminalManager`; `makeSessionOps`→`makeTerminalOps`
- types: `SessionManager`→`TerminalManager`, `SessionMeta`→`TerminalMeta`, `SessionKind`→`TerminalKind`, `SessionStatus`→`TerminalStatus`, `SpawnSessionOpts`→`SpawnTerminalOpts`, `SessionEvent`→`TerminalEvent`, `SessionManagerDeps`→`TerminalManagerDeps`, `SessionOps`→`TerminalOps`, `SessionOpsDeps`→`TerminalOpsDeps`
- ops/helpers: `spawnSession`→`spawnTerminal`, `sendToSession`→`sendToTerminal`, `resizeSession`→`resizeTerminal`, `readSession`→`readTerminal`, `stopSession`→`stopTerminal`, `restartSession`→`restartTerminal`, `getSession`→`getTerminal`, `listSessions`→`listTerminals`, `isSessionLive`→`isTerminalLive`, `wireSession`→`wireTerminal`
- `sessionsDir`→`terminalsDir`; log tag `[session-ops]`→`[terminal-ops]`
- `tmux-host.mjs`: `sessions` Map→`terminals`; "a session is a real terminal"→"a terminal"; keep `SESSION`/`sessionName` (tmux's).

### meta.kind value
- `'pty'` → **`'terminal'`**. `'agent'` stays. Legacy `'pty'` and legacy `'chat'` tolerated on read (mapped to `'terminal'`/`'agent'`).

### Agent (chat) lifecycle (workspace-host)
- `chatSessionIds`→`agentIds`, `newChatSessionId`→`newAgentId`, `addChatSession`→`addAgent`, `closeChatSession`→`closeAgent`, `renameChatSession`→`renameAgent`, `buildChatSurface`→`buildAgentSurface`, `buildChatSurfaces`→`buildAgentSurfaces`, `maxChatAreaCount`→`maxAgentAreaCount`, `resumeAgentsOnBoot` (keep)
- the threaded chat id param `sessionId`→`agentId`; `areaForSession`→`areaForAgent` (areas-core.mjs + .d.mts)
- `removeChatSessionFiles`→`removeAgentFiles`

### Agent-facing tools (os-tools.mjs) + the manual
| now | → |
|---|---|
| `/spawn_session` (drop the `kind:'agent'` footgun; terminal only) | `/open_terminal` |
| `/send_to_session` | `/send_to_terminal` |
| `/read_session` | `/read_terminal` |
| `/stop_session` | `/close_terminal` |
| `/list_sessions` | `/list_terminals` |
| `/spawn_chat_session` | `/spawn_agent` |
| `/close_chat_session` | `/close_agent` |
| `/rename_chat_session` | `/rename_agent` |
- response shapes `{session}`→`{terminal}`, `{sessions}`→`{terminals}`
- the scope input param **`session`** (which agent/area to act in) → **`agent`** on create_surface/open_window/open_terminal/events/say/customize_widget; `request_action` `sessionId`→`agentId`
- `blitzos-agents.md`: add a **"Terminals & Agents"** section documenting open/list/send/read/close_terminal + spawn/list/message/read/close_agent and the read-the-scrollback loop; fix prose that leaks "session".

### Wire contracts (must flip ATOMICALLY across main+preload+renderer+backend+shim)
- SSE/os:action event types: `session-spawn|-data|-exit|-stop|-remove|-rename` → `terminal-spawn|-data|-exit|-stop` and `agent-remove|-rename` (agent lifecycle events use `agent-`); payload key `session:`→`terminal:`
- Electron IPC: `os:session-*`→`os:terminal-*`; `os:chat-session-spawn`→`os:agent-spawn`, `os:close-chat-session`→`os:close-agent`, `os:rename-chat-session`→`os:rename-agent`
- HTTP routes: `/api/os/session-*`→`/api/os/terminal-*`; `/api/os/chat-session-{spawn,close,rename}`→`/api/os/agent-{spawn,close,rename}`
- preload bridge: `sessionInput/Resize/Read/Spawn/List/Stop/Restart`→`terminal*`; `spawnChatSession`→`spawnAgent`, `closeChatSession`→`closeAgent`, `renameChatSession`→`renameAgent`; `agentos-shim.js` mirrors exactly.

### Renderer
- store: `openSession`→`openTerminal`, `closeChatSession`→`closeAgent`, `renameChatSession`→`renameAgent`; `Surface.sessionId`→`agentId` (chat surfaces) and tab `sessionId`→`terminalId`; reexport `areaForAgent`; `component:'sessions'`→`component:'runtime'`
- types.ts: `Tab.sessionId`→`terminalId`, `Surface.sessionId`→`agentId`
- terminalStream.ts: `pushSessionData`→`pushTerminalData`, `pushSessionExit`→`pushTerminalExit`, `subscribeSession`→`subscribeTerminal`
- CSS: `.sessions-*`→`.runtime-*` (tray), `.session-terminal`→`.terminal-view`
- parity list (`scripts/check-parity.mjs`): `agent-session`→`agent-runtime`, `session-ops`→`terminal-ops` (still 11 cores)

## On-disk migration (per workspace, on host init — BEFORE restore)
- If `.blitzos/terminals/` is missing AND `.blitzos/sessions/` exists → `fs.renameSync(sessions, terminals)` (atomic; same volume).
- On reading each `meta.json`: map `kind:'pty'`→`'terminal'`, `kind:'chat'`→`'agent'` (tolerate + rewrite on next write).
- Unchanged & safe: `.blitzos/tmux/server.sock` + tmux session `'blitz'` + windows named by id (live agents survive); `claudeSessionId`/`claudeEstablished` keys; `chat.md`/`chat-<id>.md`/`blitz-*-chat.html`.

## agent-reads-terminal fix (the original ask — folds in here)
- `serializeStateForAgent` (os-tools.mjs ~30-36): add to the per-surface whitelist — `agentId` (chat surfaces) and, for `component:'terminal'`, a `terminals: (x.tabs||[]).map(t=>({id:t.terminalId,title:t.title}))` array — so a terminal surface in `list_state` advertises which `read_terminal(id)` ids it holds.
- Documented in the new manual section.

## UX redesign (asked: "the ux also")
- Toolbar: **+ Terminal** (shell) · **+ Agent** (claude chat) · **Chat**→relabel *"Go to chat"* (focus only). Never a bare "+ New".
- Tray (RuntimePanel): titled **"Terminals & Agents"**, two labeled groups (Agents / Terminals), each with its own `+`; header "N agents · M terminals". One label per kind (kill "shell"/"pty"); per-kind icon.
- Stop auto-tabbing an agent's raw terminal next to shells (App.tsx ensureTerminalTab): agent's chat is primary; its terminal is opt-in ("Show agent terminal"), badged so it's never mistaken for a shell.
- Destructive verbs: **Stop** (kill, resumable) vs **Delete agent** (the closeAgent teardown — copy: "Delete this agent and its chat + files"). Chat window red light → "Delete agent".
- Every tooltip/copy that says "session" → "terminal"/"agent".

## OUT OF SCOPE (follow-up, not this pass)
- The supervisor-hook refactor (lift agent-only `kind===` branches behind an injected per-terminal supervisor). Keep the renamed `kind` branches for now; do the architecture cleanup separately to bound risk.

## Phased execution (verify each gate; keep live system working)
1. Commit current clean state (checkpoint).
2. Engine: terminal-manager + terminal-ops + agent-runtime + types + **migration**. `npm run typecheck`.
3. Wire contracts (IPC + HTTP + SSE event types + preload + shim) atomically. typecheck.
4. Agent tools rename + `agent` param + `list_state` fix + manual section. typecheck + `check-parity`.
5. Renderer rename + UX (store, App toolbar, RuntimePanel split, TerminalView, terminalStream, css). typecheck + `npm run build`.
6. Scripts + parity list + `drive-terminals.mjs`.
7. Live verify (server): restart; Home `.blitzos/sessions`→`terminals` migration runs; agent 0 `--resume`s + answers; toolbar shows +Terminal/+Agent; tray split; open a bash terminal, type, have the agent `read_terminal` it (PING/PONG); no cross-talk.
8. Commit. (User pushes.)

## Verification gates
`npm run typecheck` · `node scripts/check-parity.mjs` · `npm run build` · live chromium + the read_terminal functional test.

## EXECUTED (2026-06-11) — done + live-verified
Engine+migration → 9 file-owner passes → typecheck/parity/build repair loop (all green). Then a manual seam pass for the runtime `.mjs` mismatches typecheck can't catch:
- backend.mjs serverOps `spawnChatSession/closeChatSession/renameChatSession` → `spawnAgent/closeAgent/renameAgent` (calling `wsHost.{newAgentId,addAgent,closeAgent,renameAgent}`) + the agent-spawn/close/rename routes.
- agent-runtime.mjs bootstrap wire payload `"session":` → `"agent":` (+ instruction `spawn_session`→`open_terminal`, "You are session"→"You are agent").
- osActions.ts `os:user-message` reads `agentId` (was `sessionId`).
- workspace-host.mjs `isRuntimeLike` `component:'sessions'` → `'runtime'`.
- drive-newchat.mjs `spawnChatSession`→`spawnAgent`.
Final sweep: zero stray old identifiers/routes/channels/components remain (only legit excluded `claudeSessionId`/CDP/`sessionFile`/`.blitzos/sessions` migration refs).

Live (server, Home workspace):
- Migration ran lossless: `.blitzos/sessions`→`.blitzos/terminals`; `terminals/0/meta.json` kept `kind:"agent"` + `claudeSessionId` + `claudeEstablished` → agent 0 `--resume`d and answered chat (PONG-RENAME-3321).
- Terminal spawn→write→`read_terminal` returns the marker ✓; `list_terminals` shows `kind:terminal` vs `kind:agent` ✓; manual `## Terminals & Agents` section + tools.json serve `open_terminal/read_terminal/...` ✓.
- UX (chromium): toolbar = Home · **+ Terminal** · **+ Agent** · **Go to chat** · **Terminals & Agents** · Inbox · Connect AI · Agent online. Old `+ New`/`⌗ Terminal`/`▤ Sessions` gone.

NUANCE (not a code defect): the **resumed** agent 0 read the terminal via a `tmux capture-pane` shortcut (it's co-located) and still believes terminals are "not exposed through the surface API" — stale tool knowledge from before the rename. A FRESH agent fetches the updated manual + tools.json and will use `read_terminal`. (If desired, nudge the running agent to re-fetch its manual.)

OUT-OF-SCOPE follow-ups noted: the supervisor-hook refactor; live widget-title update on `agent-rename` (tray already refreshes; chat-widget title not yet); the parked areas→stages / chat-hub merge reconciliation.

## FOLLOW-UP DONE (cleanup + reliable tests, commit `cd19983`)
- **`removeTerminal(id)`** — the missing prune primitive (stop only killed-but-kept a dead "Resume" row; closeAgent left an exited ghost). Kills if live + deletes the `.blitzos/terminals/<id>` record + in-memory entry (id-shape guarded; never '0'). Wired NO-divergence: terminal-manager+terminal-ops(+.d.mts), backend `/api/os/terminal-remove`, Electron `os:terminal-remove`, preload `terminalRemove`, agentos-shim, + a **Remove** button on dead terminal rows in the tray. `closeAgent`'s stopAgent seam now → `removeTerminal` (no ghost).
- **`remove_terminal` agent tool** — TODO/next: expose removeTerminal as an agent-facing tool (mirrors close_terminal=stop) so an agent can prune terminals it spawned for a job; document in blitzos-agents.md.
- **Reliable self-cleaning drive suite** — `scripts/drive-{terminals,newchat,areas,tabs}.mjs` + `verify-real.mjs` all updated to the renamed tools/labels, made flake-free (reset-to-clean-slate, per-title targeting, poll-until-settled, delta assertions) and self-cleaning (each removes what it spawned). All PASS on repeat; Home stays at the primary agent only. typecheck + parity (11) + build green.

## Note on the agent-runtime-moments merge (parked)
The branch independently renamed **areas→"stages"** + moved to a single **chat-hub**. This rename (session→terminal/agent) is orthogonal and will compound that merge. Decide the stages/hub reconciliation separately when we return to the merge.
