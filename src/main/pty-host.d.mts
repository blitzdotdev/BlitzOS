// Types for the transport-agnostic PTY primitive (pty-host.mjs).

export interface PtySpawnOpts {
  /** Command to run. A bin ("bash") or a full string ("claude -p '…'") run via the login shell. */
  command?: string
  /** Explicit argv (skips shell-string parsing). */
  args?: string[]
  /** Working directory (defaults to process.cwd()). */
  cwd?: string
  /** Extra env vars, merged over process.env. */
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface PtyInfo {
  id: string
  pid: number
  file: string
  argv: string[]
  cwd: string
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
  signal: number | null
  startedAt: number
  endedAt: number | null
}

export interface PtyHost {
  spawn(id: string, opts?: PtySpawnOpts): PtyInfo
  write(id: string, data: string): boolean
  resize(id: string, cols: number, rows: number): boolean
  kill(id: string, signal?: string): boolean
  remove(id: string): void
  /** Subscribe to live output; replays scrollback first unless opts.replay === false. Returns an unsubscribe. */
  onData(id: string, cb: (data: string) => void, opts?: { replay?: boolean }): () => void
  onExit(id: string, cb: (e: { exitCode: number | null; signal: number | null }) => void): () => void
  has(id: string): boolean
  scrollback(id: string): string
  info(id: string): PtyInfo | null
  list(): PtyInfo[]
  stopAll(): void
}

export function createPtyHost(): PtyHost
