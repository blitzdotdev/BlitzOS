// Types for agent-interrupt.mjs (the per-backend "was this agent cut off mid-turn?" seam).
export interface InterruptMeta {
  agentRuntime?: string | null
  claudeSessionId?: string
  status?: string
  exitCode?: number | null
}
/** true = interrupted mid-turn (resume), false = finished cleanly (leave), null = unknown backend (leave). */
export function wasInterrupted(meta: InterruptMeta | null | undefined, ctx?: { wsRoot?: string | null }): boolean | null
