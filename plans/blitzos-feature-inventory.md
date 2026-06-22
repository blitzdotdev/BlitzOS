# BlitzOS Feature Inventory

BlitzOS is a v0.0.1 macOS dynamic-island ("notch") shell that runs a mature multi-agent OS runtime. The shipping V1 surface is **chat-only** — no canvas, no spatial board — driven by a transparent notch overlay with a dedicated hit-window. Underneath it, the agent subsystem (tmux-backed terminals, Claude TUI / Codex backends, session resumption, self-healing wake-watchdog, narrator, interrupt detection) is deep and well-tested. Connections (Chrome/Safari tabs, macOS windows) and a per-source tool registry are largely DONE and tested, but the **community tool registry is dark at runtime** (no deploy URL set) and the **registry tests are not in the gate**. Blitzscript workflows + the inline kanban/leaf-drawer UI are DONE and tested. Onboarding ships as a chat-only interview with frontloaded TCC permissions; the "case-file board" is post-V1. Persistence, theming, popup/permission policy, and prod CI/OTA are DONE. The biggest PLANNED/unfinished arcs are the **JSX widget render path** (90% wired, missing the SurfaceFrame branch), the **Job/Task WorkUnit model** (spec-only), **CDP AI-browser**, and **MCP connections** (researched/verified but not integrated). Two adversarial downgrades apply below: **Opt+Space** restores the last view (not a forced new session) and the **Peek toggle button is commented out** (unreachable in the UI).

## Island Shell (V1 UI)

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| Notch overlay (always-visible black pill) | DONE | Launch BlitzOS on a notch Mac | `src/main/notch-overlay.ts`: notchOverlayWindowOptions/applyNotchOverlay/setNotchInteractive; `src/main/index.ts` | Pill is VISUAL ONLY (pointer-events:none); clicks handled by hit-window |
| Notch hit-window (dedicated interactive window over physical notch) | DONE | Notch Mac; auto-places over physical notch | `src/main/notch-overlay.ts`: notchHitWindowOptions/notchHitRect/NOTCH_HIT_HTML; native/notch-geometry | Screen-saver level (relativeLevel 1); no click-through race |
| Hover→home grid | DONE | Hover cursor over the notch pill | `App.tsx`: notchStateRef, scheduleNotchHoverClose (90ms); `IslandHome.tsx` | Keepalive hysteresis 180ms; chassis hover via elementFromPoint + closest('.nh-chassis') |
| Opt+Space→session | **PARTIAL** | Press Opt+Space to toggle the island | `App.tsx` toggleIsland() opens to islandViewRef/islandPageRef | DOWNGRADED: refuted. Code (App.tsx 188-200) restores the LAST view+tab (defaults to home), NOT a forced new-session composer. Docs overclaim "opens straight into a new agent session" |
| Chat transcript + markdown rendering | DONE | Open an agent session | `IslandPanel.tsx` → MarkdownMessage; `MarkdownMessage.tsx` react-markdown + remark-gfm | Safe markdown: skipHtml, external links gated to http/https/mailto |
| Steer bar (live status + archive) | DONE | Open an agent session | `IslandPanel.tsx` .isl-agent-meta/.isl-status/.isl-archive; `workspace-host.mjs` dotStatus | warming/working/waiting/idle; archive non-primary only |
| Details expand (raw tool rows) | DONE | Click "Details" below transcript | `IslandPanel.tsx` detailsOpen → agentDetails(activeId) | Lazy-loaded; read-only labels |
| Settings (debug toggles + archived agents) | DONE | Click gear (top-right of Home) | `NotchHost.tsx` setView('settings'); `IslandSettings.tsx` | DEBUG chrome; archive persists to sessionStorage |
| Peek toggle (collapse chat → board pills) | **PARTIAL** | (intended) Click corner-icon button | `IslandPanel.tsx` peek state + PEEK_IN/PEEK_OUT; `NotchHost.tsx` | DOWNGRADED: refuted. Logic complete but the toggle button is COMMENTED OUT (NotchHost.tsx 885-900, "Peek toggle hidden for now"). Unreachable in UI |
| Workflow kanban board (inline) | DONE | Expand a board pill in a session with active workflows | `IslandKanban.tsx`; `wfReduce.ts`; `IslandLeafDrawer.tsx`; `wfShared.tsx` | Coalesced batch renders avoid O(n²) on 6000-event replay |
| Attach panel (dropbox + connections list) | DONE | Click "+" in composer | `AttachPanel.tsx`; window.agentOS.pick.*; stagingStore/sentTrayStore | Tray freezes on send; new-session tray pins to spawned agent's first message |
| ChatInput (autogrow, Enter=send, draft persist) | DONE | Type in composer | `ChatInput.tsx` autosize + draftStore; isComposing IME guard | Draft survives close/reopen + tab switch; maxHeight 120px |
| IslandHome grid (Chat + agent rail) | DONE | Opt+Space / hover with no session open | `IslandHome.tsx` isl-home-layout + isl-home-agents; agentGradient | Rail shows working/waiting/done; done persists in sessionStorage |
| Terminal pane (DEBUG: open macOS Terminal) | DONE | Settings → "Show active agent terminal" | `IslandTerminalPane.tsx` → terminalOpenExternal(terminalId) | DEBUG only; opens real Terminal on the agent's tmux session |

## BlitzOS Agents Subsystem

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| Multi-agent spawn/close/rename | DONE | /spawn_agent, /close_agent, /rename_agent | os-tools.mjs handlers; terminal-manager.mjs; test-agent-session.mjs (34 assertions) | Primary '0' protected from close |
| Claude TUI backend with session resumption | DONE | spawn_agent (default backend); relaunch resumes | agent-runtime.mjs buildClaudeCommand/ensureClaudeSessionId; meta.json | Established sessions use --resume; primary '0' resumes uniformly (no auto-rotate) |
| Codex serverless backend | DONE | prepareAgentLaunch { runtime:'codex-serverless' } | agent-runtime.mjs buildCodexServerlessCommand; test-agent-session.mjs | `codex exec` one-shot; auto-restart on exit, not mid-turn resumable |
| tmux supervision + restart-resume | DONE | On boot, restore()→adoptExisting | terminal-manager.mjs restartTerminal; tmux-host.mjs adoptExisting | ESTABLISH_MS 8s + ≥5s healthy exit marks established |
| Auto-naming via Haiku | DONE | First user chat line of a spawned agent | chat-titleer.mjs generateAgentTitle; test-chat-titleer.mjs (8 assertions) | Title capped 24 chars, sanitized |
| Narrator milestone summaries | DONE | 60s interval per agent | agent-narrator.mjs startNarrator (haiku, MILESTONE_SCHEMA) | <80 chars, past tense, de-duped; idle agents skip |
| Interrupt detection (mid-turn resume) | DONE | On boot, boot-task calls wasInterrupted(meta) | agent-interrupt.mjs; test-agent-interrupt.mjs (14 assertions) | Claude stop_reason + Codex exit code drive mid-turn vs clean |
| Wake-watchdog self-healing (deaf agents) | DONE | onUndelivered + 25s sweep | agent-wake-watchdog.mjs; test-wake-watchdog.mjs (13 async cases) | Nudge = text + separate Enter (no \r), Claude paste-detection fix |
| Narrator + interrupt + boot-task seam | DONE | Re-read duty on every launch | agent-runtime.mjs setBootTaskProvider/prepareAgentLaunch | Interview uses fast model/low effort; resident uses xhigh |
| Blitzscript orchestrator workflows | DONE | /start_workflow, /run_workflow, /set_orchestrators | os-tools.mjs; agent-runtime.mjs orchestratorBootTask; .blitzos/blitz | run_workflow tracks leaves + wakes agent on completion |
| Session persistence + relay-url handoff | DONE | prepareAgentLaunch writeRelayUrl | agent-runtime.mjs; .blitzos/relay-url, wait.sh re-reads each loop | Self-heals after BlitzOS restart |
| Claude session context clearing (user action) | DONE | clearAgentContext(agentId) | terminal-manager.mjs clearAgentContext | Rotates session UUID; transcript untouched, in-context memory resets |
| Workspace trust dialog suppression | DONE | prepareAgentLaunch → ensureWorkspaceTrusted | agent-runtime.mjs (pre-seeds ~/.claude.json) | Idempotent; prevents unattended-spawn stall |
| Process tree cleanup on teardown (BUG FIX #1) | DONE | removeTerminal/close_agent → host.kill | tmux-host.mjs paneProcessTree + SIGKILL; commit 84c65fa | Reaps detached run_in_background zombies; 3-proc tree verified to 0 |
| wait.sh CPU spin fix (BUG FIX #2) | DONE | wait.sh long-polls /events | agent-runtime.mjs WAIT_SCRIPT; commit 84c65fa | empty-events sleeps 1s; garbage sleeps+retries; only real payload exits |
| Transcript reading (narrator + interrupt) | DONE | narrator.summarizeOne / interrupt detection | agent-transcript.mjs readSessionEvents/lastAssistantStopReason | Parses Claude JSONL, resumable by offset, digests for Haiku |

## Connections & Tool Registry

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| Chrome tab connection via extension | DONE | connection_list_tabs → connection_connect_tab; or click tab in AttachPanel | connection-tab-link.mjs:26-270; extension/sw.js; test-connection-tablink.mjs (12) | run_js gated to ISOLATED world; degrades silently if Chrome Developer mode off |
| Safari tab connection via Apple Events | DONE | connection_connect_tab { browser:'safari' } | connection-safari-link.mjs:74-198; connection-ops.mjs:598-648 | Synchronous `do JavaScript` → no live source-change wake; needs Develop ▸ Allow JS from Apple Events |
| macOS window connection (AX + ScreenCaptureKit) | DONE | connection_list_windows → connection_connect_window | connection-window-link.ts:26-117; computer-use-helper.ts; test-connection-restore.mjs | No run_js for windows (tabs only); AXObserver fires connectionNotify |
| Per-source tools.json save/call/list | DONE | connection_save_tool / call_tool / list_tools | connection-ops.mjs:108-461; test-connections.mjs:158-200 | Per-sourceId (inherited by future connections); path-traversal safe |
| Stale selector detection | DONE | connection_call_tool on a saved act tool | connection-ops.mjs:463-478; test-connections.mjs:207-212 | Reactive-only (no proactive crawl); no upstream telemetry |
| Connection widget representation | DONE | On connect: placeholder srcdoc; on disconnect: reconnect button | connection-ops.mjs:154-315; test-connections.mjs:64-65 | Honest placeholder; dead-widget adoption; cascade stagger |
| Connection boot restore (across restart) | DONE | App boot → connectionRestoreAll | connection-ops.mjs:714-756; test-connection-restore.mjs (6/6) | Idempotent, deduped, preserves agent ownership |
| Connection dedup (re-attach live source) | DONE | connection_connect_tab with already-live tabId | connection-tab-link.mjs:209-244; connection-window-link.ts:52-66 | Last-attacher-wins ownership; no duplicate widget |
| Extension force-install (Chrome MDM) | **PARTIAL** | connection_install_extension (admin prompt) | connection-install.ts:82-110; extension/sw.js:15-32 | WART: MDM-only; per-install token NEVER delivered (WS auth by Origin only, forgeable); run_js needs Developer mode that force-install doesn't enable |
| Chrome run_js (userScripts world) | **PARTIAL** | connection_run_js on a tab connection | extension/sw.js:200-230+; connection-tab-link.mjs:228-235 | WART: silently degrades to capability_unavailable if Developer mode off; no in-product affordance explaining the coupling |
| Connection act (full pointer sequence) | DONE | connection_act { action:'click', selector } | connection-safari-link.mjs:26-72; extension/sw.js:170+ | Full pointerdown/up/click needed for Google Docs/custom widgets |
| Read (tab/window) with cap + scoping | DONE | connection_read (tab {selector} / window {maxDepth, screenshot}) | connection-ops.mjs:26-68/406-416; test-connections.mjs:77-101 | Capped 8192 bytes; structured reads truncate text in place; screenshot as PNG |
| First-party tool registry (routing core) | DONE | GET /v1/tools, /v1/tool, /v1/health | registry-core.mjs:13-36; worker.mjs; server.mjs; test-tool-registry-server.mjs (22) | Read-only HTTP; no community submission path |
| Registry data (seeded tools) | **PARTIAL** | connection_registry_search on mail/docs/github | registry-data.mjs; tools/ (3 sources × ~8 tools) | WART: vettedBy/vettedAt EMPTY for all 8 tools; coverage thin; hand-edited JSON |
| Registry client search/get/add | DONE | connection_registry_search / get / add | connection-ops.mjs:817-867; os-tools.mjs:564-602 | Add cross-source guarded, pins version+contentHash; substring search only |
| Registry dark unless BLITZ_TOOL_REGISTRY_URL set | **BROKEN** | connection_registry_* all return "not configured" | connection-ops.mjs:89/779; os-tools.mjs:89; wrangler.toml no account/route | WART: entire registry + briefing dormant at runtime; no signal it's undeployed vs empty. Fix: wrangler deploy + set env |
| Push-into-briefing (three surfaces) | DONE | On connect/list/registry-warm | connection-ops.mjs:621-637/350-373/805-810 | CURRENTLY DARK (registryTools empty until URL set) |
| Registry tests in gate (npm run check) | **BROKEN** | npm run check | package.json check = typecheck+parity+build only | WART: test-tool-registry-server.mjs (22) NOT run; contract drift ships green. Run manually |
| Rekey on cross-origin nav | DONE | Tab navigates cross-origin | connection-ops.mjs:262-280; connection-tab-link.mjs:145-164; test-connections.mjs:241-251 | Never run site A's tools on site B; Safari has no cross-origin nav event |
| Connection lifecycle (connect/drop/reconnect/restore) | DONE | Full lifecycle | connection-ops.mjs bind/rekey/notify/unbind/drop/restore; test-connections.mjs (89/89) | Complete + tested end-to-end |
| Connections transport guard (localhost vs relay) | DONE | Relay vs localhost agent calls connection tools | os-tools.mjs ctx.transport checks | Per-user opt-in; correct by design, not hidden escalation |
| Image pass-through (screenshot) | DONE | connection_read on window { screenshot:true } | connection-ops.mjs:413-415 | Window vision via ScreenCaptureKit; structured {image}, never base64-text |

## Workflows & Orchestration

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| Blitzscript authoring (workflow DSL) | DONE | Author .js with `export const meta`, top-level await/return, no imports | blitzscript/runtime.mjs:30-66/135-139; examples/ | Determinism shadows on Date.now/Math.random/crypto |
| agent() leaf primitive | DONE | await agent(prompt, {harness,model,schema,...}, fallback?) | blitzscript/agent.mjs:355-523; harnesses.mjs; test-blitz-schema.mjs | Real process; max 8 concurrent; journal-backed resume |
| parallel(thunks) — barrier fan-out | DONE | await parallel([() => agent(...), ...]) | runtime.mjs:150-172; test-blitz-runtime.mjs | Functions not promises; 4096 cap; budget overflow → null |
| pipeline(items, ...stages) | DONE | await pipeline(items, stage1, stage2) | runtime.mjs:177-202; test-blitz-runtime.mjs | Throwing stage drops item to null, skips remaining |
| phase(title) | DONE | phase('Gather') at top level | runtime.mjs:223; test-wf-events.mjs | Kanban shows one row per phase |
| log(message) | DONE | log('status') in body | runtime.mjs:224 | Event stream only, no persistence |
| budget object | DONE | runWorkflow(file,{budget}) / BLITZ_BUDGET | runtime.mjs:210-217; agent.mjs:409-411 | null = unbounded; WorkflowBudgetExceededError on exceed |
| workflow() nested execution (one level) | DONE | await workflow('sub', {args}) | runtime.mjs:285-297 | depth≥1 refused; fresh RunContext |
| RunContext (G4) async-local storage | DONE | runtime.runWorkflow() | agent.mjs:71-133; runtime.mjs:235-280 | AsyncLocalStorage; survives nested runs |
| Journal-backed resume | DONE | blitz run --resume | agent.mjs:94-128; run.mjs | Hash-based fast-forward skips unchanged agent() |
| DRY-RUN preflight | DONE | blitz check / BLITZ_DRY_RUN=1 | agent.mjs:392-399; workflow-host.mjs:112-133 | Instant skeleton; stubFromSchema |
| WfEvent schema (full event stream) | DONE | Any workflow run | progress.mjs; test-wf-events.mjs | Stamped runId+seq+ts |
| run_workflow tool | DONE | POST /run_workflow {file,args?,title?,agent?} | os-tools.mjs:255-268; workflow-host.mjs:51-136; test-run-workflow-tool.mjs | result.json on disk before wake; no widget (island-only) |
| start_workflow tool | DONE | POST /start_workflow {task,...} | os-tools.mjs:239-252; test-blitz-orchestrator.mjs | Spawns peer with orchestrators ON |
| set_orchestrators tool | DONE | POST /set_orchestrators {agent,on?} | os-tools.mjs:271-281 | Persists flag; lays down .blitzos/blitz + orchestrator.md |
| Workflow-bus (per-run buffer, fan-out, hydrate) | DONE | runtime setProgressSink → bus | workflow-bus.mjs; test-wf-bus.mjs; test-wf-store.mjs | 6000-event cap, run:done retained |
| Durable event-sourced boards | DONE | persist on run:done | wf-store.mjs; test-wf-store.mjs | atomicWrite, orphan reconciliation on boot |
| Kanban board (IslandKanban.tsx) | DONE | wf message shows board inline | IslandKanban.tsx; onWfEvent IPC | Coalesces per microtask; frozen on run:done |
| Leaf drawer (Asked/Did/Returned) | DONE | Click a card on the kanban | IslandLeafDrawer.tsx; osReadLeaf IPC | Did = human_summary or text prose |
| Leaf capture to disk | DONE | BLITZ_CAPTURE_LEAVES=1 (default) | agent.mjs:319-331; test-wf-leaf-capture.mjs; index.ts:125 | Always-on V1; guards path traversal |
| Leaf-failure contract (loud vs soft) | DONE | spawn failure vs schema miss | agent.mjs:494-500; runtime.mjs:262-266; test-wf-leaf-failure.mjs | resultKind null/text/object/error |
| Completion wake (run:done → moment) | DONE | run settles → onRunComplete | workflow-host.mjs:99; perception-core.mjs; test-wf-wake.mjs | resultPath on disk before wake (no race) |
| Structured output (schema + retry + summary) | DONE | agent(prompt,{schema}) | schema.mjs; agent.mjs:380-383; harnesses.mjs; test-blitz-schema.mjs | meta.human_summary auto-required |
| Schema validator (JSON-Schema subset) | DONE | validate(value, schema) | schema.mjs:14-82; test-blitz-schema.mjs | Self-contained, no ajv |
| Model alias resolution | DONE | agent(prompt,{model:'cheap'}) | agent.mjs:185-207; capabilities.mjs | caps cache → haiku fallback |
| Leaf metadata block (depth/no-recurse) | DONE | Every agent() call | agent.mjs:173-183 | Depth TOLD not gated |
| applyWfRun upsert rule | DONE | main + renderer fold broadcasts | wf-run-state.mjs; test-wf-run-state.mjs (6 cases) | Late skeleton never un-finishes a run |
| Workflow enrichment | **PARTIAL** | N/A in V1 | workflow-enrichment.mjs:1-16 (no-op exports) | Deferred with widgets post-V1 |
| Orchestrator boot task | DONE | set_orchestrators → writeBlitzShim | agent-runtime.mjs; test-blitz-orchestrator.mjs | Flag carries across spawns |

## Terminals & Perception/Wake Loop

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| Tmux-backed terminals persisting across restart | DONE | Kill/restart app; mgr.restore() re-adopts | terminal-ops.mjs:82; terminal-manager.mjs:287-306; tmux-host.mjs:268-283 | stop() kills client not server; legacy sessions→terminals migration |
| Terminal scrollback buffer (256KB ring) | DONE | read_terminal {id} | tmux-host.mjs:16/91-92; os-tools.mjs:352-358 | Persisted to transcript.jsonl every 500ms |
| Agent /events long-poll (waitForEvents) | DONE | POST /events {since,wait,agent,workspace} | perception-core.mjs:556-574; os-tools.mjs:164-178 | Workspace-pinned; up to 25s; heartbeat per call |
| Moments (coalesced activity batches) | DONE | Activity on a surface | perception-core.mjs:1-11/144-266 | BATCH_MS 15s; trigger types message/tick/action/connection/workflow/system/batch |
| Coalesced significance flush | DONE | nav/idle immediate, select 2.5s debounce | perception-core.mjs:166-191 | Routine click/input ride 15s batch |
| wait.sh blocking event-wait (CPU fix) | DONE | bash .blitzos/wait.sh as bg task | agent-runtime.mjs:315-329; commit 84c65fa | empty=1s sleep, real payload exits, garbage sleeps+retries; re-reads relay-url |
| wait.sh written at every launch | DONE | every agent spawn/restart | agent-runtime.mjs:333-336/244 | Static, overwritten fresh |
| paneProcessTree kill (tree reaping) | DONE | stop/removeTerminal → host.kill | tmux-host.mjs:207-232; commit 84c65fa | SIGKILLs entire tree; verified 3 pids reaped |
| Supervisor tick (material status diff) | DONE | 10s tick interval | perception-core.mjs:389-430 | Emits only on material change (status edge, terminal exit) |
| Perception workspace scoping (v2 bleed fix) | DONE | agent /events with workspace param | perception-core.mjs:32-80/212-214/556; test-perception-scope.mjs | Moment stamped at emission; prevents cross-workspace bleed |
| Perception event reminders | DONE | every /events response | perception-core.mjs:29-30; os-tools.mjs:177 | "no canvas, reply in chat" orientation |
| Terminal list/status (live + persisted) | DONE | list_terminals | terminal-manager.mjs:317-328; os-tools.mjs:336-338 | Merges live Map + disk scan |
| Terminal open/send/read/close/remove tools | DONE | open/send/read/close/remove_terminal | os-tools.mjs:308-378; terminal-ops.mjs:103-127 | close=stop (resumable); remove=delete; primary '0' can't remove |
| say/ask user chat tools | DONE | /say {text,agent}, /ask {prompt,options} | os-tools.mjs:180-193/319-333; osActions.ts | ask fences ```blitz-ui JSON for renderer |
| Agent auto-restart on exit with backoff | DONE | managed agent exits | terminal-manager.mjs:145-154 | Resets after 15s healthy; capped 60s |
| Agent context clear (rotate session + restart) | DONE | clearAgentContext(id) | terminal-manager.mjs:266-284 | User action only; transcript stays |

## V1 Onboarding & Blitz.dev Deliverables

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| new_app tool (provision blitz.dev apps) | DONE | /new_app {slug} | os-tools.mjs:150-162/106; blitzos-agents.md §38-43 | Live POST to blitz.dev; claim URL expires 12h; auto-deploy on save |
| Parallel sub-agent orchestrator pattern | DONE | Doctrine: one brief → N apps → N sub-agents in one batch | blitzos-agents.md:33/42; spawn_agent + steer (os-tools.mjs:227-236/196-209) | Coaching pattern in duty doc, not a mechanic |
| Onboarding interview boot task (chat-only) | DONE | First launch → scan → osKickBrain('0') with INTERVIEW_BOOT_TASK | onboarding.ts:570-591; blitzos-interview.md; test-onboarding-restart-anchor.mjs | V1 is CHAT-ONLY — no board, no unlock card; ≤4 MC choice cards |
| Interview restart anchor (profile.md durable state) | DONE | After interview done → refreshRestartAnchor | onboarding.ts:479-527; test-onboarding-restart-anchor.mjs | Persistence bridge; active initiative intentionally NOT persisted |
| Pre-board permission sequence (FDA/A11y/Screen) | DONE | First launch → preboard checklist with drag-grant | onboarding.ts:71-285; OnboardingFlow.tsx:14-88 | TCC on Computer Use helper (separate bundle) avoids quit-reopen trap |
| Scan context primer (context.md) | DONE | preboard done → runScan | onboarding.ts:398-401; scripts/onboarding-scan.mjs | Deterministic (no LLM); working-set is highest signal |
| Interview boot-task seam (handoff to resident) | DONE | agent '0' boots; watchInterviewDone flips → osClearBrainContext('0') | onboarding.ts:570-591; index.ts setBootTaskProvider | Only agent '0' gets a duty; fresh-context re-exec to resident |
| Case-file onboarding board (seeded widgets, unlock card) | PLANNED | N/A — not wired in V1 | plans/archive/onboarding-case-file.md; OnboardingFlow.tsx vestigial comments | Post-V1 (P2). V1 ships preboard → progress bar → chat interview only |

## Workspace / Persistence / Theming / Actions

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| Single Home workspace persistence | DONE | App restores to last-active workspace | workspace.mjs:320-330; workspace-host.mjs:81-88 | No UI switcher in V1; multi-workspace machinery exists but unexposed |
| Restart continuity (state recovery) | DONE | Automatic on restart | workspace.mjs:436-523/764-781/581-607 | Runtime panels persist separately under state/panels.json |
| Crash announce & boot journal | DONE | Automatic on every boot | workspace.mjs:394-430; index.ts:155-165 | Detects clean/dirty(crash)/concurrent(foreign live pid) |
| Live theming (accent + wallpaper) | DONE | set_theme tool → os:action 'set-theme' | theme.ts:29-77; wallpaper.ts:39-70; os-tools.mjs set_theme | Wallpaper best-effort macOS (needs Screen Recording); theme full CSS prop coverage |
| Action items inbox (request/list/resolve) | DONE | request_action / list_actions / resolve_action | action-items.mjs:21-124; workspace-host.mjs:53/112 | File-backed survival; reconciled on hydrate; kinds task/signin/approve/choose/scan/info |
| Consent persistence (widget/provider grants) | DONE | Allow/Block in consent-card | workspace.mjs:609-641; guest-capabilities.ts:127-145; test-consent.mjs | Two-tier: root journal + per-workspace consent.json |
| Popup policy (content-agnostic, no hostname) | DONE | Guest window.open() / link click | popup-policy.mjs:27-41; guest-capabilities.ts:40-69; test-popup-policy.mjs | hidden/window/surface/deny by web semantics only; deniedNav 4s anti-popunder |
| Browser guest session persistence (cookies/auth) | DONE | Automatic (20s flush + before-quit unload) | persistence.ts:73-96; PARTITION persist:agentos | about:blank nav fires unload so sites persist tokens |
| Download interception (files → canvas) | DONE | Download in a web surface | guest-capabilities.ts:76-86/159-170 | Streams to active workspace root; folder watcher picks up |
| Permission prompts (Allow/Block, remembered) | DONE | Guest requests geolocation/notifications/media/etc. | guest-capabilities.ts:127-145; consent-card | Promptable vs auto-allow vs auto-deny lists; optional per-origin remember |

## Planned / Architecture (plans/)

| Feature | Status | How to trigger | Evidence | Note |
|---|---|---|---|---|
| CDP browser integration (AI Chrome, per-agent windows) | PLANNED | N/A | plans/cdp-browser-blitzos-plan.md; manifest.json lacks 'debugger' | No CDP verbs / AI Chrome launcher implemented; cdp.ts is in-window only |
| MCP connections (prefer MCP over injected JS) | **PARTIAL** | N/A (no connect_mcp tool) | plans/blitzos-mcp-connections.md (verified live 2026-06-22); registry-server/ | Detection/auth/import verified end-to-end, but no connection_connect_mcp, no endpoint map, no install/reload machinery in BlitzOS |
| Connection widget non-LLM fast-refresh | PLANNED | N/A | plans/connection-widget-fast-refresh.md; no code markers | Design only; depends on per-connId widget scoping + significance classifier |
| Plan widget (W1 editable job plan) | **PARTIAL** | spawn_widget {name:'plan', props:{...}} | widgets/plan.jsx (315 lines, compiles); widgets.json:119-124 | Widget production-quality; missing WorkUnit spine, planSurfaceId binding, agent duty |
| JSX widgets with Sucrase compilation | **PARTIAL** | create_surface/save_widget {lang:'jsx'} | widget-jsx-core.mjs (237 lines); types.ts lang field; 7 reference JSX widgets | 90% wired (compile/persist/catalog all work); MISSING SurfaceFrame.tsx branch to route lang→jsx render; sucrase dep not in package.json |
| Job/Task WorkUnit model with lifecycle | PLANNED | N/A | plans/blitzos-job-task-model.md (142 lines) | No WorkUnit interface, no .blitzos/work/, no start_job/propose_plan/set_work_status tools |
| Job entrypoints (A/B input shells, menubar, notifications) | **PARTIAL** | Shell B: ⌥Space keybind | plans/blitzos-job-entrypoints.md; launcher.ts (prototype); App.tsx:1047; index.ts globalShortcut | Building blocks scattered; missing NSPanel refactor, A4 Send (needs WorkUnit), Tray/notifications; Alt+Space collides with notch toggle |
| Prod builds, CI, and OTA updates | DONE | Push any branch → CI builds; app polls releases every 30 min | .github/workflows/release.yml; electron-builder.yml; update.ts; dist-mac.sh | Branch-based channels; signed+unsigned paths; dev build picker ⌥⌘U; whole-.app swap |

## Demo-ready (reliable to show live)

These DONE features work end-to-end and are safe for a live walkthrough:

- Notch overlay + hit-window (the pill is always visible and clickable)
- Hover→home grid (cursor over the notch expands the panel)
- IslandHome grid (Chat icon + working/waiting/done agent rail)
- Chat transcript + markdown rendering (open a session, talk to the agent)
- Steer bar (live agent status + archive)
- ChatInput (autogrow, Enter=send, draft persistence across reopen)
- Attach panel (drag a window / pick tabs into a chat)
- Settings (debug toggles + archived agents)
- Details expand (raw tool rows)
- Multi-agent spawn/close/rename
- Claude TUI backend with session resumption (restart, agent picks up where it left off)
- Auto-naming via Haiku (first message names the agent)
- Narrator milestone summaries
- Wake-watchdog self-healing (deaf agent recovers)
- Blitzscript orchestrator workflows (start_workflow / run_workflow)
- Workflow kanban board (inline phase columns, live cards)
- Leaf drawer (Asked/Did/Returned)
- Completion wake (workflow finishes → agent wakes and replies in chat)
- Structured output with schema validation + human_summary
- Chrome tab connection via extension (read/act)
- macOS window connection (AX + ScreenCaptureKit, act + screenshot vision)
- Connection act with full pointer sequence (works on Google Docs)
- Per-source tools.json save/call/list
- Connection boot restore across restart
- Tmux-backed terminals persisting across restart
- Terminal open/send/read/close/remove tools
- say/ask user chat tools (choice cards)
- new_app tool (provision a live blitz.dev app on request)
- Onboarding interview (chat-only, ≤4 choice cards) + pre-board TCC permissions
- Live theming (set_theme recolors instantly)
- Action items inbox (request/list/resolve)
- Permission prompts + consent persistence (Allow/Block remembered per origin)
- Download interception (files land in the workspace)
- Crash announce & boot journal
- Prod builds / CI / OTA updates (push branch → packaged app offers Restart Now)

## Honest gaps / LEFT

### Critical / BROKEN (dormant or test-blind at runtime)
- **Tool registry is dark** (BROKEN): `BLITZ_TOOL_REGISTRY_URL` is unset and wrangler.toml has no route/account, so every `connection_registry_*` call returns "tool registry not configured." The three-surface briefing (on connect, in connection_list, in wake moments) always carries empty `registryTools`. There is no signal distinguishing "undeployed" from "no tools exist." Fix: `wrangler deploy` + set the env var. (connection-ops.mjs:89/779)
- **Registry tests not in the gate** (BROKEN): `npm run check` runs typecheck + parity + build only; `test-tool-registry-server.mjs` (22 assertions) is never run and no `npm test` exists. Worker/Node contract can drift undetected. Fix: add registry tests to the gate. (package.json)

### High severity (security / silent degradation)
- **Extension force-install token never delivered** (PARTIAL): per-install token is written to managed-prefs but `index.ts` never sets the env var, so the WS is authenticated by Origin only — forgeable by local processes. Also MDM-only (unmanaged Macs fall back to manual load-unpacked). (connection-install.ts)
- **Chrome run_js silently degrades** (PARTIAL): requires Chrome Developer mode, which force-install does not enable; returns `capability_unavailable` with no in-product explanation. (extension/sw.js)
- **Registry provenance missing** (PARTIAL): all 8 seeded tools have empty `vettedBy`/`vettedAt`; coverage is thin (3 sources) and hand-edited. (registry-data.mjs)

### Medium severity (UI overclaim / reachability — adversarial downgrades)
- **Opt+Space does NOT force a new session** (PARTIAL, downgraded): it restores the last view+tab (defaults to home). Docs overclaim "opens straight into a new agent session." (App.tsx 188-200)
- **Peek toggle button is commented out** (PARTIAL, downgraded): all peek logic exists but the corner-icon toggle is removed from the UI ("hidden for now"), so users cannot trigger it. (NotchHost.tsx 885-900)

### Lower severity (incomplete arcs / deferred)
- **JSX widget render path** (PARTIAL): 90% wired (compile/persist/catalog/7 reference widgets), but `SurfaceFrame.tsx` lacks the branch to route `lang:jsx/tsx` to the Sucrase pipeline, and `sucrase` is not in package.json. Closest to "finish me."
- **Plan widget** (PARTIAL): production-quality widget with correct data contract, but no WorkUnit spine to bind/lifecycle/inject duty.
- **MCP connections** (PARTIAL): fully researched and verified live, but zero BlitzOS integration (no connect_mcp tool, no endpoint map, no install/reload).
- **Job entrypoints** (PARTIAL): scattered building blocks (keybind routing, launcher prototype, action-items store) but no shared input component, NSPanel refactor, A4 Send, or Tray/notifications; Alt+Space collides with the notch toggle.
- **Safari connection** has no live source-change wake (synchronous Apple Events, no event stream).
- **Workflow enrichment** (PARTIAL): no-op exports, deferred with widgets post-V1.
- **PLANNED, no code**: CDP AI-browser, Job/Task WorkUnit model, connection widget non-LLM fast-refresh, case-file onboarding board (vestigial comments remain in OnboardingFlow.tsx).