import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineLegacyMetaFields, SessionMeta } from '../src';
import {
  buildNeedToDeleteSessionQueueItem,
  mergeNeedToDeleteSessionQueueItem,
} from '../src/session-delete-queue';

describe('session delete queue helpers', () => {
  it('captures branch, base branch, and GitHub repo cleanup metadata', () => {
    const session = {
      project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'feature/base' },
      repoFullName: 'loro-dev/lody',
      branchName: 'feature/session',
      baseBranch: 'feature/base',
      isWorktree: true,
    } satisfies Pick<
      SessionMeta,
      'project' | 'repoFullName' | 'branchName' | 'baseBranch' | 'isWorktree'
    >;

    expect(buildNeedToDeleteSessionQueueItem({ session, requestedAt: 123 })).toEqual({
      repoFullName: 'loro-dev/lody',
      branchName: 'feature/session',
      baseBranchName: 'feature/base',
      isWorktree: true,
      requestedAt: 123,
    });
  });

  it('captures local worktree source metadata from machine-local projects', () => {
    const localProjectId = 'local-1' as LocalProjectId;
    const session = {
      project: { kind: 'local', localProjectId, useWorktree: true },
      branchName: 'lody/session1234',
      baseBranch: 'main',
      isWorktree: true,
    } satisfies Pick<
      SessionMeta,
      'project' | 'repoFullName' | 'branchName' | 'baseBranch' | 'isWorktree'
    >;
    const machineMeta = {
      localProjects: {
        [localProjectId]: {
          id: localProjectId,
          rootPath: '/repo/app',
          name: 'app',
          createdAtMs: 123,
        },
      },
    } satisfies Pick<MachineLegacyMetaFields, 'localProjects'>;

    expect(buildNeedToDeleteSessionQueueItem({ session, machineMeta, requestedAt: 456 })).toEqual({
      branchName: 'lody/session1234',
      baseBranchName: 'main',
      isWorktree: true,
      localProjectId,
      originalRootPath: '/repo/app',
      requestedAt: 456,
    });
  });

  it('upgrades legacy queue entries and drops stale kept-worktree result data', () => {
    const next = {
      branchName: 'lody/session1234',
      requestedAt: 2,
    };

    expect(mergeNeedToDeleteSessionQueueItem(true, next)).toEqual(next);
    expect(
      mergeNeedToDeleteSessionQueueItem(
        {
          branchName: 'old',
          keptWorktreePath: '/old/worktree',
          requestedAt: 1,
        },
        next
      )
    ).toEqual(next);
  });
});
