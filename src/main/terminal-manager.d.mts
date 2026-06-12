// Types for the file-backed terminal manager (terminal-manager.mjs), backed by the tmux host.
import type { TmuxHost } from './tmux-host.d.mts'

export type TerminalKind = 'terminal' | 'agent'
export type TerminalStatus = 'running' | 'exited' | 'stopped'
export type Autonomy = 'auto' | 'checkpoint' | 'dry-run'
export type AgentRuntime = 'claude' | 'codex-serverless' | string

export interface TerminalMeta {
  id: string
  kind: TerminalKind
  title: string
  command: string | null
  cwd: string | null
  status: TerminalStatus
  pid: number | null
  exitCode: number | null
  autonomy: Autonomy
  createdAt: number
  endedAt: number | null
  cols: number
  rows: number
  /** the workspace stage this terminal belongs to (agent N → stage N); null = unscoped (human spawn). */
  stage?: number | null
  /** @deprecated legacy pre-stage-rename meta field; tolerated on read, written as `stage`. */
  area?: number | null
  /** agent terminals only: persisted claude --session-id token + whether claude has established it. */
  agentRuntime?: AgentRuntime | null
  agentSessionId?: string | null
  claudeSessionId?: string
  claudeEstablished?: boolean
}

export interface SpawnTerminalOpts {
  kind?: TerminalKind
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
  autonomy?: Autonomy
  id?: string
  stage?: number | null
  /** @deprecated legacy pre-stage-rename opt; tolerated on read, written as `stage`. */
  area?: number | null
  agentRuntime?: AgentRuntime | null
  agentSessionId?: string | null
  claudeSessionId?: string
  claudeEstablished?: boolean
}

export interface TerminalEvent {
  type: 'terminal-spawn' | 'terminal-data' | 'terminal-exit' | 'terminal-stop'
  id: string
  [k: string]: unknown
}

export interface TerminalManagerDeps {
  /** The tmux control-mode host (tmux-host.mjs). */
  host: TmuxHost
  /** <workspace>/.blitzos/terminals — all terminal files live here (the workspace is the only datasource). */
  terminalsDir: string
  /** Publish a terminal event to the renderer (server: SSE broadcast; Electron: webContents.send). */
  emit?: (ev: TerminalEvent) => void
  /** Tell the workspace watcher a write is the OS's own, so it doesn't reconcile itself. */
  markWrite?: (path: string) => void
  /** Rebuild a managed AGENT terminal's command on re-exec; null ⇒ shell verbatim. */
  rebuildAgentCommand?: ((meta: TerminalMeta) => {
    command: string
    agentRuntime?: AgentRuntime | null
    agentSessionId?: string | null
    claudeSessionId?: string
    established?: boolean
  } | null) | null
}

export interface TerminalManager {
  spawnTerminal(opts?: SpawnTerminalOpts): Promise<TerminalMeta>
  sendToTerminal(id: string, data: string): boolean
  resizeTerminal(id: string, cols: number, rows: number): boolean
  stopTerminal(id: string): boolean
  removeTerminal(id: string): boolean
  restartTerminal(id: string): Promise<TerminalMeta | null>
  /** Reattach-on-boot: adopt tmux windows that survived a restart; returns adopted ids. */
  restore(): Promise<string[]>
  scrollback(id: string): string
  getTerminal(id: string): TerminalMeta | null
  /** Whether a terminal is wired to a live tmux window THIS run (a survivor adopted by restore, or fresh). */
  isLive(id: string): boolean
  listTerminals(): TerminalMeta[]
  stopAll(): void
}

export function createTerminalManager(deps: TerminalManagerDeps): TerminalManager
