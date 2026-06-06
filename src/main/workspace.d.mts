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
