import { useSyncExternalStore } from 'react'

// The attach panel's STAGING TRAY (the dropbox), per chat. A module-level external store on PURPOSE: it lives
// OUTSIDE the island component tree, which remounts on every open/close (NotchHost + AttachPanel mount per open).
// So the staged set survives a hide+reopen by construction — no seed/mirror/skip-mount dance, nothing to wipe.
// Native React (useSyncExternalStore), NO zustand. A staged key is `tab:<tabId>` / `window:<windowId>` /
// `conn:<connId>`. Cleared on SEND (NotchHost.onSend → clearStaged) since the staged sources rode the message as
// chips. Ephemeral by design (not persisted across an app restart).

type Staged = Record<string, Set<string>>
let staged: Staged = {}
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function stageSources(chatId: string, ...keys: string[]): void {
  const next = new Set(staged[chatId])
  let changed = false
  for (const k of keys) if (!next.has(k)) ((changed = true), next.add(k))
  if (!changed) return
  staged = { ...staged, [chatId]: next } // only this chat's Set ref changes → only its subscribers re-render
  emit()
}

export function unstageSources(chatId: string, ...keys: string[]): void {
  const cur = staged[chatId]
  if (!cur) return
  const next = new Set(cur)
  let changed = false
  for (const k of keys) if (next.delete(k)) changed = true
  if (!changed) return
  staged = { ...staged, [chatId]: next }
  emit()
}

export function clearStaged(chatId: string): void {
  if (!staged[chatId]?.size) return
  staged = { ...staged, [chatId]: new Set() }
  emit()
}

// Subscribe to THIS chat's staged set. getSnapshot returns a STABLE Set ref between changes (the same object until
// an action replaces it), so useSyncExternalStore never loops and only re-renders on a real change to this chat.
export function useStagedSet(chatId: string): Set<string> | undefined {
  return useSyncExternalStore(subscribe, () => staged[chatId])
}
