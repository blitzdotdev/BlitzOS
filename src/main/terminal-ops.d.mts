// Types for the shared terminal ops binding (terminal-ops.mjs).
import type { SpawnTerminalOpts, TerminalMeta } from './terminal-manager.d.mts'

export interface TerminalOps {
  spawnTerminal(opts?: SpawnTerminalOpts): Promise<TerminalMeta | null>
  listTerminals(): TerminalMeta[]
  sendToTerminal(id: string, data: string): boolean
  resizeTerminal(id: string, cols: number, rows: number): boolean
  readTerminal(id: string): string
  /** Current rendered pane text (capture-pane -p) — the wake watchdog diffs it across a settle window. */
  captureTerminal(id: string): string
  /** External-terminal handoff: `tmux attach` coordinates for a live terminal's window (open it in a real
   *  terminal app like Ghostty). `window` is the unambiguous tmux window-id (@N). null when no live window. */
  attachSpec(id: string): { bin: string; socket: string; session: string; window: string } | null
  stopTerminal(id: string): boolean
  removeTerminal(id: string): boolean
  /** Re-spawn a dead terminal from its persisted meta (one-click resume). */
  restartTerminal(id: string): Promise<TerminalMeta | null>
  /** Clear an agent's claude context on demand (rotate its session id + restart → empty conversation). */
  clearAgentContext(id: string): Promise<boolean>
  /** A terminal's current record (live or persisted), or null — tells a reattached survivor from a dead one. */
  getTerminal(id: string): TerminalMeta | null
  /** Whether a terminal is wired to a live tmux window THIS run (survivor or fresh spawn) — for boot resume. */
  isTerminalLive(id: string): boolean
  /** Awaits adoption of survivors for the active workspace (so boot resume doesn't race restore()). */
  whenRestored(): Promise<string[]>
  /** Close every control client on shutdown (terminals survive in their tmux servers). */
  stopHosts(): void
}

export interface TerminalOpsDeps {
  /** Active workspace folder (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path). */
  getWorkspacePath: () => string | null | undefined
  /** Publish a terminal event to the renderer (server: SSE broadcast; Electron: webContents.send 'os:action'). */
  emit?: (ev: { type: string; id?: string; [k: string]: unknown }) => void
  markWrite?: (p: string) => void
  /** Current agent-socket relay url — to rebuild an agent's command (fresh url + --resume) on re-exec. */
  getUrl?: () => string | null | undefined
  /** The agent binary/command (BLITZ_AGENT, default 'claude') — preserved when rebuilding an agent's command. */
  agentCmd?: string
  /** Agent backend runtime (e.g. 'claude' or 'codex-serverless') used when rebuilding a command. */
  agentRuntime?: string
  getAgentRuntime?: (meta: TerminalMeta) => { runtime?: string; cmd?: string } | null | undefined
}

export function makeTerminalOps(deps: TerminalOpsDeps): TerminalOps
