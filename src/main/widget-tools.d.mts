export const WIDGET_TOOLS: string[]
export function isWidgetTool(name: unknown): boolean
export function makeWidgetToolRunner(
  handlers: Record<string, (args: Record<string, unknown>, ctx: { surfaceId?: string }) => unknown>
): (name: string, args: unknown, ctx?: { surfaceId?: string }) => Promise<{ ok: boolean; result?: unknown; error?: string }>
