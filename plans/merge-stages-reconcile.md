# Merge `agent-runtime-moments` → master — reconciliation rules (decisions locked)

Two refactors went opposite ways in the same files. The user chose how they coexist:
- **Vocabulary = `stages`** (branch's). Rename master's `area*` → `stage*`.
- **Keep our Terminal/Agent rename** (`session*` → `terminal*`/`agent*`). Apply it to the branch's code, which still says `session`.
- **Chat = per-agent widgets ONLY** (master's). **DROP the branch's chat-hub** (the pinned `tall` hub tile + agent/session sidebar).
- **Adopt the branch's slot desktop** (additive): `stage-core.mjs` lattice, `place_widget`/`bring_to_stage`/`send_backstage` tools, slot persistence (`stageFields`/`slot`/`zone`), tile drag/snap + ⌘T/⇧⌘T keybinds, `flowFiles`.
- **Keep all our recent work**: `read_terminal`/`remove_terminal`/`close_terminal`(=stop), the migration (`.blitzos/terminals`), the visible-TUI launch, area/stage-per-agent, the reliable self-cleaning drive suite.

## The two renames (apply BOTH, everywhere — including each other's files)
1. **area → stage** (adopt branch): `area`→`stage`, `areaCount`→`stageCount`, `currentArea`→`currentStage`, `areaForAgent`→`stageForAgent`, `areaRect`→`stageRect`, `areaStride`→`stageStride`, `areaCenterX`→`stageCenterX`, `areaOfX`→`stageOfX`, `maxAgentAreaCount`→`maxAgentStageCount`, `areas-core`→`stages-core`, meta field `area`→`stage` (tolerate legacy `area` on read), event/props `area`→`stage`.
2. **session → terminal/agent** (keep ours): the branch still uses `session-manager`/`spawnSession`/`chatSessionIds`/`spawn_chat_session`/`rename_chat_session`/the `session` scope param/`session-*` events. Apply our rename: `terminal-manager`/`spawnTerminal`/`agentIds`/`spawn_agent`/`rename_agent`/`agent` param/`terminal-*`+`agent-*` events. The branch's `stageForSession` → **`stageForAgent`** (both renames compose).

EXCLUSIONS (never rename — same as before): CDP `sessionId`/`CdpSession`, Electron `session` API, `sessionFile`/`session.json`, relay SDK `session`, claude `--session-id`/`claudeSessionId`, tmux `SESSION`/`sessionName`.

## Conflict resolution (19 UU content + 4 modify/delete)
- **modify/delete:**
  - `session-manager.d.mts` (branch-mod / master-deleted→`terminal-manager.d.mts`): keep the DELETE; PORT any branch change into `terminal-manager.d.mts` (e.g. the `stage` meta field — already half-present as the `area`/`stage` HEAD/branch hunk).
  - `SessionsPanel.tsx` (branch-mod / master-deleted→`RuntimePanel.tsx`): keep the DELETE; PORT useful branch tray changes into `RuntimePanel.tsx` (but DROP hub-sidebar UI; keep per-agent rows + the slot affordances if any).
  - `areas-core.{mjs,d.mts}` (master-mod / branch-deleted→`stages-core`): keep the DELETE; ensure `stages-core.mjs` exports **`stageForAgent`** (rename the branch's `stageForSession`) and reflects our agent-id→stage mapping.
- **UU (both-modified)** — per file, apply BOTH renames + the model choices:
  - `terminal-manager.mjs`: ours wins (terminal naming, supervision, removeTerminal); take the **`stage`** meta field (not `area`).
  - `os-tools.mjs`: keep our terminal/agent tools + read/remove/close_terminal + the `agent` scope param; ADD the branch's slot tools (`place_widget`/`bring_to_stage`/`send_backstage`) with session→agent applied; placement via `stageForAgent`.
  - `store.ts` / `App.tsx` / `types.ts` / `SurfaceFrame.tsx`: keep our Terminal/Agent + per-agent chat; adopt `stage` vocab + the slot rendering (tile drag/snap/keybinds, `slot`/`zone` fields, `flowFiles`); DROP hub.
  - `workspace-host.{mjs,d.mts}`: keep our agent lifecycle (`addAgent`/`closeAgent`/`buildAgentSurface` = per-agent chat widget) + `removeTerminal` seam; adopt `stage` vocab (`stageForAgent`, `stageCount`, `maxAgentStageCount`); a per-agent chat MAY be a slotted tile, but it is NOT the hub.
  - `backend.mjs` / `index.ts` / `electron-os-tools.ts` / `osActions.ts` / `preload/index.ts` / `perception-core.{mjs,d.mts}`: apply both renames; wire the new slot tools/ops + `stage` state; DROP hub wiring; keep our terminal-remove + agent-remove/-rename events.
  - `blitzos-agents.md`: keep our "Terminals & Agents" section; ADD the branch's slot/stage doctrine (session→agent applied, stages kept); remove hub-sidebar instructions.
  - `drive-stages.mjs`: keep (branch's stage test) — apply session→agent where used; it should pass after.
- **49 clean-added (slot subsystem)**: keep. Apply session→terminal/agent to any `session`/`spawn_chat_session`/`rename_chat_session` refs; `stageForSession`→`stageForAgent`. Files incl. `stage-core.{mjs,d.mts}`, `stages-core.{mjs,d.mts}`, `test-stage-core.mjs`, `test-stage-e2e.mjs`, `plans/blitzos-stage-slot-desktop.md`.

## Verification gates (after resolution)
- `npm run typecheck` + `node scripts/check-parity.mjs` (cores list — `stages-core`/`stage-core` may be NEW shared cores; update the count if so) + `npm run build`.
- Live (server): restart; Home migrates + agent resumes; `read_terminal`/`remove_terminal`/`spawn_agent` work over the relay; the slot tools (`place_widget`) work; toolbar `+ Terminal`/`+ Agent`; per-agent chat (NO hub).
- Drive suite green: `drive-terminals`, `drive-newchat`, `drive-areas`(→stage), `drive-tabs`, `verify-real`, + the branch's `test-stage-core`/`test-stage-e2e`/`drive-stages`.
- **`.mjs` runtime-seam audit** (typecheck can't see these): backend↔workspace-host method names, the bootstrap scope payload, event-type strings, the slot-tool ops wired in BOTH transports. (Same class of seam I hand-fixed in the rename.)

## Caveat
`git fetch` fails here (no access) → working against the CACHED `origin/agent-runtime-moments`. The user may have newer branch commits; re-check if a fetch becomes possible.
