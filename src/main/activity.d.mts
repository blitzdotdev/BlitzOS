// Types for the shared "Agent activity" feed (activity.mjs).

export interface ActivityEvent {
  type: 'activity'
  at: number
  text: string
  agentId?: string
  tool?: string
}

/** SDK-shaped relay tool (path/description/input_schema?/handler) — matches relay.d.mts RelayConfig.tools. */
export interface SdkTool {
  path: string
  description: string
  input_schema?: Record<string, unknown>
  handler: (ctx: { body?: string }) => unknown
}

export const ACTIVITY_TOOLS: Set<string>

/** A short human label for an agent tool call, for the activity feed. */
export function activityText(path: string, a: Record<string, unknown>): string

/** Wrap action-tool handlers to publish an activity event before each call. `emit` is the per-transport publish. */
export function withActivity(tools: SdkTool[], emit: (event: ActivityEvent) => void): SdkTool[]
