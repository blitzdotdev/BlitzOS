export type SessionOpenInIdePathSource = 'worktree' | 'local_project';

export type SessionOpenInIdePathTarget = {
  path: string;
  source: SessionOpenInIdePathSource;
};

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveSessionOpenInIdePathTarget({
  worktreePath,
  localProjectRootPath,
}: {
  worktreePath: string | null | undefined;
  localProjectRootPath: string | null | undefined;
}): SessionOpenInIdePathTarget | null {
  const normalizedWorktreePath = normalizePath(worktreePath);
  if (normalizedWorktreePath) {
    return { path: normalizedWorktreePath, source: 'worktree' };
  }

  const normalizedLocalProjectRootPath = normalizePath(localProjectRootPath);
  if (normalizedLocalProjectRootPath) {
    return { path: normalizedLocalProjectRootPath, source: 'local_project' };
  }

  return null;
}
