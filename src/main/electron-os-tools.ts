// Electron's binding of the SHARED tool registry (os-tools.mjs). Maps the runtime-agnostic tool handlers
// to Electron's primitive operations (osActions = IPC to the renderer + CDP via webContents; provider-bridge
// for the approval-gated provider engine; integrations for the Keychain-backed connection status). Both
// Electron transports import OS_TOOLS / OS_TOOLS_BY_PATH from HERE: agentSocket.ts (relay) maps the array,
// control-server.ts (localhost) dispatches the by-path map. The server (preview/backend.mjs) builds the SAME
// registry from its own ops — so there is one tool definition, zero Electron/server difference.
import { makeOsTools, makeOsToolsByPath, type OsTool } from './os-tools.mjs'
import {
  osCreateSurface,
  osOpenWindow,
  osMoveSurface,
  osUpdateSurface,
  osCloseSurface,
  osCloseSurfaceFile,
  osGoToPrimary,
  osGetState,
  osWorkspaceContext,
  osListWorkspaces,
  osCreateWorkspace,
  osSwitchWorkspace,
  osReadWindow,
  osControlSurface,
  osSay,
  osCustomizeWidget,
  osSpawnChatSession,
  osRenameChatSession,
  osSystemUi,
  osGroupIntoFolder,
  osBroadcast,
  type SurfaceDescriptor
} from './osActions'
import { runProviderCall } from './provider-bridge'
import { integrationStatuses, connectedProviders } from './integrations'
import { makeSessionOps } from './session-ops.mjs'
import { makeActionItems } from './action-items.mjs'
import { emitSurfaceAction } from './events'

// Exported so the widget-tool runner (src/main/widgets.ts) can build its handler map from the SAME ops —
// see makeWidgetToolHandlers in widget-tools.mjs. One ops object → both the agent registry and the widget
// allowlist, so the two can never drift (the divergence the consolidation audit found).
export const electronOps = {
  createSurface: (a: unknown) => osCreateSurface(a as SurfaceDescriptor),
  openWindow: (a: unknown) => osOpenWindow(a as { url: string; x?: number; y?: number; w?: number; h?: number; title?: string }),
  moveSurface: (id: string, x: number, y: number) => osMoveSurface(id, x, y),
  updateSurface: (id: string, patch: Record<string, unknown>) => osUpdateSurface(id, patch),
  closeSurface: (id: string) => {
    // Parity with the server ops (backend.mjs closeSurface): delete the backing content file IN
    // MAIN, synchronously, before the close removes the node. The renderer also calls closeSurfaceFile
    // on every close, but that rides a main→renderer→main round-trip — an agent that closes and
    // immediately switches workspace wins that race, the flush projects stale state (or the late
    // delete looks up the id in the NEW workspace and no-ops), and the orphaned file resurrects
    // the surface on the next reconcile (observed live). Duplicate delete is a no-op (the host
    // skips missing/non-content files). osCloseSurface returns the loud-error result (2C).
    osCloseSurfaceFile(id)
    return osCloseSurface(id)
  },
  goToPrimary: () => osGoToPrimary(),
  getState: () => osGetState(),
  workspaceContext: () => osWorkspaceContext(),
  listWorkspaces: () => osListWorkspaces(),
  createWorkspace: (name: string) => osCreateWorkspace(name),
  switchWorkspace: (name: string) => osSwitchWorkspace(name),
  readWindow: (id: string, script?: string) => osReadWindow(id, script),
  controlSurface: (id: string, action: unknown) => osControlSurface(id, action as Parameters<typeof osControlSurface>[1]),
  say: (text: string, sessionId?: string) => osSay(text, sessionId),
  customizeWidget: (name: string, html: string, sessionId?: string) => osCustomizeWidget(name, html, sessionId),
  spawnChatSession: (title?: string) => osSpawnChatSession(title),
  renameChatSession: (sessionId: string, title: string) => osRenameChatSession(sessionId, title),
  systemUi: (name: string) => osSystemUi(name),
  groupIntoFolder: (name: string, ids: string[], x: number | undefined, y: number | undefined, kind: 'board' | 'folder') => osGroupIntoFolder(name, ids, x, y, kind),
  providerCall: (descriptor: Parameters<typeof runProviderCall>[0], transport: 'relay' | 'localhost') => runProviderCall(descriptor, transport === 'localhost' ? 'localhost' : 'relay'),
  integrationStatuses: () => integrationStatuses(),
  connectedProviders: () => connectedProviders()
} as Record<string, (...args: never[]) => unknown>

// Session ops — the SHARED workspace-keyed lifecycle (session-ops.mjs). Electron seam: the active
// workspace folder + the os:action emit. The server binds the SAME makeSessionOps with its own seam,
// so the multi-agent session model can't diverge between the two modes.
export const electronSessionOps = makeSessionOps({ getWorkspacePath: () => osWorkspaceContext().workspace_path, emit: osBroadcast })
Object.assign(electronOps, electronSessionOps)

// Action-items inbox — same shared-core pattern. emitMoment wakes the watching agent (a perception
// 'action' moment) when the human ticks an item; emit pushes the UI update over os:action.
export const electronActionItems = makeActionItems({
  getWorkspacePath: () => osWorkspaceContext().workspace_path,
  emit: osBroadcast,
  emitMoment: (action) => emitSurfaceAction('inbox', action)
})
Object.assign(electronOps, electronActionItems)

export const OS_TOOLS: OsTool[] = makeOsTools(electronOps)
export const OS_TOOLS_BY_PATH: Record<string, OsTool> = makeOsToolsByPath(electronOps)
