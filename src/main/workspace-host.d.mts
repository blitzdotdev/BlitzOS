// Types for the shared workspace host (workspace-host.mjs).
import type { WorkspaceEntry } from './workspace.mjs'

export interface WorkspaceHostAdapter {
  root: string
  initialName?: string
  getState(): { surfaces: unknown[]; camera?: { x: number; y: number; scale: number }; mode?: string; view?: { cx: number; cy: number } }
  setState(s: unknown): void
  broadcast(obj: unknown): void
  onSurfaces?: (surfaces: unknown[]) => Promise<unknown> | void
  defaultMode?: 'canvas' | 'desktop'
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
  appendChat(role: 'user' | 'agent', text: string): Array<{ role: string; text: string; ts: number }>
  group(name: string, memberIds: string[], x?: number, y?: number, kind?: 'board' | 'folder'): { ok: true; folder: string; moved: number } | { error: string }
  consent(): { surfaces: string[]; providers: string[] }
  persistConsent(c: { surfaces?: string[]; providers?: string[] }): void
}

export function createWorkspaceHost(a: WorkspaceHostAdapter): WorkspaceHost
