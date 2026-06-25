// Electron's binding of the SHARED tool registry (os-tools.mjs). Maps the runtime-agnostic tool handlers
// to Electron's primitive operations (osActions = IPC to the renderer + CDP via webContents). Both
// Electron transports import OS_TOOLS / OS_TOOLS_BY_PATH from HERE: agentSocket.ts (relay) maps the array,
// control-server.ts (localhost) dispatches the by-path map. The server (preview/backend.mjs) builds the SAME
// registry from its own ops — so there is one tool definition, zero Electron/server difference.
import { shell } from 'electron'
import { makeOsTools, makeOsToolsByPath, type OsTool } from './os-tools.mjs'
import {
  osCreateSurface,
  osOpenWindow,
  osMoveSurface,
  osUpdateSurface,
  osCloseSurface,
  osCloseSurfaceFile,
  onSurfaceClosed,
  setHydrateSurfaceRewriter,
  osGoToPrimary,
  osGetState,
  osWorkspaceContext,
  osListWorkspaces,
  osCreateWorkspace,
  osSwitchWorkspace,
  osReadWindow,
  osControlSurface,
  osSay,
  osShareApp,
  osUserMessage,
  osCustomizeWidget,
  osSpawnAgent,
  osCloseAgent,
  osRenameAgent,
  osAgentStatus,
  osSetOrchestrators,
  osSystemUi,
  osSystemUiInfo,
  osGroupIntoFolder,
  osBroadcast,
  osSetTheme,
  type SurfaceDescriptor
} from './osActions'
import { makeTerminalOps } from './terminal-ops.mjs'
import { makeActionItems } from './action-items.mjs'
import { makeConnectionOps } from './connection-ops.mjs'
import { emitSurfaceAction } from './events'
import { runWorkflowHosted } from './workflow-host.mjs'
import { blitzChromeOps } from './blitz-chrome'

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
  shareApp: (app: Record<string, unknown>, agentId?: string, workspace?: string) => osShareApp(app, agentId, workspace),
  // user_say (localhost-only test syscall): programmatic user input through the human composer's exact path
  userMessage: (text: string, agentId?: string) => osUserMessage(text, agentId),
  // steer (W2 supervisor): nudge a SPECIFIC agent — same waking path as a user message (osUserMessage appends
  // to that agent's chat.md + emits a 'message' moment that wakes ONLY that agent). `say` doesn't wake the
  // target (it's agent->user) and `user_say` is localhost-only; steer is the relay-safe wake-a-target path.
  steer: (text: string, agentId: string) => osUserMessage(text, agentId),
  // broadcast (steer-all): the live agent-id roster for the current workspace host, so makeOsTools's
  // /broadcast route can fan `steer` over every peer except the sender. Same source the W2 tick + narrator use.
  listAgents: () => Object.keys(osAgentStatus() || {}),
  customizeWidget: (name: string, html: string, agentId?: string, lang?: 'html' | 'jsx' | 'tsx') => osCustomizeWidget(name, html, agentId, lang),
  spawnAgent: (title?: string) => osSpawnAgent(title),
  closeAgent: (id: string) => osCloseAgent(id),
  renameAgent: (id: string, title: string) => osRenameAgent(id, title),
  setOrchestrators: (agent: string, on: boolean) => osSetOrchestrators(agent, on),
  // start_workflow (replaces the retired start_job): spawn a fresh agent with the ORCHESTRATORS capability ON — so
  // its FIRST bootstrap already carries the orchestrator duty (osSpawnAgent -> addAgent stamps the flag, then
  // launchAgent's prepareAgentLaunch reads bootTaskProvider) — then SEED it with the task (+ any dropped context
  // refs) as its first directive. The orchestrator agent itself decides whether the task warrants a blitzscript
  // workflow (hard/large/parallel) or a direct answer. The task lands in chat.md, read on boot, so no re-exec.
  startWorkflow: (spec: { title?: string; task: string; contextRefs?: string[] }) => {
    const agent = osSpawnAgent(spec.title, false, true)
    const refs = Array.isArray(spec.contextRefs) && spec.contextRefs.length
      ? `\n\nContext (dropped onto the launcher):\n${spec.contextRefs.map((r) => `- ${r}`).join('\n')}` : ''
    try { osUserMessage(`${spec.task || ''}${refs}`, agent.id) } catch { /* the agent still boots with the duty; the task lands when chat.md is read */ }
    return { ok: true, agent }
  },
  // run_workflow (live externalization): run a blitzscript workflow IN-PROCESS so its WfEvents stream to the
  // bus and into the live widget the tool just placed. Returns immediately (the run continues in background).
  runWorkflow: (spec: { file: string; args?: unknown; runId?: string; surfaceId?: string | null; view?: string; agentId?: string }) => runWorkflowHosted(spec),
  systemUi: (name: string) => osSystemUi(name),
  systemUiInfo: (name: string) => osSystemUiInfo(name),
  groupIntoFolder: (name: string, ids: string[], x: number | undefined, y: number | undefined, kind: 'board' | 'folder') => osGroupIntoFolder(name, ids, x, y, kind),
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

// Connections (connection-ops.mjs) — the SHARED registry + per-source tool store + dispatch, bound to
// Electron's surface primitives. The tab (Chrome extension) and window (BlitzOS helper) adapters
// bind through electronConnections.connectionBind / report changes via connectionNotify. Object.assign'd
// BEFORE makeOsTools(electronOps) below so the connection_* tool handlers find these ops.
export const electronConnections = makeConnectionOps({
  getWorkspacePath: () => osWorkspaceContext().workspace_path,
  createSurface: (desc: SurfaceDescriptor) => osCreateSurface(desc),
  updateSurface: (id: string, patch: Record<string, unknown>) => osUpdateSurface(id, patch),
  closeSurface: (id: string) => {
    osCloseSurfaceFile(id)
    osCloseSurface(id)
  },
  getSurfaces: () => (osGetState().surfaces || []) as Array<Record<string, unknown>>,
  // An agent is "available" to author a connection's view iff a managed agent terminal is running. Used to
  // word the placeholder honestly (no "the agent is building a view" when none is running).
  isAgentAvailable: () => {
    try {
      return electronTerminalOps.listTerminals().some((t) => t.kind === 'agent' && t.status === 'running')
    } catch {
      return false
    }
  },
  // MCP OAuth approval: BlitzOS opens the one-time authorize URL in the user's default browser (connectMcp then
  // awaits the loopback catch). shell.openExternal only accepts http/https; connectMcp builds an https/loopback
  // authorize URL, so this is safe (never opens a file:/custom-scheme URL).
  openExternal: (url: string) => {
    try {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
    } catch {
      /* the authUrl is still returned for a manual open */
    }
  }
})
Object.assign(electronOps, electronConnections)
// Blitz Chrome (blitz-chrome.ts) — the SECOND, extension-free AI-browsing path: a dedicated Chrome driven over
// --remote-debugging-port (CDP). Independent of the extension/chrome.debugger path above; Object.assign'd here
// so the blitz_chrome_* tool handlers in os-tools.mjs find these ops. The headless server transport simply
// omits them and those tools return 501 (guarded), exactly like the other Electron-only ops.
Object.assign(electronOps, blitzChromeOps)

// Closing a connection's representation widget drops the connection (no leaked adapter/socket).
onSurfaceClosed((id) => void electronConnections.handleSurfaceClosed(id))
// On (re)hydrate, repaint persisted connection widgets whose connection isn't live → "disconnected".
setHydrateSurfaceRewriter((s) => electronConnections.rewriteHydratedSurface(s))

export const OS_TOOLS: OsTool[] = makeOsTools(electronOps)
export const OS_TOOLS_BY_PATH: Record<string, OsTool> = makeOsToolsByPath(electronOps)
