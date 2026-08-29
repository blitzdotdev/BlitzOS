import type { LocalProjectId, MachineId, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared';
import { resolveSessionRepoFullName } from './session-repo';

export { resolveSessionRepoFullName } from './session-repo';

export type SessionLocalFileSource =
  | {
      kind: 'local-project';
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
    }
  | {
      kind: 'session-worktree';
      repoKey: string;
      sessionId: SessionId;
    };

type ResolveSessionLocalFileSourceOptions = {
  isElectronRenderer: boolean;
  localMachineId: MachineId | null;
  workspaceId: WorkspaceId | null;
  localProjectRootPath?: string | null;
};

export function resolveSessionLocalProjectRootPath(
  session: SessionMeta,
  localProjects: Record<string, { rootPath?: string | null } | null | undefined> | null | undefined
): string | null {
  const project = session.project;
  if (!project || project.kind !== 'local') {
    return null;
  }
  const rawPath = localProjects?.[project.localProjectId]?.rootPath;
  if (typeof rawPath !== 'string') {
    return null;
  }
  const trimmed = rawPath.trim();
  return trimmed || null;
}

export function resolveSessionLocalFileSource(
  session: SessionMeta,
  options: ResolveSessionLocalFileSourceOptions
): SessionLocalFileSource | null {
  if (session.project?.kind === 'local') {
    if (session.isWorktree) {
      if (!options.isElectronRenderer) {
        return null;
      }
      if (!options.localMachineId || session.machineId !== options.localMachineId) {
        return null;
      }
      const localProjectRootPath = options.localProjectRootPath?.trim();
      if (!localProjectRootPath) {
        return null;
      }
      try {
        return {
          kind: 'session-worktree',
          repoKey: deriveRepoIdFromLocalProjectPath(localProjectRootPath),
          sessionId: (session.parentSessionId ?? session.id) as SessionId,
        };
      } catch {
        return null;
      }
    }

    if (!options.workspaceId) {
      return null;
    }
    if (!options.isElectronRenderer) {
      return null;
    }
    if (!options.localMachineId || session.machineId !== options.localMachineId) {
      return null;
    }
    return {
      kind: 'local-project',
      workspaceId: options.workspaceId,
      localProjectId: session.project.localProjectId,
    };
  }

  if (!options.isElectronRenderer) {
    return null;
  }

  if (!options.localMachineId || session.machineId !== options.localMachineId) {
    return null;
  }

  const repoFullName = resolveSessionRepoFullName(session);
  if (!repoFullName) {
    return null;
  }

  return {
    kind: 'session-worktree',
    repoKey: repoFullName,
    sessionId: (session.parentSessionId ?? session.id) as SessionId,
  };
}
