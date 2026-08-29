import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  deriveRepoIdFromGitHubRepo,
  deriveRepoIdFromLocalProjectPath,
  getWorktreeHostPathFromDotlodyPath,
} from '@lody/shared/node/worktree-paths';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  resolveTerminalWorkdirFromMetadata,
  type TerminalSessionMetaLookup,
} from '../src/lib/terminal-workdir-resolver';

const machineId = 'machine-1' as MachineId;
const localProjectId = 'local-project-1' as LocalProjectId;

let tempDirs: string[] = [];
const originalPlatform = process.env.LODY_PLATFORM;
const originalDataDir = process.env.LODY_DATA_DIR;

beforeEach(() => {
  process.env.LODY_PLATFORM = 'local';
  delete process.env.LODY_DATA_DIR;
});

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  if (originalPlatform === undefined) delete process.env.LODY_PLATFORM;
  else process.env.LODY_PLATFORM = originalPlatform;
  if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
  else process.env.LODY_DATA_DIR = originalDataDir;
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-terminal-workdir-'));
  tempDirs.push(dir);
  return dir;
}

function createSessionMeta(
  sessionId: SessionId,
  overrides: Partial<SessionMeta> = {}
): SessionMeta {
  return {
    id: sessionId,
    machineId,
    createdAt: '2026-06-12T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'codex',
    agentType: 'codex',
    ...overrides,
  } as SessionMeta;
}

function createResolver(options: {
  sessionId: SessionId;
  metas: Map<SessionId, TerminalSessionMetaLookup>;
  localProjectRootPath?: string | null;
  homeDir?: string;
}) {
  return resolveTerminalWorkdirFromMetadata({
    sessionId: options.sessionId,
    machineId,
    homeDir: options.homeDir,
    lookupSessionMeta: async (sessionId) => options.metas.get(sessionId) ?? { type: 'missing' },
    resolveLocalProjectRootPath: async () => options.localProjectRootPath ?? null,
  });
}

describe('terminal workdir resolver', () => {
  it('rejects archived sessions', async () => {
    const sessionId = 'session-archived' as SessionId;
    await expect(
      createResolver({
        sessionId,
        metas: new Map([
          [sessionId, { type: 'found', meta: createSessionMeta(sessionId, { isArchived: true }) }],
        ]),
      })
    ).rejects.toThrow(`session_archived:${sessionId}`);
  });

  it('rejects deleted sessions', async () => {
    const sessionId = 'session-deleted' as SessionId;
    await expect(
      createResolver({
        sessionId,
        metas: new Map([[sessionId, { type: 'deleted' }]]),
      })
    ).rejects.toThrow(`session_deleted:${sessionId}`);
  });

  it('resolves GitHub worktree sessions from repo metadata', async () => {
    const homeDir = makeTempDir();
    const sessionId = 'session-github' as SessionId;
    const repoFullName = 'loro-dev/lody';
    const expected = getWorktreeHostPathFromDotlodyPath(
      deriveRepoIdFromGitHubRepo(repoFullName),
      sessionId,
      getLodyDataDir('local', homeDir)
    );
    fs.mkdirSync(expected, { recursive: true });

    await expect(
      createResolver({
        sessionId,
        homeDir,
        metas: new Map([
          [sessionId, { type: 'found', meta: createSessionMeta(sessionId, { repoFullName }) }],
        ]),
      })
    ).resolves.toBe(expected);
  });

  it('resolves local project sessions to the registered root path', async () => {
    const rootPath = makeTempDir();
    const sessionId = 'session-local' as SessionId;

    await expect(
      createResolver({
        sessionId,
        localProjectRootPath: rootPath,
        metas: new Map([
          [
            sessionId,
            {
              type: 'found',
              meta: createSessionMeta(sessionId, {
                project: { kind: 'local', localProjectId },
              }),
            },
          ],
        ]),
      })
    ).resolves.toBe(rootPath);
  });

  it('resolves local project worktree sessions from the registered root path', async () => {
    const homeDir = makeTempDir();
    const rootPath = makeTempDir();
    const sessionId = 'session-local-worktree' as SessionId;
    const expected = getWorktreeHostPathFromDotlodyPath(
      deriveRepoIdFromLocalProjectPath(rootPath),
      sessionId,
      getLodyDataDir('local', homeDir)
    );
    fs.mkdirSync(expected, { recursive: true });

    await expect(
      createResolver({
        sessionId,
        homeDir,
        localProjectRootPath: rootPath,
        metas: new Map([
          [
            sessionId,
            {
              type: 'found',
              meta: createSessionMeta(sessionId, {
                isWorktree: true,
                project: { kind: 'local', localProjectId, useWorktree: true },
              }),
            },
          ],
        ]),
      })
    ).resolves.toBe(expected);
  });

  it('resolves chat-only sessions to the default chat workdir', async () => {
    const homeDir = makeTempDir();
    const sessionId = 'session-chat-only' as SessionId;
    const expected = path.join(homeDir, '.lody-oss', 'chats', sessionId);

    await expect(
      createResolver({
        sessionId,
        homeDir,
        metas: new Map([[sessionId, { type: 'found', meta: createSessionMeta(sessionId) }]]),
      })
    ).resolves.toBe(expected);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });

  it('resolves child sessions through the parent session workdir', async () => {
    const rootPath = makeTempDir();
    const parentSessionId = 'session-parent' as SessionId;
    const childSessionId = 'session-child' as SessionId;

    await expect(
      createResolver({
        sessionId: childSessionId,
        localProjectRootPath: rootPath,
        metas: new Map([
          [
            childSessionId,
            {
              type: 'found',
              meta: createSessionMeta(childSessionId, { parentSessionId }),
            },
          ],
          [
            parentSessionId,
            {
              type: 'found',
              meta: createSessionMeta(parentSessionId, {
                project: { kind: 'local', localProjectId },
              }),
            },
          ],
        ]),
      })
    ).resolves.toBe(rootPath);
  });

  it('resolves child chat-only sessions through the parent default chat workdir', async () => {
    const homeDir = makeTempDir();
    const parentSessionId = 'session-parent-chat' as SessionId;
    const childSessionId = 'session-child-chat' as SessionId;
    const expected = path.join(homeDir, '.lody-oss', 'chats', parentSessionId);

    await expect(
      createResolver({
        sessionId: childSessionId,
        homeDir,
        metas: new Map([
          [
            childSessionId,
            {
              type: 'found',
              meta: createSessionMeta(childSessionId, { parentSessionId }),
            },
          ],
          [
            parentSessionId,
            {
              type: 'found',
              meta: createSessionMeta(parentSessionId),
            },
          ],
        ]),
      })
    ).resolves.toBe(expected);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });
});
