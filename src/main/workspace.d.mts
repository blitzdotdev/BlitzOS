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
}

/** Validate a RAW workspace name (strict allow-list). Returns the NFC name or null. */
export function safeName(name: unknown): string | null

/** Resolve a name to a realpath-jailed absolute path under root (or null). */
export function resolveWorkspace(root: string, name: string, opts: { mustExist: boolean }): string | null

/** List workspace folders under root, newest-edited first. */
export function listWorkspaces(root: string): WorkspaceEntry[]

/** Create + scaffold a new workspace. Throws Error with .code 'EINVAL' | 'EEXIST'. */
export function createWorkspace(root: string, name: string): { name: string; path: string }
