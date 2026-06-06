// Types for the workspace serializer (workspace.mjs). Phase 1: write-only.

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
