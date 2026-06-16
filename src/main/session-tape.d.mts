// Types for the local session-tape spool (session-tape.mjs).
export function makeSessionTape(opts: {
  getRoot: () => string
  getWorkspace?: () => string | null
  appVersion?: string
  boot?: string
  clock?: () => number
}): {
  file: () => string | null
  dir: () => string | null
  codeVersion: string
  toolCall(info: unknown): void
  moment(m: unknown): void
  agentSpawn(info: unknown): void
  diagError(e: unknown): void
  snapshot(reason: string, payload: { files?: Record<string, string>; permissions?: unknown; bookmarks?: unknown } | null): void
  frame(image: Buffer | Uint8Array | null, meta?: { format?: string; w?: number; h?: number }): void
  registerTranscript(agent: string | number, path: string, startAtEof?: boolean): void
  flushTranscripts(): void
  crash(info: { dirty?: boolean; concurrent?: boolean; at?: number; detail?: string; pid?: number; mode?: string } | null): void
  webFail(info: { surfaceId?: string; tabId?: string; url?: string; code?: number; desc?: string } | null): void
  guestDecision(info: { subtype?: string; surfaceId?: string; kind?: string; url?: string; disposition?: string; features?: string; origin?: string; permission?: string } | null): void
}
