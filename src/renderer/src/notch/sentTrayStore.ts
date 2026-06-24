import { useEffect, useSyncExternalStore } from 'react'
import type { TrayGroup } from './attachTray'

// The per-message attachment SNAPSHOT (the frozen dropbox copy shown above a sent message). Keyed
// `chat → msgKey → TrayGroup[]` where msgKey = String(m.ts) — the timestamp written to chat.md at append
// time, passed from the renderer so main and renderer use the SAME value. This makes lookups stable across
// the sliding 400-message display window: m.ts is absolute, not positional. PERSISTENT across a full
// quit/restart: backed on disk by the main process (`.blitzos/attachments/<chat>.json`), cached here in a
// module-level external store (native useSyncExternalStore, NO zustand) so it ALSO survives the island remount.
// Plus a NON-persisted `live` mirror — what each chat's dropbox currently shows — so a send can freeze an
// exact copy without re-deriving.

type ChatSnaps = Record<string, TrayGroup[]>
let snaps: Record<string, ChatSnaps> = {}
const loaded = new Set<string>() // chats whose disk state has been pulled this session
const loading = new Set<string>()
const listeners = new Set<() => void>()
const EMPTY: ChatSnaps = {}
const emit = (): void => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

type AttachBridge = {
  record(chat: string, msgKey: string, groups: TrayGroup[]): Promise<unknown>
  get(chat: string): Promise<{ attachments?: ChatSnaps; error?: string }>
}
const bridge = (): AttachBridge | undefined =>
  (window as unknown as { agentOS?: { attachments?: AttachBridge } }).agentOS?.attachments

// ---- live tray mirror (NOT persisted): the current dropbox groups per chat, published by AttachPanel on change ----
const live: Record<string, TrayGroup[]> = {}
export function publishLiveTray(chat: string, groups: TrayGroup[]): void {
  live[chat] = groups
}
export function getLiveTray(chat: string): TrayGroup[] {
  return live[chat] || []
}
// Drop the mirror on send. AttachPanel (which publishes it) UNMOUNTS when the panel closes on send, so it can't
// re-publish the now-cleared tray — without this, the last-staged groups linger and get frozen onto every later
// message even though nothing was staged. Pair this with clearStaged (the staged set is the source of truth).
export function clearLiveTray(chat: string): void {
  if (live[chat]) delete live[chat]
}

// Drop a chat's frozen snapshots from the cache when its agent is CLOSED for good. Agent ids are reused (the main
// process mints max(live ids)+1, so a freed number is handed back out), and this in-memory cache + the `loaded`
// flag survive the close — so without this a new agent that reuses the id shows the CLOSED agent's snapshot. Clearing
// `loaded` makes the next mount re-read the now-wiped disk (main deletes the file on close + on id re-mint). Call ONLY
// on a genuine close (the `agent-remove` broadcast), never on archive — archived chats keep their snapshots to restore.
export function dropChat(chat: string): void {
  loaded.delete(chat)
  loading.delete(chat)
  if (!(chat in snaps)) return
  const next = { ...snaps }
  delete next[chat]
  snaps = next
  emit()
}

async function ensureLoaded(chat: string): Promise<void> {
  if (loaded.has(chat) || loading.has(chat)) return
  loading.add(chat)
  try {
    const r = await bridge()?.get?.(chat)
    const got = (r && r.attachments) || {}
    // disk is the baseline; any record made this session before the load resolved WINS (it's newer + already on disk).
    snaps = { ...snaps, [chat]: { ...got, ...(snaps[chat] || {}) } }
  } catch {
    /* best-effort — an empty snapshot just means no chips, never a crash */
  }
  loaded.add(chat)
  loading.delete(chat)
  emit()
}

// Freeze the tray for (chat, msgKey) and write it through to disk. Called at send.
// msgKey = String(sendTs) — the timestamp the renderer passed to main so both sides use the same key.
export function recordSentTray(chat: string, msgKey: string, groups: TrayGroup[]): void {
  snaps = { ...snaps, [chat]: { ...(snaps[chat] || {}), [msgKey]: groups } }
  loaded.add(chat)
  emit()
  void bridge()?.record?.(chat, msgKey, groups)
}

// Subscribe to a chat's frozen snapshots; lazy-loads from disk on first use (then reopen-proof in memory).
export function useSentTray(chat: string | undefined): ChatSnaps {
  const key = chat || ''
  const map = useSyncExternalStore(subscribe, () => snaps[key])
  useEffect(() => {
    if (chat) void ensureLoaded(key)
  }, [key, chat])
  return map || EMPTY
}
