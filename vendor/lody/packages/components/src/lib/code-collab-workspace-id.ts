import type { WorkspaceId } from '@lody/shared';

export function resolveEffectiveCodeCollabWorkspaceId(input: {
  readonly currentWorkspaceId?: WorkspaceId | null;
  readonly runtimeWorkspaceId?: WorkspaceId | null;
}): WorkspaceId | null {
  return input.currentWorkspaceId ?? input.runtimeWorkspaceId ?? null;
}
