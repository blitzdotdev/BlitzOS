import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GIT_EXECUTABLE_NOT_FOUND_CODE,
  GitExecutableNotFoundError,
  isGitExecutableNotFoundError,
  mapGitSpawnError,
} from '../src/session/worktree/git-process-error';

describe('git process error mapping', () => {
  it('classifies ENOENT as a missing Git executable when cwd exists', () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });

    const mapped = mapGitSpawnError(spawnError, os.tmpdir());

    expect(mapped).toBeInstanceOf(GitExecutableNotFoundError);
    expect(mapped).toMatchObject({ code: GIT_EXECUTABLE_NOT_FOUND_CODE, cause: spawnError });
  });

  it('does not misclassify ENOENT when cwd is missing', () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const missingCwd = path.join(os.tmpdir(), 'lody-git-process-error-missing-cwd');

    expect(mapGitSpawnError(spawnError, missingCwd)).toBe(spawnError);
  });

  it('finds the stable diagnostic through wrapped causes', () => {
    const gitError = new GitExecutableNotFoundError(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    );
    const wrapped = new Error('Failed to clone bare repository', { cause: gitError });

    expect(isGitExecutableNotFoundError(wrapped)).toBe(true);
    expect(isGitExecutableNotFoundError(new Error('git exited with code 1'))).toBe(false);
  });
});
