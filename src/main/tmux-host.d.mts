// Types for the tmux control-mode terminal host (tmux-host.mjs).

export interface TmuxHostConfig {
  /** Absolute path to the tmux server socket. Put under <workspace>/.blitzos/tmux/ to keep it in-workspace. */
  socketPath: string
  /** The single tmux session that holds one window per BlitzOS terminal. Default "blitz". */
  sessionName?: string
  cols?: number
  rows?: number
  /** Overrides TMUX_TMPDIR for the spawned tmux processes. */
  tmuxTmpdir?: string
}

export interface TmuxSpawnOpts {
  /** A shell-command string (run via the shell), e.g. "bash", "codex exec '…'", or "claude '…'". */
  command?: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface TmuxSessionInfo {
  id: string
  pid: number | null
  /** tmux window id (@N). */
  window: string
  /** tmux pane id (%N). */
  pane: string
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
  startedAt: number
  endedAt: number | null
}

export interface TmuxHost {
  /** Connect the control client (create the session if absent, else attach — enables reattach). */
  start(): Promise<void>
  /** Spawn a terminal = a tmux window named with the id; resolves once tmux assigns the pane. */
  spawn(id: string, opts?: TmuxSpawnOpts): Promise<TmuxSessionInfo | null>
  write(id: string, data: string): boolean
  resize(id: string, cols: number, rows: number): boolean
  kill(id: string): boolean
  remove(id: string): void
  onData(id: string, cb: (data: string) => void, opts?: { replay?: boolean }): () => void
  onExit(id: string, cb: (e: { exitCode: number | null; signal: number | null }) => void): () => void
  scrollback(id: string): string
  /** Current rendered pane text (capture-pane -p, no escapes) — for the wake watchdog frozen-check. */
  capture(id: string): string
  has(id: string): boolean
  info(id: string): TmuxSessionInfo | null
  list(): TmuxSessionInfo[]
  /** Coordinates for an external terminal app (Ghostty) to `tmux attach` this terminal's live window.
   *  `window` is the unambiguous tmux window-id (@N) — numeric blitz ids collide with window indexes, so
   *  a session:name target is unsafe. null when tmux is unavailable or the terminal isn't a live window. */
  attachSpec(id: string): { bin: string; socket: string; session: string; window: string } | null
  /** Reattach-on-boot: adopt windows (named with ids) already live in the tmux server. Returns adopted ids. */
  adoptExisting(): Promise<string[]>
  /** Close the control client — terminals SURVIVE (the tmux server keeps running). */
  stop(): void
  /** Kill the tmux server — all terminals DIE. */
  killServer(): void
  /** Kill every terminal's window. */
  stopAll(): void
}

/** Resolve the tmux binary for a packaged app (env → well-known paths → login shell). Null = not installed. */
export function resolveTmuxBin(): string | null
export function createTmuxHost(cfg: TmuxHostConfig): TmuxHost

/** Absolute path to the tmux binary (BLITZ_TMUX_BIN → well-known paths → login shell), cached;
 *  null = not installed. */
