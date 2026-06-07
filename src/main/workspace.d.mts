// Types for the workspace serializer (workspace.mjs): write + read(hydrate) + reconcile.

export interface WriteWorkspaceResult {
  metaFile: string
  nodeCount: number
}

/** Project osState onto a workspace folder (.blitzos/workspace.json + content files). */
export function writeWorkspace(dir: string, osState: unknown): WriteWorkspaceResult

export interface HydratedWorkspace {
  surfaces: Array<Record<string, unknown>>
  camera: { x: number; y: number; scale: number }
  mode: 'desktop' | 'canvas'
  /** #45: number of tiled workspace areas (1 for old folders / missing / invalid). */
  areaCount: number
}

/** Reconstruct surface descriptors from a workspace folder (inverse of writeWorkspace). */
export function readWorkspace(dir: string): HydratedWorkspace | null

/** True if BlitzOS wrote this absolute path within the suppression window (Phase 3 watcher). */
export function wasSelfWrite(absPath: string, windowMs?: number): boolean

/** #52: real "group into folder" — mkdir a subdir + mv the members' content files into it. */
export function groupIntoFolder(dir: string, name: string, memberIds: string[], kind?: 'board' | 'folder'): { ok: boolean; folder?: string; moved?: number; error?: string }

/** Copy a dropped real file/dir (by absolute OS path — Electron) into the workspace; dirs copy recursively. */
export function copyDroppedEntry(dir: string, srcPath: string): { rel: string; isDir: boolean } | null

/** Write a dropped file at a relative subpath under the workspace (server folder-drop; jailed, mkdir -p). */
export function writeDroppedFileAt(dir: string, relPath: string, buffer: Buffer | Uint8Array): { rel: string } | null

/** Make an EMPTY real folder ('New Folder') or '.board' on-canvas folder ('New Board') in the workspace root. */
export function createFolder(dir: string, name: string, kind?: 'board' | 'folder'): { ok: boolean; folder?: string; error?: string }

/** CLOSE a surface = explicitly delete its backing content file by id (jailed; never a real dropped file). */
export function removeSurfaceFile(dir: string, id: string): { ok: boolean; removed?: string; skipped?: string }

export interface DirEntry { name: string; dir: boolean; ext: string; size: number; isImage: boolean; path: string }
/** List a normal folder's contents for the file-manager overlay — jailed, dotfiles hidden, capped at 1000. */
export function listDir(dir: string, rel: string): { path: string; entries: DirEntry[]; total: number; truncated: boolean } | null

/** #53: per-workspace consent persisted under .blitzos/state/consent.json (agent-read-denied). */
export function writeConsent(dir: string, consent: { surfaces?: string[]; providers?: string[] }): void
export function readConsent(dir: string): { surfaces: string[]; providers: string[] }

/** Reconcile the canvas with the folder (auto-place new files, heal rename, drop missing). */
export function reconcileWorkspace(
  dir: string,
  placeAt?: { cx?: number; cy?: number }
): (HydratedWorkspace & { changed: boolean }) | null

// ---- Multi-workspace: a ROOT folder holds many workspace folders. ----

export interface WorkspaceEntry {
  name: string
  path: string
  nodeCount: number
  updatedAt: number
  /** mtime (ms) of the cached primary-area thumbnail, 0 if none (cache-busts the overview tile). */
  thumbTs: number
}

/** Validate a RAW workspace name (strict allow-list). Returns the NFC name or null. */
export function safeName(name: unknown): string | null

/** Resolve a name to a realpath-jailed absolute path under root (or null). */
export function resolveWorkspace(root: string, name: string, opts: { mustExist: boolean }): string | null

/** List workspace folders under root, newest-edited first. */
export function listWorkspaces(root: string): WorkspaceEntry[]

/** Create + scaffold a new workspace. Throws Error with .code 'EINVAL' | 'EEXIST'. */
export function createWorkspace(root: string, name: string): { name: string; path: string }
