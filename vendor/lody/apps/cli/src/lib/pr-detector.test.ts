import { describe, expect, it, vi } from 'vitest';
import type { ISession } from '@/session/session-manager';
import type { Logger } from '@/utils/logger';
import { detectPullRequestForBranch } from './pr-detector';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    warn: vi.fn(),
  }) as unknown as Logger;

describe('detectPullRequestForBranch', () => {
  it('requests and returns the PR base branch for CLI diff stats', async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('gh');
      expect(args).toEqual([
        'pr',
        'list',
        '--head',
        'feature/session-stats',
        '--json',
        'number,url,state,isDraft,headRefName,baseRefName',
        '--limit',
        '5',
      ]);
      return JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/owner/repo/pull/42',
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feature/session-stats',
          baseRefName: 'release/v2',
        },
      ]);
    });
    const session = { exec } as unknown as ISession;

    await expect(
      detectPullRequestForBranch({
        session,
        workdir: '/repo',
        repoFullName: 'owner/repo',
        branchName: 'feature/session-stats',
        logger: createLogger(),
      })
    ).resolves.toEqual({
      repoFullName: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      branch: 'feature/session-stats',
      baseBranch: 'release/v2',
      status: 'open',
    });
  });

  it('reports draft status for an open PR still marked as draft', async () => {
    const exec = vi.fn(async () =>
      JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/owner/repo/pull/7',
          state: 'OPEN',
          isDraft: true,
          headRefName: 'feature/draft',
          baseRefName: 'main',
        },
      ])
    );
    const session = { exec } as unknown as ISession;

    await expect(
      detectPullRequestForBranch({
        session,
        workdir: '/repo',
        repoFullName: 'owner/repo',
        branchName: 'feature/draft',
        logger: createLogger(),
      })
    ).resolves.toEqual({
      repoFullName: 'owner/repo',
      prNumber: 7,
      prUrl: 'https://github.com/owner/repo/pull/7',
      branch: 'feature/draft',
      baseBranch: 'main',
      status: 'draft',
    });
  });

  it('never queries gh when git reports a detached HEAD', async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('git');
      return args[0] === 'branch' ? '\n' : 'HEAD\n';
    });
    const logger = createLogger();

    await expect(
      detectPullRequestForBranch({
        session: { exec } as unknown as ISession,
        workdir: '/repo',
        repoFullName: 'owner/repo',
        logger,
      })
    ).resolves.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // A dropped/failed git exec must not read as "this branch has no PR" — that
  // is what left a real session unlinked from the PR it had just opened.
  it('warns instead of claiming a detached HEAD when git does not answer', async () => {
    const exec = vi.fn(async () => '');
    const logger = createLogger();

    await expect(
      detectPullRequestForBranch({
        session: { exec } as unknown as ISession,
        workdir: '/repo',
        repoFullName: 'owner/repo',
        logger,
      })
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not resolve'));
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('detached HEAD'));
  });
});
