// Types for the shared session ops binding (session-ops.mjs).
import type { SessionManager, SpawnSessionOpts, SessionMeta } from './session-manager.d.mts'

export interface SessionOps {
  spawnSession(opts?: SpawnSessionOpts): Promise<SessionMeta | null>
  listSessions(): SessionMeta[]
  sendToSession(id: string, data: string): boolean
  readSession(id: string): string
  stopSession(id: string): boolean
  /** Close every control client on shutdown (sessions survive in their tmux servers). */
  stopHosts(): void
}

export interface SessionOpsDeps {
  /** Active workspace folder (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path). */
  getWorkspacePath: () => string | null | undefined
  /** Publish a session event to the renderer (server: SSE broadcast; Electron: webContents.send 'os:action'). */
  emit?: (ev: { type: string; id?: string; [k: string]: unknown }) => void
  markWrite?: (p: string) => void
}

export function makeSessionOps(deps: SessionOpsDeps): SessionOps
