import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  deriveRepoIdFromLocalProjectPath,
  getDefaultSessionWorkdirFromDotlodyPath,
  getLodyDotlodyPath,
  getLodyReposBaseDirFromDotlodyPath,
  getWorktreeHostPath,
  getWorktreeHostPathFromDotlodyPath,
  isLocalRepoId,
} from '../src/worktree-paths';
import type { RepoId, SessionId } from '../src';

describe('local project worktree paths', () => {
  it('derives stable local repo ids from normalized absolute paths', () => {
    const path = '/Users/alice/code/app';
    const expected = createHash('sha256').update(path).digest('hex').slice(0, 12);

    expect(deriveRepoIdFromLocalProjectPath(`${path}/`)).toBe(`local---${expected}`);
    expect(deriveRepoIdFromLocalProjectPath(path)).toBe(`local---${expected}`);
  });

  it('distinguishes local repo ids from GitHub repo ids', () => {
    expect(isLocalRepoId('local---abc123def456' as RepoId)).toBe(true);
    expect(isLocalRepoId('github---example---project' as RepoId)).toBe(false);
  });

  it('uses the local repo id in regular worktree host paths', () => {
    const repoId = deriveRepoIdFromLocalProjectPath('/Users/alice/code/app');
    expect(getWorktreeHostPath(repoId, 'session123' as SessionId, '/home/alice')).toMatch(
      /^\/home\/alice\/\.lody\/repos\/local---[a-f0-9]{12}\/worktrees\/session123$/
    );
  });

  it('derives session paths from the machine dotlody path', () => {
    const repoId = 'github---example---project' as RepoId;
    const sessionId = 'session123' as SessionId;

    expect(getLodyDotlodyPath('/Users/alice')).toBe('/Users/alice/.lody');
    expect(getLodyReposBaseDirFromDotlodyPath('/Users/alice/.lody/')).toBe(
      '/Users/alice/.lody/repos'
    );
    expect(getWorktreeHostPathFromDotlodyPath(repoId, sessionId, '/Users/alice/.lody/')).toBe(
      '/Users/alice/.lody/repos/github---example---project/worktrees/session123'
    );
    expect(getDefaultSessionWorkdirFromDotlodyPath('/Users/alice/.lody/', sessionId)).toBe(
      '/Users/alice/.lody/chats/session123'
    );
  });
});
