// Types for the shared workspace host (workspace-host.mjs).
import type { WorkspaceEntry } from './workspace.mjs'

export interface WorkspaceHostAdapter {
  root: string
  initialName?: string
  /** true when initialName was PINNED by the user (BLITZ_WORKSPACE): skip boot-where-you-left-off. */
  explicitInitial?: boolean
  getState(): { surfaces: unknown[] }
  setState(s: unknown): void
  broadcast(obj: unknown): void
  onSurfaces?: (surfaces: unknown[]) => Promise<unknown> | void
  /** Launch (or resume) the managed terminal for an agent in its stage. Wired by each transport
   *  from the shared agent-runtime core + its terminal-ops; absent ⇒ no agent auto-launch. */
  launchAgent?: (agentId: string, stage: number, title?: string) => void
  /** Park an agent's terminal without deleting its persisted record; used when archiving. */
  pauseAgent?: (agentId: string) => void
  /** Restart a parked/exited managed agent terminal from its persisted record; used when restoring. */
  restartAgent?: (agentId: string) => void
  /** Permanently stop/remove an agent terminal record. Wired by each transport; used when closing an agent. */
  stopAgent?: (agentId: string) => void
  /** The authoritative action-items list (listActions()); the inbox surface's items are reconciled to it. */
  getActionItems?: () => unknown[]
  /** Optional Electron-only V1 helper: generate a short title from an agent's first user message. */
  generateAgentTitle?: (input: { agentId: string; text: string; workspacePath: string }) => Promise<string | null> | string | null
  /** Optional safe activity seam: called only when the effective chat status changes. */
  onChatStatusTransition?: (change: { agentId: string; previousStatus?: string; status: string; source?: string }) => void
}

export interface WorkspaceHost {
  active(): string
  activePath(): string
  isSwitching(): boolean
  hydrateOnBoot(): void
  onStatePush(s: unknown): void
  /** The surfaces for a connecting renderer's hydrate (osState surfaces + inbox items reconciled to the store). */
  hydrateSurfaces(): unknown[]
  performSwitch(name: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  flush(): void
  startWatch(): void
  stopWatch(): void
  list(): WorkspaceEntry[]
  create(name: string): { name: string; path: string }
  removeWorkspace(name: string): Promise<{ ok: boolean; active?: string; error?: string }>
  writeThumb(name: string, buf: Buffer): boolean
  readThumb(name: string): Buffer | null
  readWorkspaceFile(rel: string): { buf: Buffer; contentType: string } | null
  ingestFile(name: string, buffer: Buffer, x: number, y: number): { ok: true; name: string } | { error: string }
  ingestPaths(paths: string[], x: number, y: number): { ok: true; copied: number } | { error: string }
  ingestUpload(relPath: string, buffer: Buffer, x: number, y: number, reconcile?: boolean): { ok: true; name: string } | { error: string }
  reconcileAt(x: number, y: number): { ok: true } | { error: string }
  newFolder(name: string, kind: 'board' | 'folder' | undefined, x: number, y: number): { ok: true; folder: string } | { error: string }
  listDir(rel: string): { path: string; entries: Array<{ name: string; dir: boolean; ext: string; size: number; entries?: number; isImage: boolean; path: string }>; total: number; truncated: boolean } | null
  renameFolder(rel: string, name: string): { ok: boolean; path?: string; error?: string }
  moveIntoFolder(folderPath: string, ids: string[]): { ok: boolean; moved?: number; skipped?: number; movedIds?: string[]; skippedIds?: string[]; error?: string }
  moveOutOfFolder(paths: string[], x?: number, y?: number): { ok: boolean; moved?: number; skipped?: number; movedPaths?: string[]; skippedPaths?: string[]; pathMoves?: Array<{ from: string; to: string }>; surfaceIds?: string[]; surfaces?: Record<string, unknown>[]; updatedIds?: string[]; updatedSurfaces?: Record<string, unknown>[]; error?: string }
  openFolderEntry(rel: string, x?: number, y?: number): { ok: boolean; id?: string; surface?: Record<string, unknown>; error?: string }
  closeSurfaceFile(id: string): { ok: boolean; removed?: string; error?: string; skipped?: string; keptFile?: boolean }
  /** Item 4: which OTHER workspace holds surface `id` (or null). */
  locateSurface(id: string): { name: string; dir: string; node: Record<string, unknown> } | null
  /** Item 4: bring a surface from another workspace into the active one (id preserved). */
  bringSurfaceHere(id: string, x?: number, y?: number): { ok: boolean; from?: string; id?: string; notFound?: boolean; error?: string }
  appendChat(role: 'user' | 'agent', text: string, agentId?: string, meta?: Record<string, unknown>): Array<{ role: string; text: string; ts: number; parts?: unknown[] }>
  customizeWidget(name: string, html: string, agentId?: string, lang?: 'html' | 'jsx' | 'tsx'): { ok: boolean; rel?: string; lang?: string; error?: string }
  systemUi(name: string): string | null
  systemUiInfo(name: string): { rel: string; source: string; lang: 'html' | 'jsx' | 'tsx' } | null
  setChatStatus(agentId: string, status: 'idle' | 'starting' | 'working' | 'watching' | 'waiting' | 'stopped' | 'error', cause?: string): { ok: boolean }
  noteAgentActivity(agentId: string, source?: string): { ok: boolean; throttled?: boolean; error?: string }
  noteWorkflowRun(agentId: string, runId: string, active: boolean): { ok: boolean; error?: string }
  /** Snapshot { agentId -> status } of every chat-bearing agent — the W2 supervisor tick's agent-state input. */
  chatStatusSnapshot(): Record<string, 'idle' | 'starting' | 'working' | 'watching' | 'waiting' | 'stopped' | 'error'>
  /** Full chat-hub props for one active agent: the session roster + per-session transcripts + status. Used by
   *  the dynamic island's one-shot snapshot (osAgentsSnapshot) and the live `{type:'chat'}` broadcast. */
  chatHubProps(activeAgentId?: string): {
    sessions: Array<{ id: string; title: string; status: string; updatedAt: number; lastMessagePreview: string; unread: boolean }>
    archivedSessions: Array<{ id: string; title: string; status: string; updatedAt: number; lastMessagePreview: string; unread: boolean; archivedAt?: number }>
    threads: Record<string, Array<{ role: string; text: string; ts?: number; userIdx?: number; parts?: unknown[] }>>
    status: Record<string, string>
    errors: Record<string, { cause: string; title: string; hint: string; retryable: boolean }>
    activeAgentId: string
    messages: Array<{ role: string; text: string; ts?: number; userIdx?: number; parts?: unknown[] }>
    agentId: string
    sessionId: string
  }
  agentIds(): string[]
  restoreChatHub(): { ok: boolean; id?: string; error?: string }
  newAgentId(): string
  addAgent(agentId: string, title?: string, opts?: { focus?: boolean; orchestrators?: boolean }): Record<string, unknown>
  setAgentOrchestrators(agentId: string, on: boolean): { ok: boolean; error?: string; orchestrators?: boolean }
  archiveAgent(agentId: string): { ok: boolean; error?: string; archived?: boolean }
  unarchiveAgent(agentId: string): { ok: boolean; error?: string; archived?: boolean }
  closeAgent(agentId: string): { ok: boolean; error?: string }
  renameAgent(agentId: string, newTitle: string): { ok: boolean; error?: string; title?: string }
  resumeAgentsOnBoot(): void
  setRelayUrl(url: string | null | undefined): void
  group(name: string, memberIds: string[], x?: number, y?: number, kind?: 'board' | 'folder'): { ok: true; folder: string; moved: number } | { error: string }
  consent(): { surfaces: string[]; providers: string[] }
  persistConsent(c: { surfaces?: string[]; providers?: string[] }): void
}

export function createWorkspaceHost(a: WorkspaceHostAdapter): WorkspaceHost
