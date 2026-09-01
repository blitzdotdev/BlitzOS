import { execFile } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGhTokenFingerprint,
  LODY_MANAGED_GH_TOKEN_SHA256_ENV,
  resolveGhTokenForSession,
} from './gh-token-injector';
import type { GitHubTokenManager } from './github-token-manager';
import type { Logger } from '@/utils/logger';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    callback(new Error('gh is not authenticated'));
    return {
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
    };
  }),
}));

const logger = { debug: vi.fn() } as unknown as Logger;

describe('resolveGhTokenForSession', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockClear();
    vi.mocked(logger.debug).mockClear();
  });

  it('uses a personal write-operation token before checking local gh auth', async () => {
    const tokenManager = {
      getWriteTokenInfoForRepo: vi.fn().mockResolvedValue({
        token: 'personal-token',
        tokenSource: 'personal',
      }),
    } as unknown as GitHubTokenManager;

    await expect(
      resolveGhTokenForSession({
        env: {},
        githubRepo: 'owner/repo',
        tokenManager,
        requesterUserId: 'user-1',
        machineId: 'machine-1',
        logger,
      })
    ).resolves.toBe('personal-token');

    expect(tokenManager.getWriteTokenInfoForRepo).toHaveBeenCalledWith('owner/repo', {
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('uses an app write token instead of ambient local gh auth', async () => {
    const getWriteTokenInfoForRepo = vi.fn().mockResolvedValueOnce({
      token: 'app-token',
      tokenSource: 'app',
    });
    const tokenManager = {
      getWriteTokenInfoForRepo,
    } as unknown as GitHubTokenManager;

    await expect(
      resolveGhTokenForSession({
        env: {},
        githubRepo: 'owner/repo',
        tokenManager,
        requesterUserId: 'user-1',
        machineId: 'machine-1',
        logger,
      })
    ).resolves.toBe('app-token');

    expect(getWriteTokenInfoForRepo).toHaveBeenCalledTimes(1);
    expect(getWriteTokenInfoForRepo).toHaveBeenCalledWith('owner/repo', {
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('clears stale managed env tokens when requester-bound token fetch fails', async () => {
    const staleToken = 'old-managed-token';
    const env = {
      GH_TOKEN: staleToken,
      [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint(staleToken),
    };
    const tokenManager = {
      getWriteTokenInfoForRepo: vi.fn().mockRejectedValue(new Error('broker rejected context')),
    } as unknown as GitHubTokenManager;

    await expect(
      resolveGhTokenForSession({
        env,
        githubRepo: 'owner/repo',
        tokenManager,
        requesterUserId: 'user-2',
        machineId: 'machine-1',
        logger,
      })
    ).resolves.toBeNull();

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env[LODY_MANAGED_GH_TOKEN_SHA256_ENV]).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('preserves user-provided env tokens while clearing stale managed tokens', async () => {
    const staleToken = 'old-managed-token';
    const env = {
      GH_TOKEN: staleToken,
      GITHUB_TOKEN: 'user-token',
      [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint(staleToken),
    };
    const tokenManager = {
      getWriteTokenInfoForRepo: vi.fn(),
    } as unknown as GitHubTokenManager;

    await expect(
      resolveGhTokenForSession({
        env,
        githubRepo: 'owner/repo',
        tokenManager,
        requesterUserId: 'user-2',
        machineId: 'machine-1',
        logger,
      })
    ).resolves.toBeNull();

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe('user-token');
    expect(env[LODY_MANAGED_GH_TOKEN_SHA256_ENV]).toBeUndefined();
    expect(tokenManager.getWriteTokenInfoForRepo).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
