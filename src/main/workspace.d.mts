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

export function renameFolder(dir: string, rel: string, name: string): { ok: boolean; path?: string; error?: string }
export function moveIntoFolder(dir: string, folderRel: string, memberIds: string[]): { ok: boolean; moved?: number; skipped?: number; movedIds?: string[]; skippedIds?: string[]; error?: string }
export function moveOutOfFolder(dir: string, paths: string[], placeAt?: { x?: number; y?: number }): { ok: boolean; moved?: number; skipped?: number; movedPaths?: string[]; skippedPaths?: string[]; pathMoves?: Array<{ from: string; to: string }>; surfaceIds?: string[]; surfaces?: Record<string, unknown>[]; updatedIds?: string[]; updatedSurfaces?: Record<string, unknown>[]; error?: string }
export function openFolderEntry(dir: string, rel: string, placeAt?: { x?: number; y?: number }): { ok: boolean; id?: string; surface?: Record<string, unknown>; error?: string }

/** CLOSE a surface = explicitly delete its backing content file by id (jailed; never a real dropped file). */
export function removeSurfaceFile(dir: string, id: string): { ok: boolean; removed?: string; skipped?: string; keptFile?: boolean }

export interface DirEntry { name: string; dir: boolean; ext: string; size: number; entries?: number; isImage: boolean; path: string }
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
  /** mtime (ms) of the cached home-frame thumbnail, 0 if none (cache-busts the overview tile). */
  thumbTs: number
}

/** Validate a RAW workspace name (strict allow-list). Returns the NFC name or null. */
export function safeName(name: unknown): string | null

/** Resolve a name to a realpath-jailed absolute path under root (or null). */
export function resolveWorkspace(root: string, name: string, opts: { mustExist: boolean }): string | null

/** Append one chat message to a workspace folder's chat[-<sessionId>].md (path-based; any workspace). */
export function appendChatMessage(dir: string, role: 'user' | 'agent', text: string, sessionId?: string, meta?: Record<string, unknown>): void

/** The chat transcript path for an agent id (workspace-root relative): `.blitzos/agents/<id>/chat.md`.
 *  Private per-agent so no sibling chat is readable from the shared root (cross-agent context isolation). */
export function chatFileName(sessionId?: string): string

/** One-time migration: move any root-resident transcript (chat.md / chat-<id>.md) into its private
 *  per-agent dir (chatFileName). Idempotent + history-preserving; runs at workspace-open and before launch. */
export function relocateLegacyChats(dir: string): void

/** List workspace folders under root, newest-edited first. */
export function listWorkspaces(root: string): WorkspaceEntry[]

/** Create + scaffold a new workspace. Throws Error with .code 'EINVAL' | 'EEXIST'. */
export function createWorkspace(root: string, name: string): { name: string; path: string }

/** Delete a workspace folder (rm -rf, realpath-jailed). Throws Error with .code 'EINVAL' | 'ENOENT'. */
export function deleteWorkspace(root: string, name: string): { name: string }

// ---- cross-workspace surface addressing (item 4) ----
/** Locate which workspace holds surface `id` (skipping `exceptDir`). Null if not found. */
export function findSurfaceWorkspace(root: string, id: string, exceptDir?: string): { name: string; dir: string; node: Record<string, unknown> } | null
/** Move surface `id` from its workspace INTO destDir (file move + node transfer, id preserved). Returns
 *  the reconstructed descriptor + source name, or null if not elsewhere / unmovable. */
export function relocateSurface(root: string, destDir: string, id: string, placeAt?: { x?: number; y?: number }): { surface: Record<string, unknown>; fromName: string } | null

// ---- machine-global root state (<root>/.blitzos/state.json): the OS runtime journal ----

export interface BootRecord {
  pid: number
  mode: string
  bootedAt: number
  heartbeatAt: number
  cleanShutdown: boolean
}
export interface RootState {
  lastActiveWorkspace?: string
  boot?: BootRecord
  [k: string]: unknown
}
export function readRootState(root: string): RootState
/** Shallow top-level merge + atomic write. Pass a whole sub-object to replace it. */
export function patchRootState(root: string, patch: Partial<RootState>): RootState

// ---- per-origin browser permission decisions (machine-global, in the root journal) ----
export type PermissionDecision = 'granted' | 'denied'
export function readPermissions(root: string): Record<string, Record<string, PermissionDecision>>
export function getPermission(root: string, origin: string, permission: string): PermissionDecision | null
export function setPermission(root: string, origin: string, permission: string, decision: PermissionDecision): void

// ---- browser bookmarks (machine-global, in the root journal) ----
export interface Bookmark {
  id: string
  url: string
  title: string
  addedAt: number
}
export function readBookmarks(root: string): Bookmark[]
/** Add the url if absent, remove it if present (the star toggle). Returns the updated list. */
export function toggleBookmark(root: string, b: { url: string; title?: string }): Bookmark[]

export interface BootJournal {
  /** Previous run died without a clean shutdown (crash / SIGKILL / power loss). */
  dirty: boolean
  /** Previous record's pid is still alive: another BlitzOS owns this root right now (not a crash). */
  concurrent: boolean
  lastAliveAt: number | null
  prev: BootRecord | null
  /** Call as the LAST step of a graceful quit ("clean" = state was flushed first). */
  markClean(): void
}
/** Read the dirty bit, claim the root with a fresh record, start the 60s heartbeat. */
export function openBootJournal(root: string, mode: string): BootJournal
