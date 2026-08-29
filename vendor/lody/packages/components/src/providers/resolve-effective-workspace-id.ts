import type { WorkspaceId } from '@lody/shared';

type ResolveEffectiveWorkspaceIdArgs = {
  /**
   * Workspace slug from the URL/router context.
   */
  workspaceSlug: string | null;
  /**
   * Cached workspace id for `workspaceSlug` (from localStorage).
   */
  cachedWorkspaceId: WorkspaceId | null;
  /**
   * Workspace id from auth/server state (may be stale during workspace transitions).
   */
  serverWorkspaceId: WorkspaceId | null;
  /**
   * Previous render's workspace slug (used to detect transitions).
   */
  prevWorkspaceSlug: string | null;
  /**
   * Previous render's server workspace id (used to detect stale ids).
   */
  prevServerWorkspaceId: WorkspaceId | null;
};

/**
 * Resolve the workspace id to use for runtime initialization.
 *
 * Goal: When switching workspaces via URL, avoid briefly initializing the runtime
 * with the previous workspace's id (which would show the previous workspace's
 * sessions until auth catches up).
 */
export function resolveEffectiveWorkspaceId({
  workspaceSlug,
  cachedWorkspaceId,
  serverWorkspaceId,
  prevWorkspaceSlug,
  prevServerWorkspaceId,
}: ResolveEffectiveWorkspaceIdArgs): WorkspaceId | null {
  if (!workspaceSlug) {
    return null;
  }

  // If the slug changed but the server id hasn't updated yet, treat it as stale.
  const serverWorkspaceIdIsStale =
    prevWorkspaceSlug !== null &&
    prevWorkspaceSlug !== workspaceSlug &&
    prevServerWorkspaceId === serverWorkspaceId;
  const trustedServerWorkspaceId = serverWorkspaceIdIsStale ? null : serverWorkspaceId;

  // If we have a cached id for this slug, it's the safest offline-first choice.
  // However, if the server later confirms a different id for this slug, prefer the server
  // to avoid getting stuck on a stale localStorage mapping.
  if (cachedWorkspaceId) {
    if (trustedServerWorkspaceId && trustedServerWorkspaceId !== cachedWorkspaceId) {
      return trustedServerWorkspaceId;
    }
    return cachedWorkspaceId;
  }

  return trustedServerWorkspaceId;
}
