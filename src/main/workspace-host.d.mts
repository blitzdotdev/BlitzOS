// Types for the shared workspace host (workspace-host.mjs).
import type { WorkspaceEntry } from './workspace.mjs'

export interface WorkspaceHostAdapter {
  root: string
  initialName?: string
  /** true when initialName was PINNED by the user (BLITZ_WORKSPACE): skip boot-where-you-left-off. */
  explicitInitial?: boolean
  getState(): { surfaces: unknown[]; camera?: { x: number; y: number; scale: number }; mode?: string; view?: { cx: number; cy: number } }
  setState(s: unknown): void
  broadcast(obj: unknown): void
  onSurfaces?: (surfaces: unknown[]) => Promise<unknown> | void
  defaultMode?: 'canvas' | 'desktop'
  /** Launch (or resume) the claude terminal for a chat/agent session in its area. Wired by each transport
   *  from the shared agent-session core + its session-ops; absent ⇒ no agent auto-launch (BLITZ_AGENT off). */
  launchAgent?: (sessionId: string, area: number, title?: string) => void
}

export interface WorkspaceHost {
  active(): string
  activePath(): string
  isSwitching(): boolean
  hydrateOnBoot(): void
  onStatePush(s: unknown): void
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
  listDir(rel: string): { path: string; entries: Array<{ name: string; dir: boolean; ext: string; size: number; isImage: boolean; path: string }>; total: number; truncated: boolean } | null
  closeSurfaceFile(id: string): { ok: boolean; removed?: string; error?: string; skipped?: string }
  /** Item 4: which OTHER workspace holds surface `id` (or null). */
  locateSurface(id: string): { name: string; dir: string; node: Record<string, unknown> } | null
  /** Item 4: bring a surface from another workspace into the active one (id preserved). */
  bringSurfaceHere(id: string, x?: number, y?: number): { ok: boolean; from?: string; id?: string; notFound?: boolean; error?: string }
  appendChat(role: 'user' | 'agent', text: string, sessionId?: string, meta?: Record<string, unknown>): Array<{ role: string; text: string; ts: number }>
  customizeWidget(name: string, html: string, sessionId?: string): { ok: boolean; rel?: string; error?: string }
  systemUi(name: string): string | null
  chatSessionIds(): string[]
  newChatSessionId(): string
  addChatSession(sessionId: string, title?: string, opts?: { focus?: boolean }): Record<string, unknown>
  renameChatSession(sessionId: string, title: string): { ok: boolean; id?: string; title?: string; error?: string }
  stopChatSession(sessionId: string): { ok: boolean; id?: string }
  resumeAgentsOnBoot(): void
  setRelayUrl(url: string | null | undefined): void
  group(name: string, memberIds: string[], x?: number, y?: number, kind?: 'board' | 'folder'): { ok: true; folder: string; moved: number } | { error: string }
  consent(): { surfaces: string[]; providers: string[] }
  persistConsent(c: { surfaces?: string[]; providers?: string[] }): void
}

export function createWorkspaceHost(a: WorkspaceHostAdapter): WorkspaceHost
