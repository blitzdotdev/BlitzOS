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
  osUserMessage,
  osCustomizeWidget,
  osSpawnAgent,
  osCloseAgent,
  osRenameAgent,
  osSystemUi,
  osSystemUiInfo,
  osGroupIntoFolder,
  osBroadcast,
  osSetTheme,
  type SurfaceDescriptor
} from './osActions'
import { runProviderCall } from './provider-bridge'
import { integrationStatuses, connectedProviders } from './integrations'
import { makeTerminalOps } from './terminal-ops.mjs'
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
  say: (text: string, agentId?: string, workspace?: string) => osSay(text, agentId, workspace),
  // user_say (localhost-only test syscall): programmatic user input through the human composer's exact path
  userMessage: (text: string, agentId?: string) => osUserMessage(text, agentId),
  customizeWidget: (name: string, html: string, agentId?: string, lang?: 'html' | 'jsx' | 'tsx') => osCustomizeWidget(name, html, agentId, lang),
  spawnAgent: (title?: string) => osSpawnAgent(title),
  closeAgent: (id: string) => osCloseAgent(id),
  renameAgent: (id: string, title: string) => osRenameAgent(id, title),
  systemUi: (name: string) => osSystemUi(name),
  systemUiInfo: (name: string) => osSystemUiInfo(name),
  groupIntoFolder: (name: string, ids: string[], x: number | undefined, y: number | undefined, kind: 'board' | 'folder') => osGroupIntoFolder(name, ids, x, y, kind),
  providerCall: (descriptor: Parameters<typeof runProviderCall>[0], transport: 'relay' | 'localhost') => runProviderCall(descriptor, transport === 'localhost' ? 'localhost' : 'relay'),
  integrationStatuses: () => integrationStatuses(),
  connectedProviders: () => connectedProviders(),
  setTheme: (theme: { accent?: unknown; accentDeep?: unknown }) => osSetTheme(theme)
} as Record<string, (...args: never[]) => unknown>

// The current relay url, injected by index.ts (the top-level wirer) to avoid an import cycle with
// agentSocket (which imports OS_TOOLS from here). Used to rebuild an agent's command on re-exec.
let terminalGetUrl: (() => string | null) | null = null
export function setTerminalGetUrl(fn: () => string | null): void { terminalGetUrl = fn }
let terminalAgentRuntime = process.env.BLITZ_AGENT_RUNTIME || process.env.BLITZ_AGENT_BACKEND || 'claude'
let terminalAgentCmd = process.env.BLITZ_AGENT && process.env.BLITZ_AGENT !== '1' ? process.env.BLITZ_AGENT : terminalAgentRuntime === 'codex-serverless' || terminalAgentRuntime === 'codex' ? 'codex' : 'claude'
export function setTerminalAgentRuntime(spec: { runtime?: string; cmd?: string } | null): void {
  if (spec?.runtime) terminalAgentRuntime = spec.runtime
  if (spec?.cmd) terminalAgentCmd = spec.cmd
}

// Terminal ops — the SHARED workspace-keyed lifecycle (terminal-ops.mjs). Electron seam: the active
// workspace folder + the os:action emit. The server binds the SAME makeTerminalOps with its own seam,
// so the terminal/agent model can't diverge between the two modes.
export const electronTerminalOps = makeTerminalOps({
  getWorkspacePath: () => osWorkspaceContext().workspace_path,
  emit: osBroadcast,
  getUrl: () => terminalGetUrl?.() ?? null,
  getAgentRuntime: () => ({ runtime: terminalAgentRuntime, cmd: terminalAgentCmd })
})
Object.assign(electronOps, electronTerminalOps)

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
