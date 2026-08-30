import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLocalPlatformEnv,
  ensureImplicitLocalWorkspace,
  getCliPlatformKind,
  loadOrCreateLocalIdentity,
  LOCAL_WORKSPACE_SLUG,
} from '@/lib/cli-platform';
import type {
  LocalWorkspaceCatalogService,
  LocalWorkspaceCatalogSnapshot,
  CacheRemoteWorkspacesInput,
} from '@/lib/local-workspace-catalog';
import { getLogger } from '@/utils/logger';

const logger = getLogger('test');

function makeCatalogStub(initial?: Partial<LocalWorkspaceCatalogSnapshot>): {
  catalog: LocalWorkspaceCatalogService;
  writes: CacheRemoteWorkspacesInput[];
} {
  let snapshot: LocalWorkspaceCatalogSnapshot = {
    version: 1,
    identity: null,
    machine: null,
    workspaces: [],
    sessions: [],
    ...initial,
  };
  const writes: CacheRemoteWorkspacesInput[] = [];
  const catalog: LocalWorkspaceCatalogService = {
    read: () => Effect.succeed(snapshot),
    listActiveWorkspaces: () =>
      Effect.succeed(snapshot.workspaces.filter((workspace) => workspace.state === 'active')),
    cacheRemoteWorkspaces: (input) =>
      Effect.sync(() => {
        writes.push(input);
        snapshot = {
          ...snapshot,
          identity: input.identity,
          machine: input.machine,
          workspaces: input.workspaces.map((workspace) => ({
            workspaceId: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            role: workspace.role,
            state: 'active' as const,
            cachedAt: 0,
          })),
        };
      }),
    recordWorkspaceAccessSnapshot: () => Effect.void,
    upsertSession: () => Effect.void,
  };
  return { catalog, writes };
}

describe('getCliPlatformKind / applyLocalPlatformEnv', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('defaults to local and honors LODY_PLATFORM=cloud', () => {
    delete process.env.LODY_PLATFORM;
    expect(getCliPlatformKind()).toBe('local');
    process.env.LODY_PLATFORM = 'cloud';
    expect(getCliPlatformKind()).toBe('cloud');
  });

  it('applyLocalPlatformEnv blanks every cloud endpoint', () => {
    process.env.LODY_AUTH_URL = 'https://convex.example';
    process.env.LODY_AUTH_SITE_URL = 'https://site.example';
    process.env.LODY_SERVER_URL = 'https://server.example';
    applyLocalPlatformEnv();
    expect(process.env.LODY_AUTH_URL).toBeUndefined();
    expect(process.env.LODY_AUTH_SITE_URL).toBeUndefined();
    expect(process.env.LODY_SERVER_URL).toBeUndefined();
  });
});

describe('loadOrCreateLocalIdentity', () => {
  let tempDir: string;
  let identityPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-local-identity-'));
    identityPath = path.join(tempDir, '.lody', 'local-identity.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a persisted local: identity once and reuses it', async () => {
    const first = await loadOrCreateLocalIdentity(logger, { filePath: identityPath });
    expect(first.userId.startsWith('local:')).toBe(true);
    const second = await loadOrCreateLocalIdentity(logger, { filePath: identityPath });
    expect(second.userId).toBe(first.userId);
    const raw = JSON.parse(await fs.readFile(identityPath, 'utf-8'));
    expect(raw.userId).toBe(first.userId);
  });

  it('regenerates a malformed identity file', async () => {
    await fs.mkdir(path.dirname(identityPath), { recursive: true });
    await fs.writeFile(identityPath, JSON.stringify({ userId: 'cloud-user' }));
    const identity = await loadOrCreateLocalIdentity(logger, { filePath: identityPath });
    expect(identity.userId.startsWith('local:')).toBe(true);
  });
});

describe('ensureImplicitLocalWorkspace', () => {
  const identity = { userId: 'local:abc', createdAt: '2026-08-01T00:00:00.000Z' };

  it('provisions a single lw_ workspace on first run', async () => {
    const { catalog, writes } = makeCatalogStub();
    const workspace = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'machine-1',
      machineName: 'test-host',
      logger,
    });
    expect(workspace.id.startsWith('lw_')).toBe(true);
    expect(workspace.slug).toBe(LOCAL_WORKSPACE_SLUG);
    expect(workspace.role).toBe('owner');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.identity.userId).toBe(identity.userId);
  });

  it('is idempotent: a second run returns the existing workspace', async () => {
    const { catalog, writes } = makeCatalogStub();
    const first = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'machine-1',
      machineName: 'test-host',
      logger,
    });
    const second = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'machine-1',
      machineName: 'test-host',
      logger,
    });
    expect(second.id).toBe(first.id);
    expect(writes).toHaveLength(1);
  });

  it('ignores a catalog written by a different identity', async () => {
    const { catalog } = makeCatalogStub({
      identity: { userId: 'cloud-user' },
      workspaces: [
        {
          workspaceId: 'lw_stale',
          name: 'Stale',
          slug: 'local',
          role: 'owner',
          state: 'active',
          cachedAt: 0,
        },
      ],
    });
    const workspace = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'machine-1',
      machineName: 'test-host',
      logger,
    });
    expect(workspace.id).not.toBe('lw_stale');
  });
});
