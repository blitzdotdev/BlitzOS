export type Transport = 'relay' | 'localhost' | 'server'
export interface ToolCtx {
  body: string
  transport: Transport
}
/** A handler returns either a plain payload (→ HTTP 200) or { status, body } to set a non-200 status. */
export type ToolResult = { status: number; body: unknown } | Record<string, unknown> | unknown
export interface OsTool {
  path: string
  description: string
  input_schema?: Record<string, unknown>
  handler: (ctx: ToolCtx) => ToolResult | Promise<ToolResult>
}

/** The per-runtime primitive operations the shared tool handlers call (IPC+CDP on Electron, broadcast +
 *  headless Chromium on the server). Loosely typed — each transport binds its own implementations. */
export type OsOps = Record<string, (...args: never[]) => unknown>

/** Telemetry seam: observe every tool call across every transport ({path, transport, ms, status}). */
export function setToolTap(fn: ((info: Record<string, unknown>) => void) | null): void
export function makeOsTools(ops: Record<string, (...args: never[]) => unknown>): OsTool[]
export function makeOsToolsByPath(ops: Record<string, (...args: never[]) => unknown>): Record<string, OsTool>
/** The agent-facing view of desktop state: layout fields only (drops srcdoc html + native props/transcript).
 *  Used by the shared list_state handler AND the widget list_state tool so every transport returns one shape. */
export function serializeStateForAgent(state: unknown): Record<string, unknown>
