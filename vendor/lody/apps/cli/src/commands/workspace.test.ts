import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sortWorkspaceSummaries } from './workspace';
import { listWorkspaceGitHubRepositoriesForCliToken } from '@/lib/workspace';

const queryMock = vi.fn();

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    query = queryMock;
  },
}));

vi.mock('@lody/cloud-api', () => ({
  api: {
    github: {
      listWorkspaceRepositoriesForCliToken: 'github.listWorkspaceRepositoriesForCliToken',
    },
    deviceAuth: {
      listMyWorkspacesForCliToken: 'deviceAuth.listMyWorkspacesForCliToken',
    },
  },
}));

vi.mock('@/utils/const', () => ({
  LODY_AUTH_URL: 'http://convex.test',
}));

describe('workspace command helpers', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('sorts workspaces by name, slug, then id', () => {
    const workspaces = [
      { id: 'ws-2', name: 'Beta', slug: 'beta', role: 'member' },
      { id: 'ws-3', name: 'Alpha', slug: 'zeta', role: 'member' },
      { id: 'ws-1', name: 'Alpha', slug: 'alpha', role: 'owner' },
    ];

    expect(sortWorkspaceSummaries(workspaces).map((workspace) => workspace.id)).toEqual([
      'ws-1',
      'ws-3',
      'ws-2',
    ]);
  });

  it('lists workspace GitHub repositories for a valid CLI token', async () => {
    queryMock.mockResolvedValueOnce({
      valid: true,
      repositories: [
        {
          id: 42,
          name: 'repo',
          fullName: 'owner/repo',
          private: true,
        },
      ],
    });

    await expect(
      listWorkspaceGitHubRepositoriesForCliToken({
        token: 'cli-token',
        workspaceId: 'workspace-1',
      })
    ).resolves.toEqual([
      {
        id: 42,
        name: 'repo',
        fullName: 'owner/repo',
        private: true,
      },
    ]);

    expect(queryMock).toHaveBeenCalledWith('github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
    });
  });

  it('passes requester user id when listing workspace GitHub repositories', async () => {
    queryMock.mockResolvedValueOnce({
      valid: true,
      repositories: [],
    });

    await listWorkspaceGitHubRepositoriesForCliToken({
      token: 'cli-token',
      workspaceId: 'workspace-1',
      requesterUserId: 'current-session-user',
    });

    expect(queryMock).toHaveBeenCalledWith('github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
      requesterUserId: 'current-session-user',
    });
  });

  it('requests only enabled repositories for session orchestration callers', async () => {
    queryMock.mockResolvedValueOnce({ valid: true, repositories: [] });

    await listWorkspaceGitHubRepositoriesForCliToken({
      token: 'cli-token',
      workspaceId: 'workspace-1',
      requesterUserId: 'current-session-user',
      enabledOnly: true,
    });

    expect(queryMock).toHaveBeenCalledWith('github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
      requesterUserId: 'current-session-user',
      enabledOnly: true,
    });
  });

  it('retries GitHub repository listing without requester user id for older Convex deploys', async () => {
    queryMock
      .mockRejectedValueOnce(
        new Error('ArgumentValidationError: Object contains extra field `requesterUserId`')
      )
      .mockResolvedValueOnce({
        valid: true,
        repositories: [],
      });

    await expect(
      listWorkspaceGitHubRepositoriesForCliToken({
        token: 'cli-token',
        workspaceId: 'workspace-1',
        requesterUserId: 'current-session-user',
      })
    ).resolves.toEqual([]);

    expect(queryMock).toHaveBeenNthCalledWith(1, 'github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
      requesterUserId: 'current-session-user',
    });
    expect(queryMock).toHaveBeenNthCalledWith(2, 'github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
    });
  });

  it('rejects expired CLI tokens when listing workspace GitHub repositories', async () => {
    queryMock.mockResolvedValueOnce({
      valid: false,
      repositories: [],
    });

    await expect(
      listWorkspaceGitHubRepositoriesForCliToken({
        token: 'expired-token',
        workspaceId: 'workspace-1',
      })
    ).rejects.toThrow(/invalid or expired/i);
  });
});
