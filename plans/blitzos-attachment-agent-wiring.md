# Attachment → agent wiring (the 3 critical gaps)

Subplan of `blitzos-window-drag-drop.md`. The connection machinery is real; what's missing is **the agent
knowing/owning what the user attached**. All three gaps share ONE root: the active session id never reaches the
connect path.

## Root cause (shared)
`activeId` is computed in `NotchHost.tsx:314` and passed to `IslandPanel`, but `IslandPanel.tsx:147` renders
`<AttachPanel />` with **no props**, and every hop after it (AttachPanel connect calls → preload → IPC
`os:conn-connect-*` → `connectionConnectTab/Window` → adapter → `connectionBind` → `emitConnectionMoment`) carries no
agent id. The drag-drop path (`index.ts` `pick_drop`) runs in main with no renderer session in scope at all.

**The one thread to add:** the active agent id, from the UI to `connectionBind` (and to the `pick_start` arm for
drops). With it stored on the connection record and passed to the moment, all three gaps close.

## Gap 1 — wake the ACTIVE chat's agent (not just '0')
A per-agent wake path already exists: `message`/`action` moments carry `moment.agentId`, and `visibleTo`
(`perception-core.mjs:63`) routes them to that agent; non-primary agents poll `/events` scoped `agent:'N'`
(`agent-runtime.mjs:93-94`). Connection moments set no `agentId` → fall through to `sid === '0'`.
**Fix (backward-compatible, no-agentId ⇒ '0'):**
1. `perception-core.mjs:63` — add `'connection'` to the per-agent branch.
2. `emitConnectionMoment` (`perception-core.mjs:476`) — emit `agentId: String(info.agentId || '0')`.
3. Thread `activeId` UI→`connectionBind` (hops below); pass it as `info.agentId` at the `emitConnectionMoment` call
   (`connection-ops.mjs:231`). For drops: add `activeId` to `pick.start(...)` (NotchHost has it) → main stores a
   "current attach session" → `pick_drop` uses it.

## Gap 2 — inject PRE-SPAWN attachments into the new agent
New-session tab has no agent yet. `contextRefs` exists but `notch-send` passes `[]`; the live consumer is
`electron-os-tools.ts:88-93` `startWorkflow`, which renders refs into a chat.md footer the agent reads on boot
(the `recover` fragment tails chat.md, `agent-runtime.mjs:105`). The Deep-OFF notch path (`index.ts:676-677`,
`spawnAgent` + `userMessage`) takes no refs.
**Fix (chat-seed seam, lowest friction):** the new-session AttachPanel tracks the connIds it created; `notch.send`
passes them; `os:notch-send` appends "Attached before you started: connId X (tab github.com)" to the new agent's
first `userMessage` (and reassigns those connections' owner to the new agent id, per Gap 3).

## Gap 3 — scope connections per chat
**Blocker:** no trusted caller identity reaches the tool layer — both transports pass only `{ body, transport }`
(`agentSocket.ts:60`, `control-server.ts:144`); every agent id in a tool call is a self-reported BODY field
(`/say` reads `b.agent`, `/events` reads `a.agent`). The relay SDK exposes `headers` but no agent id; BlitzOS drops them.
**Design fork (recommend A):**
- **A — self-reported scoping (consistent + cheap).** Store an owner `agentId` on the connection record
  (`connection-ops.mjs:210` + param `:168`, threaded from the connect path). `connection_list` filters by the
  self-reported `agent` body param — exactly how `/events` and `/say` already scope. Each agent's bootstrap already
  sends `,"agent":"N"`. Not adversarially secure, but the whole system is single-user/trusted and already works this
  way, so it's the right level. Each chat sees only its own connections; targeted wake (Gap 1) means an agent only
  learns its own connIds anyway.
- **B — transport-authenticated identity (secure, big).** Mint a per-agent token at the relay/localhost boundary,
  surface it in the tool context, gate on it. Needs an SDK change (vendored `~/agent-socket`) + reworking both
  bindings. Overkill for a local single-user OS; defer unless multi-tenant.

## The threading path (the implementation work, once approved)
`IslandPanel.tsx:147` pass `activeSessionId={activeId}` → AttachPanel prop + into `conn.connectTab/connectWindow`
(`:158/:168`) + the `ConnBridge` type (`:18`) → preload `connectTab/connectWindow` forward it (`preload:144/147`) →
IPC handlers read it (`index.ts:545-546`, replace `{}` with `{ agentId }`) → `connectionConnectTab/Window` pass opts
through (`connection-ops.mjs:557/576`, already opaque) → adapters forward into `connectionBind({...})`
(`connection-tab-link.mjs:236`, `connection-window-link.ts:91`) → `connectionBind` stores `agentId` on the record
(`:168`,`:210`) and passes it to `emitConnectionMoment` (`:231`). Drops: `NotchHost` `pick.start` carries `activeId`
→ `os:pick-start` stores it → `pick_drop` uses it for both the connect opts and the moment. Plus `visibleTo:63` +
`emitConnectionMoment` agentId (Gap 1), and the `notch-send` footer + owner-reassign (Gap 2).

## Open decisions for MJ
1. Gap 3: **A (self-reported, recommended)** or B (secure/SDK)?
2. A connection is owned by the ONE chat that created it (recommended) — or visible to all chats?
3. Pre-spawn injection: chat-seed footer (recommended) or the system bootstrap.
