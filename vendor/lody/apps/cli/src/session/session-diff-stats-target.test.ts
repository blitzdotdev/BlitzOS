import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId, ProjectRef, SessionId, SessionMeta } from '@lody/shared';

import {
  readDiffStatsMetadata,
  resolveCodeCollabAllChangesDiffStatsPatch,
  resolveDiffStatsTarget,
} from './session-diff-stats-target';

const ownerRoomId = 'session-owner';
const sessionId = 'session-1' as SessionId;
const machineId = 'machine-1' as MachineId;
const localProjectId = 'local-project-1' as LocalProjectId;

const githubProject: ProjectRef = {
  kind: 'github',
  repoFullName: 'owner/repo',
  branch: 'main',
};

const localProject: ProjectRef = {
  kind: 'local',
  localProjectId,
};

function sessionMeta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: sessionId,
    machineId,
    createdAt: '2026-06-17T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'claude',
    ...overrides,
  };
}

describe('resolveDiffStatsTarget', () => {
  it('resolves an explicit GitHub project to a GitHub target', () => {
    expect(resolveDiffStatsTarget({ ownerRoomId, project: githubProject })).toEqual({
      kind: 'github',
      ownerRoomId,
      repoFullName: 'owner/repo',
    });
  });

  it('uses owner session metadata when the active turn project is missing', () => {
    expect(
      resolveDiffStatsTarget({
        ownerRoomId,
        ownerMeta: sessionMeta({ project: githubProject }),
      })
    ).toEqual({
      kind: 'github',
      ownerRoomId,
      repoFullName: 'owner/repo',
    });
  });

  it('treats legacy repoFullName metadata as GitHub-owned', () => {
    expect(
      resolveDiffStatsTarget({
        ownerRoomId,
        ownerMeta: readDiffStatsMetadata({ repoFullName: 'owner/repo' }),
      })
    ).toEqual({
      kind: 'github',
      ownerRoomId,
      repoFullName: 'owner/repo',
    });
  });

  it('treats local sessions with repoFullName fallback as GitHub-owned', () => {
    expect(
      resolveDiffStatsTarget({
        ownerRoomId,
        project: localProject,
        ownerMeta: sessionMeta({ repoFullName: 'owner/repo' }),
      })
    ).toEqual({
      kind: 'github',
      ownerRoomId,
      repoFullName: 'owner/repo',
    });
  });

  it('resolves confirmed non-GitHub local sessions to a local target', () => {
    expect(resolveDiffStatsTarget({ ownerRoomId, project: localProject })).toEqual({
      kind: 'local',
      ownerRoomId,
      localProjectId,
    });
  });

  it('reads partial legacy local metadata without requiring full SessionMeta fields', () => {
    expect(
      resolveDiffStatsTarget({
        ownerRoomId,
        ownerMeta: readDiffStatsMetadata({
          project: { kind: 'local', localProjectId },
        }),
      })
    ).toEqual({
      kind: 'local',
      ownerRoomId,
      localProjectId,
    });
  });

  it('keeps missing project metadata unknown instead of assuming local', () => {
    expect(resolveDiffStatsTarget({ ownerRoomId })).toEqual({
      kind: 'unknown',
      ownerRoomId,
      reason: 'unresolved-project',
    });
  });
});

describe('resolveCodeCollabAllChangesDiffStatsPatch', () => {
  const githubTarget = resolveDiffStatsTarget({ ownerRoomId, project: githubProject });
  const localTarget = resolveDiffStatsTarget({ ownerRoomId, project: localProject });
  const diffStats = { allChange: { add: 4, del: 2 } };

  it('mirrors All Changes totals for a new GitHub worktree without an open PR', () => {
    expect(
      resolveCodeCollabAllChangesDiffStatsPatch({
        target: githubTarget,
        ownerMeta: readDiffStatsMetadata({ project: githubProject }),
        diffStats,
      })
    ).toEqual({ diffStats });
  });

  it('preserves PR-compare totals for GitHub sessions with an open PR', () => {
    expect(
      resolveCodeCollabAllChangesDiffStatsPatch({
        target: githubTarget,
        ownerMeta: readDiffStatsMetadata({
          project: githubProject,
          pullRequests: [{ status: 'open' }],
        }),
        diffStats,
      })
    ).toBeNull();
  });

  it('mirrors All Changes totals for confirmed local sessions', () => {
    expect(
      resolveCodeCollabAllChangesDiffStatsPatch({
        target: localTarget,
        ownerMeta: readDiffStatsMetadata({ project: localProject }),
        diffStats,
      })
    ).toEqual({ diffStats });
  });

  it('skips a redundant meta write when the totals have not changed', () => {
    expect(
      resolveCodeCollabAllChangesDiffStatsPatch({
        target: githubTarget,
        ownerMeta: readDiffStatsMetadata({ project: githubProject, diffStats }),
        diffStats,
      })
    ).toBeNull();
  });

  it('does not write when project ownership is unresolved', () => {
    expect(
      resolveCodeCollabAllChangesDiffStatsPatch({
        target: resolveDiffStatsTarget({ ownerRoomId }),
        diffStats,
      })
    ).toBeNull();
  });
});
