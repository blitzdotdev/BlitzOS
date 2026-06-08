export const WIDGET_TOOLS: string[]
export function isWidgetTool(name: unknown): boolean
export function makeWidgetToolRunner(
  handlers: Record<string, (args: Record<string, unknown>, ctx: { surfaceId?: string }) => unknown>
): (name: string, args: unknown, ctx?: { surfaceId?: string }) => Promise<{ ok: boolean; result?: unknown; error?: string }>
/** Build the widget-tool handler map from a runtime's `ops` (same shape os-tools.mjs documents). One source for
 *  both transports so the widget `blitz.tool` contract can't drift. Pass the result to makeWidgetToolRunner. */
export function makeWidgetToolHandlers(
  ops: Record<string, (...args: never[]) => unknown>
): Record<string, (args: Record<string, unknown>, ctx: { surfaceId?: string }) => unknown>
