// Types for the file-backed session manager (session-manager.mjs).
import type { PtyHost } from './pty-host.d.mts'

export type SessionKind = 'pty' | 'agent'
export type SessionStatus = 'running' | 'exited' | 'stopped'
export type Autonomy = 'auto' | 'checkpoint' | 'dry-run'

export interface SessionMeta {
  id: string
  kind: SessionKind
  title: string
  command: string | null
  cwd: string | null
  status: SessionStatus
  pid: number | null
  exitCode: number | null
  autonomy: Autonomy
  createdAt: number
  endedAt: number | null
  cols: number
  rows: number
}

export interface SpawnSessionOpts {
  kind?: SessionKind
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
  autonomy?: Autonomy
  id?: string
}

export interface SessionEvent {
  type: 'session-spawn' | 'session-data' | 'session-exit' | 'session-stop'
  id: string
  [k: string]: unknown
}

export interface SessionManagerDeps {
  ptyHost: PtyHost
  /** <workspace>/.blitzos/sessions — all session files live here (the workspace is the only datasource). */
  sessionsDir: string
  /** Publish a session event to the renderer (server: SSE broadcast; Electron: webContents.send). */
  emit?: (ev: SessionEvent) => void
  /** Tell the workspace watcher a write is the OS's own, so it doesn't reconcile itself. */
  markWrite?: (path: string) => void
}

export interface SessionManager {
  spawnSession(opts?: SpawnSessionOpts): SessionMeta
  sendToSession(id: string, data: string): boolean
  resizeSession(id: string, cols: number, rows: number): boolean
  stopSession(id: string): boolean
  restartSession(id: string): SessionMeta | null
  scrollback(id: string): string
  getSession(id: string): SessionMeta | null
  listSessions(): SessionMeta[]
  stopAll(): void
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager
