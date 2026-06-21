# Attachment snapshot in chat (scaled-down frozen dropbox)

Replace the per-message attachment CHIPS with a scaled-down, read-only, frozen copy of the dropbox placed
above the message it rode on. Glass-pill outline (not dashed). Scroll + tooltip work; no delete.

## What exists today (reuse, don't rebuild)
- `IslandPanel.sentAtts: Record<chat, Record<ordinal, AttachChip[]>>` already is a FROZEN per-user-message snapshot
  (captured at send by `recordSentAttachments`, rendered as `.isl-attach-chip` above each user msg via `chipsByIndex`).
  Limits: data is minimal (`{connId,type,title}`, no icons), it's `useState` so it dies on island reopen, and capture
  uses a `shownConnRef` "show once" dedup instead of the real staging tray.
- `AttachPanel` already builds the dropbox groups (`buildTrayGroups` inline, lines ~350-383 → `AttachGroup[]`) and
  renders them (pills + single windows + icons/favicons, `showTip` tooltip, scroll). This is the thing to snapshot.
- Glass-pill reference = `.isl-chip` (agent tab header): `--isl-surface` bg, `1px solid --isl-faint`, fully rounded,
  white-overlay hover. Live dropbox = dashed `.att-drop`.

## Target design (no hacks)
1. **Shared tray module `attachTray.tsx`** (DRY — one renderer, two callers):
   - Move `TrayItem`/`TrayGroup` types + the pure `buildTrayGroups(lists, isStaged)` out of AttachPanel.
   - `<AttachTray groups readOnly? compact? onRemoveConn? onRemoveGroup? />` = the current dropbox JSX (pills, singles,
     icons, favicons), owning its own hover state + `att-tip` portal. `readOnly` drops every remove button + connect/
     drag handler but keeps `onMouseEnter→showTip` and `overflow-y:auto` scroll. AttachPanel renders it interactive.
2. **Snapshot store — PERSISTENT across restart (disk-backed).**
   - Main: `attachment-store.mjs` (bound like terminal/connection ops) writes `<ws>/.blitzos/attachments/<safeChat>.json`
     = `{ ordinal: TrayGroup[] }` (base64 icons inlined). `recordAttachments(chat, ord, groups)` merges + writes;
     `listAttachments(chat)` reads. IPC `os:attach-record` / `os:attach-get`; preload `attachments.record/get`.
   - Renderer `sentTrayStore.ts` (native `useSyncExternalStore`, no zustand): a disk-backed CACHE. `useSentTray(chat)`
     lazy-loads that chat from main on first use (then it's also reopen-proof in memory); `recordSentTray(chat, ord,
     groups)` write-throughs to main + updates the cache; a `pending` slot covers the new-session case.
   - Keying by `(chatId, userOrdinal)` is restart-stable (VERIFIED): chatId IS the persisted chat-file id
     (`'0'→chat.md`, `N→chat-N.md`, `chatFileName(id)`), and that transcript reloads in the same order on restart, so
     the Nth user message maps to the same ordinal. So `<ws>/.blitzos/attachments/<chatId>.json` sits right beside the
     chat file it annotates.
3. **Capture at send = a literal copy of the live dropbox.** AttachPanel publishes its built groups for the active
   chat into a `liveTray` module ref on change (`useEffect([groups, activeSessionId])`). `handleSend` reads the staged
   set (stagingStore) + that live copy, freezes it under `(chat, ordinal)`, THEN sends (onSend already `clearStaged`s).
   New-session composer (`''`): freeze the live `''` tray into `pending`; pin to the spawned agent's ordinal 0 when it
   appears (reuse the existing `pendingNewSessionRef` seam). This replaces `shownConnRef` — the staging tray already
   means "what the user attached for THIS message", so each snapshot = the tray at that send.
4. **Render:** above each user message, `chipsByIndex[i]` → `<AttachTray groups={snap[i]} readOnly compact />`
   (replaces the `.isl-msg-attach` chip block). Driven by `useSentTray(activeId)` not local state.
5. **Style — glass on the SNAPSHOT only.** The in-chat snapshot `.isl-msg-tray` uses the agent-tab glass-pill
   (`--isl-surface` bg, `1px solid --isl-faint` hairline, rounded, NOT dashed). The LIVE `.att-drop` drop zone KEEPS
   its dashed border (the "drop here" affordance only makes sense while live). `compact` (snapshot) shrinks icons
   (44→~28px) + padding and caps height with `overflow-y:auto` for scroll. Drop the `.isl-attach-chip` styles.
   Tooltip reuses `.att-tip`.

## Files
- new (renderer): `attachTray.tsx` (shared builder + read-only/interactive component), `sentTrayStore.ts` (disk-backed cache).
- new (main): `attachment-store.mjs` (`<ws>/.blitzos/attachments/<chat>.json` read/write).
- edit (main): `index.ts`/`osActions.ts` (bind the store + `os:attach-record`/`os:attach-get` IPC), `preload/index.ts`
  (`attachments.record/get`).
- edit (renderer): `AttachPanel.tsx` (use shared builder+component), `IslandPanel.tsx` (swap chips→AttachTray +
  sentTrayStore, delete `AttachChip`/`shownConnRef`), `island.css` (glass `.isl-msg-tray` snapshot, compact sizing,
  remove chip styles; live `.att-drop` unchanged).

## Decided (per user)
- Glass on the in-chat SNAPSHOT only; the live drop zone stays dashed.
- Snapshot PERSISTS across full restart (disk-backed, above), not just island reopen.
- Frozen base64 icons cost a few KB per source per message — fine at chat scale; per-chat JSON files keep writes small.
