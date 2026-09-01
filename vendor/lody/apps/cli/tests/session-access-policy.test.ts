import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
  CatalogPermissionError,
  type LocalWorkspaceCatalogService,
  type LocalWorkspaceCatalogSnapshot,
} from '../src/lib/local-workspace-catalog';
import {
  decideSessionAccessFromCatalog,
  makeSessionAccessPolicy,
} from '../src/session/session-access-policy';

const snapshot = (
  workspace: LocalWorkspaceCatalogSnapshot['workspaces'][number]
): LocalWorkspaceCatalogSnapshot => ({
  version: 1,
  identity: { userId: 'user-1' },
  machine: { machineId: 'machine-1' },
  workspaces: [workspace],
  sessions: [],
});

const activeWorkspace = (
  accessSnapshot?: LocalWorkspaceCatalogSnapshot['workspaces'][number]['accessSnapshot']
): LocalWorkspaceCatalogSnapshot['workspaces'][number] => ({
  workspaceId: 'workspace-1',
  name: 'Workspace',
  slug: 'workspace',
  role: 'owner',
  state: 'active',
  cachedAt: 1,
  ...(accessSnapshot ? { accessSnapshot } : {}),
});

describe('Session access policy (optimistic-allow cache)', () => {
  it('allows an owner-cached requester with an owner allow snapshot', () => {
    expect(
      decideSessionAccessFromCatalog(
        snapshot(
          activeWorkspace({
            ownerUserId: 'user-1',
            verifiedAt: '2026-07-02T00:00:00.000Z',
          })
        ),
        {
          workspaceId: 'workspace-1',
          currentUserId: 'user-1',
          requesterUserId: 'user-1',
        }
      )
    ).toEqual({ outcome: 'allow', source: 'owner-cached' });
  });

  it('does not use an owner snapshot for another requester', () => {
    expect(
      decideSessionAccessFromCatalog(
        snapshot(
          activeWorkspace({
            ownerUserId: 'user-1',
            verifiedAt: '2026-07-02T00:00:00.000Z',
          })
        ),
        {
          workspaceId: 'workspace-1',
          currentUserId: 'user-1',
          requesterUserId: 'user-2',
        }
      )
    ).toEqual({ outcome: 'remote' });
  });

  it('ignores snapshots from a different cached identity', () => {
    const input = snapshot(
      activeWorkspace({
        ownerUserId: 'user-1',
        verifiedAt: '2026-07-02T00:00:00.000Z',
      })
    );
    input.identity = { userId: 'user-old' };

    expect(
      decideSessionAccessFromCatalog(input, {
        workspaceId: 'workspace-1',
        currentUserId: 'user-1',
        requesterUserId: 'user-1',
      })
    ).toEqual({ outcome: 'remote' });
  });

  it('falls through to remote when the cached owner is a different user', () => {
    expect(
      decideSessionAccessFromCatalog(
        snapshot(
          activeWorkspace({
            ownerUserId: 'user-other',
            verifiedAt: '2026-07-02T00:00:00.000Z',
          })
        ),
        {
          workspaceId: 'workspace-1',
          currentUserId: 'user-1',
          requesterUserId: 'user-1',
        }
      )
    ).toEqual({ outcome: 'remote' });
  });

  it('falls through to remote when there is no access snapshot (post-clear / never verified)', () => {
    // This is the wedge fix: a transient backend deny CLEARS the snapshot rather
    // than caching a durable "denied", so the workspace goes back to a fresh
    // remote check instead of being permanently blocked.
    expect(
      decideSessionAccessFromCatalog(snapshot(activeWorkspace()), {
        workspaceId: 'workspace-1',
        currentUserId: 'user-1',
        requesterUserId: 'user-1',
      })
    ).toEqual({ outcome: 'remote' });
  });

  it('ignores remote_missing state recorded under a different cached identity', () => {
    const input = snapshot({
      ...activeWorkspace(),
      state: 'remote_missing',
      remoteMissingAt: 2,
    });
    input.identity = { userId: 'user-old' };

    expect(
      decideSessionAccessFromCatalog(input, {
        workspaceId: 'workspace-1',
        currentUserId: 'user-1',
        requesterUserId: 'user-1',
      })
    ).toEqual({ outcome: 'remote' });
  });

  it('denies remote_missing workspaces before remote verification', () => {
    expect(
      decideSessionAccessFromCatalog(
        snapshot({
          ...activeWorkspace(),
          state: 'remote_missing',
          remoteMissingAt: 2,
        }),
        {
          workspaceId: 'workspace-1',
          currentUserId: 'user-1',
          requesterUserId: 'user-1',
        }
      )
    ).toEqual({ outcome: 'deny', reason: 'not_visible', source: 'remote_missing' });
  });

  it('degrades a catalog read failure to the remote check instead of erroring (F6)', async () => {
    // Missing/corrupt catalogs self-recover inside read(); a permission error
    // (e.g. EACCES on ~/.lody) does not. The policy must degrade to
    // `{ outcome: 'remote' }` — the no-catalog behavior — rather than fail the
    // dispatch check and strand the turn pending forever.
    const catalog: LocalWorkspaceCatalogService = {
      read: () =>
        Effect.fail(
          new CatalogPermissionError({ path: '/home/user/.lody/workspace-catalog.json' })
        ),
      listActiveWorkspaces: () => Effect.die('not used'),
      cacheRemoteWorkspaces: () => Effect.die('not used'),
      recordWorkspaceAccessSnapshot: () => Effect.die('not used'),
      upsertSession: () => Effect.die('not used'),
    };
    const policy = makeSessionAccessPolicy(catalog);

    await expect(
      Effect.runPromise(
        policy.decide({
          workspaceId: 'workspace-1',
          currentUserId: 'user-1',
          requesterUserId: 'user-1',
        })
      )
    ).resolves.toEqual({ outcome: 'remote' });
  });
});
