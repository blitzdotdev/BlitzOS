// Per-chat composer DRAFT text — a half-typed message that must survive the island close/reopen (the composer
// unmounts per open, so its uncontrolled textarea otherwise loses the text). Module-level so it outlives the
// remount; keyed by chat id ('' = the new-session composer). Read/written IMPERATIVELY by ChatInput (the textarea
// is uncontrolled), so this is a plain get/set store — no useSyncExternalStore needed (nothing React-renders from
// it). Ephemeral by design: a draft is in-flight text, not history (not persisted to disk).
const drafts = new Map<string, string>()

export function getDraft(key: string): string {
  return drafts.get(key) || ''
}

export function setDraft(key: string, text: string): void {
  if (text) drafts.set(key, text)
  else drafts.delete(key)
}
