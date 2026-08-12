import type { WorkspaceView } from "@blitzos/schema";

export function reconcileWorkspaces(
  current: readonly WorkspaceView[],
  polled: readonly WorkspaceView[],
): WorkspaceView[] {
  const currentById = new Map(current.map((workspace) => [workspace.id, workspace]));
  return polled.map((workspace) => {
    const existing = currentById.get(workspace.id);
    return existing !== undefined && workspace.revision <= existing.revision
      ? existing
      : workspace;
  });
}

export function acceptWorkspace(
  current: readonly WorkspaceView[],
  incoming: WorkspaceView,
): WorkspaceView[] {
  const index = current.findIndex(({ id }) => id === incoming.id);
  if (index < 0) return [...current, incoming];
  const existing = current[index];
  if (existing === undefined || incoming.revision <= existing.revision) return [...current];
  const next = [...current];
  next[index] = incoming;
  return next;
}
