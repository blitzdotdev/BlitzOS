import {
  deriveRepoIdFromGitHubRepo,
  deriveRepoIdFromLocalProjectPath,
  getDefaultSessionWorkdirFromDotlodyPath,
  getLodyDotlodyPath,
  getMachineFlockDotlodyPath,
  getWorktreeHostPathFromDotlodyPath,
  type MachineFlockRowMap,
  type SessionId,
} from '@lody/shared';

export function resolveMachineDotlodyPath(
  machineFlockRows: MachineFlockRowMap,
  localHomeDir?: string | null
): string | null {
  const flockPath = getMachineFlockDotlodyPath(machineFlockRows)?.trim();
  if (flockPath) return flockPath;
  const homeDir = localHomeDir?.trim();
  return homeDir ? getLodyDotlodyPath(homeDir) : null;
}

export function resolveSessionWorkspacePath(args: {
  sessionId: SessionId;
  ownerSessionId?: SessionId | null;
  isWorktree?: boolean;
  dotlodyPath?: string | null;
  localProjectRootPath?: string | null;
  repoFullName?: string | null;
  legacyWorkspacePath?: string | null;
}): string | null {
  const dotlodyPath = args.dotlodyPath?.trim();
  const localProjectRootPath = args.localProjectRootPath?.trim();
  const repoFullName = args.repoFullName?.trim();
  const legacyWorkspacePath = args.legacyWorkspacePath?.trim();
  const ownerSessionId = args.ownerSessionId ?? args.sessionId;

  if (args.isWorktree === true && dotlodyPath) {
    try {
      const repoId = localProjectRootPath
        ? deriveRepoIdFromLocalProjectPath(localProjectRootPath)
        : repoFullName
          ? deriveRepoIdFromGitHubRepo(repoFullName)
          : null;
      if (repoId) {
        return getWorktreeHostPathFromDotlodyPath(repoId, ownerSessionId, dotlodyPath);
      }
    } catch {
      // Fall through to the legacy path below.
    }
  }

  if (args.isWorktree !== true) {
    if (localProjectRootPath) return localProjectRootPath;
    if (dotlodyPath) {
      return getDefaultSessionWorkdirFromDotlodyPath(dotlodyPath, ownerSessionId);
    }
  }

  return legacyWorkspacePath || null;
}
