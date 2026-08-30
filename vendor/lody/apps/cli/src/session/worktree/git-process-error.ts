import * as fs from 'node:fs';

export const GIT_EXECUTABLE_NOT_FOUND_CODE = 'git_executable_not_found' as const;

export class GitExecutableNotFoundError extends Error {
  readonly code = GIT_EXECUTABLE_NOT_FOUND_CODE;

  constructor(cause: unknown) {
    super('Git is unavailable: Lody could not find the Git executable in PATH.', { cause });
    this.name = 'GitExecutableNotFoundError';
  }
}

const readErrorCode = (error: unknown): unknown =>
  error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;

/**
 * `spawn` also reports ENOENT when cwd is missing. Only classify the error as a
 * missing Git executable when the requested working directory still exists.
 */
export function mapGitSpawnError(error: unknown, cwd: string): unknown {
  if (readErrorCode(error) === 'ENOENT' && fs.existsSync(cwd)) {
    return new GitExecutableNotFoundError(error);
  }
  return error;
}

export function isGitExecutableNotFoundError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof GitExecutableNotFoundError ||
      readErrorCode(current) === GIT_EXECUTABLE_NOT_FOUND_CODE
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
