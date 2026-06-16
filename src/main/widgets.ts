import { ipcMain } from 'electron'
import { electronOps } from './electron-os-tools'
import { makeWidgetToolRunner, makeWidgetToolHandlers } from './widget-tools.mjs'

// Electron-side widget bridge. A sandboxed srcdoc widget reaches the OS ONLY through this IPC, gated by
// the `tools` capability and the CLOSED allowlist (widget-tools.mjs). It works the user's tools through
// the surfaces it opens (open_window / read_window / surface_control), not through any data bridge.

export function registerWidgets(): void {
  // blitz.tool — a sandboxed widget calls an OS tool. The CLOSED allowlist + handler logic (widget-tools.mjs)
  // is shared with the server; we bind it to the SAME electronOps the agent registry uses, so the widget
  // contract can't drift between desktop and server.
  const runWidgetTool = makeWidgetToolRunner(makeWidgetToolHandlers(electronOps))
  ipcMain.handle('widget:tool', (_e, req: { surfaceId?: string; name?: string; args?: unknown }) =>
    runWidgetTool(String(req?.name || ''), req?.args, { surfaceId: String(req?.surfaceId || '') })
  )
}
