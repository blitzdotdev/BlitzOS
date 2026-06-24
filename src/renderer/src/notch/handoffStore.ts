import { useSyncExternalStore } from 'react'

// Handoff cards (login / 2FA / captcha / consent). A module-level external store ON PURPOSE: the island remounts on
// every open, but the card must survive that, so it lives OUTSIDE the component tree (same reasoning as stagingStore).
// Fed by the main-process `os:action {type:'handoff'}` broadcast (App.tsx onAction → applyHandoffAction). NO zustand.
// The screenshot rides THIS store, never the chat transcript; on resolve the main side purges it and we drop it here
// too, so a login page never lingers. Native React (useSyncExternalStore).

export interface HandoffEntry {
  connId: string
  reason: string
  img: string // base64 data URI while awaiting; '' once resolved (purged)
  status: 'awaiting' | 'done'
}

let entries: Record<string, HandoffEntry> = {}
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

// Apply a broadcast `{type:'handoff', cardId, ...}`: create → an awaiting entry with the screenshot; done → collapse +
// drop the screenshot (the main side purged it too). Only the changed cardId's object ref is replaced, so a card that
// didn't change keeps a stable snapshot and doesn't re-render.
export function applyHandoffAction(a: { cardId?: unknown; connId?: unknown; reason?: unknown; img?: unknown; status?: unknown }): void {
  const cardId = String((a && a.cardId) || '')
  if (!cardId) return
  if (a.status === 'done') {
    const cur = entries[cardId]
    entries = { ...entries, [cardId]: { connId: cur?.connId || '', reason: cur?.reason || '', img: '', status: 'done' } }
    emit()
    return
  }
  entries = {
    ...entries,
    [cardId]: {
      connId: String(a.connId || ''),
      reason: String(a.reason || 'Requires user login'),
      img: String(a.img || ''),
      status: 'awaiting'
    }
  }
  emit()
}

// Subscribe to ONE card's entry. getSnapshot returns a STABLE ref between changes, so useSyncExternalStore never loops
// and only re-renders the card whose entry actually changed.
export function useHandoff(cardId: string): HandoffEntry | undefined {
  return useSyncExternalStore(subscribe, () => entries[cardId])
}
