// Electron's binding of the SHARED tool registry (os-tools.mjs). Maps the runtime-agnostic tool handlers
// to Electron's primitive operations (osActions = IPC to the renderer + CDP via webContents). Both
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
  onSurfaceClosed,
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
  osClearBrainContext,
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
import { makeJob, setJobStatus as jobSetStatus, readJob, dutyForJobStatus } from './job-model.mjs'

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
  // steer (W2 supervisor): nudge a SPECIFIC agent — same waking path as a user message (osUserMessage appends
  // to that agent's chat.md + emits a 'message' moment that wakes ONLY that agent). `say` doesn't wake the
  // target (it's agent->user) and `user_say` is localhost-only; steer is the relay-safe wake-a-target path.
  steer: (text: string, agentId: string) => osUserMessage(text, agentId),
  customizeWidget: (name: string, html: string, agentId?: string, lang?: 'html' | 'jsx' | 'tsx') => osCustomizeWidget(name, html, agentId, lang),
  spawnAgent: (title?: string) => osSpawnAgent(title),
  closeAgent: (id: string) => osCloseAgent(id),
  renameAgent: (id: string, title: string) => osRenameAgent(id, title),
  // Jobs (job-model.mjs): startJob spawns a fresh agent (the bare-peer spawnAgent primitive) WITH the job stamped
  // onto its meta BEFORE the terminal launches — so the agent's FIRST bootstrap already carries the planning duty
  // (osSpawnAgent -> addAgent writes the job, then launchAgent's prepareAgentLaunch reads bootTaskProvider). No
  // post-spawn re-exec: the earlier re-exec was a silent no-op (clearAgentContext's claudeSessionId guard fails on
  // a just-spawned agent whose terminal hasn't written its session id yet), so the planning duty never landed.
  startJob: (spec: { title?: string; goal: string; contextRefs?: string[] }) => {
    const job = makeJob({ goal: spec.goal, title: spec.title, contextRefs: spec.contextRefs })
    const agent = osSpawnAgent(spec.title, false, job)
    return { ok: true, agent, job }
  },
  // setJobStatus validates + writes meta.job.status; when the new status crosses a DUTY boundary (e.g. approved or
  // proposed -> running = PLAN -> EXECUTE) it re-execs the job agent into the new duty by clearing its brain context
  // (the interview->resident handoff path), so the boot-task mapper re-reads the job and injects the new duty. Safe
  // here (the agent is alive with a session id by now, unlike the just-born start_job case).
  setJobStatus: (agent: string, status: string, fields?: { planSurfaceId?: string; planPath?: string }) => {
    const before = readJob(agent)
    const r = jobSetStatus(agent, status, fields)
    // Only a real STATUS change across a DUTY boundary re-execs; a planSurfaceId-only bind (empty status) must not
    // (dutyForJobStatus('') is null, so afterDuty is null and this is skipped — the W1 widget-bind never re-execs).
    if (r.ok && before && status) {
      const afterDuty = dutyForJobStatus(status)
      if (afterDuty && afterDuty !== dutyForJobStatus(before.status)) osClearBrainContext(agent)
    }
    return r
  },
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
// Electron's surface primitives. The tab (Chrome extension) and window (BlitzComputerUse helper) adapters
// bind through electronConnections.connectionBind / report changes via connectionNotify. Object.assign'd
// BEFORE makeOsTools(electronOps) below so the connection_* tool handlers find these ops.
export const electronConnections = makeConnectionOps({
  getWorkspacePath: () => osWorkspaceContext().workspace_path,
  createSurface: (desc: SurfaceDescriptor) => osCreateSurface(desc),
  updateSurface: (id: string, patch: Record<string, unknown>) => osUpdateSurface(id, patch),
  closeSurface: (id: string) => {
    osCloseSurfaceFile(id)
    osCloseSurface(id)
  }
})
Object.assign(electronOps, electronConnections)
// Closing a connection's representation widget drops the connection (no leaked adapter/socket).
onSurfaceClosed((id) => void electronConnections.handleSurfaceClosed(id))

export const OS_TOOLS: OsTool[] = makeOsTools(electronOps)
export const OS_TOOLS_BY_PATH: Record<string, OsTool> = makeOsToolsByPath(electronOps)
