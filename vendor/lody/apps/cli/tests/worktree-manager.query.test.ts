import * as fs from 'node:fs';

import { describe, expect, it } from 'vitest';
import { RepoId, SessionId } from '@lody/shared';
import { WorktreeManager } from '../src/session/worktree/worktree-manager';
import { useWorktreeManagerTestFixture } from './worktree-manager-test-helpers';

describe('WorktreeManager', () => {
  let repoId: RepoId;
  let manager: WorktreeManager;

  useWorktreeManagerTestFixture((fixture) => {
    ({ repoId, manager } = fixture);
  });

  describe('listWorktrees', () => {
    it('should list every safe worktree directory', async () => {
      const sessionIds = [
        'list0001-session-list-1',
        'list0002-session-list-2',
        'list0003-session-list-3',
      ] as SessionId[];
      for (const sessionId of sessionIds) {
        fs.mkdirSync(manager.getWorktreeHostPath(sessionId), { recursive: true });
      }

      const worktrees = await manager.listWorktrees();

      expect(new Set(worktrees.map((worktree) => worktree.sessionId))).toEqual(new Set(sessionIds));
    });

    it('should return an empty array when the worktree root does not exist', async () => {
      const worktrees = await manager.listWorktrees();
      expect(worktrees).toEqual([]);
    });
  });

  describe('hasWorktree', () => {
    it('should return true for existing worktree', async () => {
      const sessionId = 'haswt001-session-has' as SessionId;
      fs.mkdirSync(manager.getWorktreeHostPath(sessionId), { recursive: true });

      expect(manager.hasWorktree(sessionId)).toBe(true);
    });

    it('should return false for non-existent worktree', () => {
      expect(manager.hasWorktree('nonexistent' as SessionId)).toBe(false);
    });

    it('should return false for unsafe session ids', () => {
      expect(manager.hasWorktree('../evil' as SessionId)).toBe(false);
    });
  });

  describe('path resolution', () => {
    it('should resolve correct host path', () => {
      const sessionId = 'pathres1-session-path' as SessionId;

      const hostPath = manager.getWorktreeHostPath(sessionId);

      expect(hostPath).toContain(repoId);
      expect(hostPath).toContain(sessionId);
    });

    it('should resolve repo host path', () => {
      expect(manager.getRepoHostPath()).toContain(repoId);
    });
  });
});
