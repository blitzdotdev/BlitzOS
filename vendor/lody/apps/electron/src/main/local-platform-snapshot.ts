import { LOCAL_USER_ID_PREFIX, LOCAL_WORKSPACE_ID_PREFIX } from '@lody/shared/platform-kind'
import type { ElectronLocalPlatformSnapshot } from '@lody/shared/electron-ipc'

/** Parse the CLI-owned atomic local identity/workspace bootstrap contract. */
export function parseLocalPlatformSnapshot(decoded: unknown): ElectronLocalPlatformSnapshot {
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Local platform catalog must be an object')
  }
  const catalog = decoded as Record<string, unknown>
  const identity = catalog.identity
  if (!identity || typeof identity !== 'object') {
    throw new Error('Local platform catalog is missing identity')
  }
  const userId = (identity as Record<string, unknown>).userId
  if (typeof userId !== 'string' || !userId.startsWith(LOCAL_USER_ID_PREFIX)) {
    throw new Error('Local platform catalog has an invalid local user id')
  }
  if (!Array.isArray(catalog.workspaces)) {
    throw new Error('Local platform catalog is missing workspaces')
  }
  const activeWorkspaces = catalog.workspaces.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).state === 'active'
  )
  if (activeWorkspaces.length !== 1) {
    throw new Error(
      `Local platform catalog must contain exactly one active workspace; found ${activeWorkspaces.length}`
    )
  }
  const workspace = activeWorkspaces[0]!
  if (
    typeof workspace.workspaceId !== 'string' ||
    !workspace.workspaceId.startsWith(LOCAL_WORKSPACE_ID_PREFIX) ||
    typeof workspace.name !== 'string' ||
    typeof workspace.role !== 'string' ||
    (workspace.slug !== null && typeof workspace.slug !== 'string')
  ) {
    throw new Error('Local platform catalog has an invalid active workspace')
  }
  return {
    userId,
    workspace: {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      role: workspace.role
    }
  }
}
