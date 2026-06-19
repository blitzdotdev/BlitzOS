# BlitzOS — New-User Journey: Onboarding → Start → Plan → Execute → Steer

Status: INDEX, verified against `blitzos-journey-build` HEAD 2026-06-18. Refreshed after the `orchestrators-replace-Job` merge (8991ef6).

## The flow

```
┌─────────────────────────────────────────────────────┐
│ ONBOARDING  ·  first launch (⌥Space opens Blitz)   │
│ scan machine → profile → board → interview          │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│ START  ·  one ⌥Space entry, two shells              │
│ A) island (notch overlay)  B) in-app HUD (keybind)   │
│ prompt + drag-drop files/tabs + add window → Send   │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
               « is it a substantial task? »
                          │
                          ├────► no: a normal request, the agent just
                          │       handles it in chat. no workflow, no loop.
                          │ yes
                          ▼
┌─────────────────────────────────────────────────────┐
│ start_workflow → spawns an ORCHESTRATOR-capable       │
│ agent (the `orchestrators` capability toggle ON)     │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│ PLAN + STEER                                         │
│ W1: agent writes an editable plan widget; user edits │
│ W2: supervise-tick heartbeat diffs the world, steers│
│ verify-job: an independent LLM checks completion      │
└─────────────────────────────────────────────────────┘
                          │ done
                          ▼
                       ┌────────┐
                       │  DONE  │
                       └────────┘
```

## ✅ Built (on `blitzos-journey-build`)

- **Orchestrators capability + blitzscript runtime** (8991ef6, 2dfb918, 0a81124, 00f74a2) — `src/main/blitzscript/` (`llm.mjs`, `run.mjs`, `runtime.mjs`, `agent.mjs`, `capabilities.mjs`, `check.mjs`, `harnesses.mjs`, `schema.mjs`, `library/`); `start_workflow` + `set_orchestrators` tools in `os-tools.mjs`; `orchestratorBootTask` in `agent-runtime.mjs`. Journaling + retries + capabilities probe + `blitzcheck` + cwd hardened. Tests: `test-blitz-orchestrator`, `test-blitz-llm`, `test-blitz-runtime`, `test-blitz-schema`, `test-blitz-library`, `test-blitz-journal`, `live-blitz-matrix`.
- **verify-job + supervise-tick blitzscript workflows** (8991ef6) — the verifier (an independent LLM chunks a worker's transcript, map-reduce + verify-the-verifier) and the supervisor heartbeat are workflows in `src/main/blitzscript/library/`, not bespoke host code.
- **W1 editable plan widget** (c74787f) — `widgets/plan.jsx` + widget UI kit; two-step return channel (`setProps` + tiny `sendMessage` + `get_surface`) dodges the 4KB cap. Test: `test-plan-widget`.
- **W2 tick → diff → steer** (26a824d) — `src/main/perception-core.mjs`; host heartbeat off `sweepTimer` diffs widget `props` + agent status edges → content-free `trigger:'tick'` moment to supervisor '0'; `/steer` → `emitUserMessage`. P0 cooperative path done. Test: `test-tick-diff`.
- **Shell A launcher + A2 drag-drop** (94238ec, e763f06) — `src/main/launcher.ts`; frameless NSPanel + first `globalShortcut` (⌥Space); dropped files/tabs → `contextRefs` to `start_workflow`. Test: `test-launcher`.
- **Single-canvas navigation** (8991ef6) — home frame + slot lattice; splay model deleted.
- **Phase 1 onboarding** (`onboarding-case-file.md`) — scan → profile → board → interview, mostly built.

## ⬜ TODO

- **Dynamic island → pure-Electron overlay** (DECIDED 2026-06-18, see History). Retire the native Swift `BlitzIsland.app` (`native/island-helper/`, `src/main/island.ts`, `island-membership.mjs`, `island-bridge.mjs`) in favor of a notch-covering Electron window (`coversMenuBar=true`, PoC at `/Users/minjunes/superapp/notch-spill-poc`). Spec: `plans/blitzos-dynamic-island.md`.
- **A3 attach a live browser tab** — the open hard problem; reframed as the island handing BlitzOS the live tab via agent-socket (the installed `~/agent-socket` Chrome extension). Today the launcher has no in-browser "add" affordance (`launcher.ts:29` TODO). Subsumed by Pass-2 item-2.
- **Shell B in-app HUD** — the same entry UI inside BlitzOS behind an in-app keybind; touches `App.tsx` (WIP), deliberately deferred.
- **P0 generic auto-serializer** — MutationObserver in `widget-bridge` for non-cooperative widgets (renderer/iframe runtime).
- **A5 Tray + [N] native notifications + dock badge** — `notify.ts` + content-agnostic whitelist; specced in `blitzos-job-entrypoints.md`, not built.
- **W3 session-summary widget** — rolling 2-min summary + raw window; cadence design open.
- **E3 status widget** — subsumed by W1's status mode (no separate build).
- **Pass-2 item-2: attach any macOS app to the island** — non-browser apps → computer-use helper (osascript/accessibility + native-app-embedding). Spec: `plans/blitzos-dynamic-island.md` + `plans/blitzos-computer-use-helper.md`.

## History

- **2026-06-16/17 (Pass 1 spine).** Built the Job model (Option 1: Job on per-agent `meta.json`), W1 plan widget, E1 `plan.md`-gated Stop hook + spin-guard, W2 tick→diff→steer (Option A), Shell A launcher. 8 suites + typecheck + build green. Two adversarial bugs fixed pre-commit (start_job re-exec no-op; W2 timing-window self-wake).
- **2026-06-18 (8991ef6 — the pivot).** `feat: single-canvas navigation + orchestrators replace Job model + native dynamic island`. Deleted `job-model.mjs`/`plan-doc.mjs` + their tests; shipped the **per-agent `orchestrators` capability toggle** + the **blitzscript** runtime in their place (the move the Pass-2 TODO predicted, pulled forward). The verifier + supervisor are now blitzscript workflows, not bespoke host code. Also landed single-canvas navigation and a native Swift dynamic-island notch HUD (`BlitzIsland.app` + `/island` WS).
- **2026-06-18 (decision).** Pure-Electron overlay route for the island. The native Swift helper is to be retired: a PoC (`/Users/minjunes/superapp/notch-spill-poc`) proved a notch-covering Electron window (`coversMenuBar=true`, zero native code) covers the notch + spills to fullscreen. See `plans/blitzos-dynamic-island.md`.

## Cross-references
- `plans/blitzos-blitzscript.md` + `plans/blitzos-blitzscript-claude-interface.md` — the LIVE spine (orchestrators + blitzscript)
- `plans/blitzos-dynamic-island.md` — ⌥Space "opens Blitz anywhere"; pure-Electron overlay route
- `plans/blitzos-plan-widget.md` — W1 widget + return channel
- `plans/blitzos-tick-diff-steer.md` — W2 supervisor heartbeat (Option A)
- `plans/blitzos-job-entrypoints.md` — Shell A/B + A2/A3 + A5/[N]
- `plans/blitzos-agent-autonomy-guardrails.md` — E1 continuation + plan-authoring duty (now the orchestrator duty)
- `plans/blitzos-job-task-model.md` — HISTORICAL (the deleted Job object; kept for the record)
- `plans/onboarding-case-file.md` — Phase 1 onboarding
