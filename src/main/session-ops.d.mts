// Types for the shared session ops binding (session-ops.mjs).
import type { SessionManager, SpawnSessionOpts, SessionMeta } from './session-manager.d.mts'

export interface SessionOps {
  spawnSession(opts?: SpawnSessionOpts): Promise<SessionMeta | null>
  listSessions(): SessionMeta[]
  sendToSession(id: string, data: string): boolean
  resizeSession(id: string, cols: number, rows: number): boolean
  readSession(id: string): string
  stopSession(id: string): boolean
  /** Re-spawn a dead session from its persisted meta (one-click resume). */
  restartSession(id: string): Promise<SessionMeta | null>
  /** A session's current record (live or persisted), or null — tells a reattached survivor from a dead one. */
  getSession(id: string): SessionMeta | null
  /** Whether a session is wired to a live tmux window THIS run (survivor or fresh spawn) — for boot resume. */
  isSessionLive(id: string): boolean
  /** Awaits adoption of survivors for the active workspace (so boot resume doesn't race restore()). */
  whenRestored(): Promise<string[]>
  /** Close every control client on shutdown (sessions survive in their tmux servers). */
  stopHosts(): void
}

export interface SessionOpsDeps {
  /** Active workspace folder (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path). */
  getWorkspacePath: () => string | null | undefined
  /** Publish a session event to the renderer (server: SSE broadcast; Electron: webContents.send 'os:action'). */
  emit?: (ev: { type: string; id?: string; [k: string]: unknown }) => void
  markWrite?: (p: string) => void
  /** Current agent-socket relay url — to rebuild an agent's command (fresh url + --resume) on re-exec. */
  getUrl?: () => string | null | undefined
  /** The agent binary/command (BLITZ_AGENT, default 'claude') — preserved when rebuilding an agent's command. */
  agentCmd?: string
}

export function makeSessionOps(deps: SessionOpsDeps): SessionOps
