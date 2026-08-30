import { describe, expect, it } from 'vitest';

import type { MachineId, SessionId } from '../src/ai';
import { buildInitialHistoryEntry, buildInitialSessionMetaPatch } from '../src/session-bootstrap';

describe('session bootstrap helpers', () => {
  it('builds the first pending user history entry from prompt and input blocks', () => {
    const entry = buildInitialHistoryEntry({
      userId: 'user-1',
      timestamp: '2026-04-19T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      prompt: '  inspect repo  ',
      inputBlocks: [{ type: 'text', text: '  inspect repo  ' }],
      modeId: 'safe',
      modelId: 'default',
      configOptionValues: { reasoning: 'high' },
      issuePRMentions: [
        {
          type: 'issue',
          title: 'Investigate missing session',
          url: 'https://github.com/loro-dev/lody/issues/123',
          number: 123,
        },
      ],
      resume: 'resume-123',
    });

    expect(entry).toEqual(
      expect.objectContaining({
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-04-19T00:00:00.000Z',
        status: 'pending',
        read: false,
        finished: true,
        items: [{ type: 'text', text: 'inspect repo' }],
        inputConfig: {
          prompt: 'inspect repo',
          inputBlocks: [{ type: 'text', text: 'inspect repo' }],
          cliType: 'builtin',
          agentType: 'codex',
          modeId: 'safe',
          modelId: 'default',
          configOptionValues: { reasoning: 'high' },
          issuePRMentions: [
            {
              type: 'issue',
              title: 'Investigate missing session',
              url: 'https://github.com/loro-dev/lody/issues/123',
              number: 123,
            },
          ],
          resume: 'resume-123',
        },
      })
    );
    expect(entry?.id).toEqual(expect.any(String));
  });

  it('returns null when there is no effective initial user input', () => {
    const entry = buildInitialHistoryEntry({
      userId: 'user-1',
      timestamp: '2026-04-19T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      prompt: '   ',
      inputBlocks: [{ type: 'text', text: '   ' }],
    });

    expect(entry).toBeNull();
  });

  it('builds the base session meta patch with derived repo fields', () => {
    const patch = buildInitialSessionMetaPatch({
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: '2026-04-19T00:00:00.000Z',
      project: {
        kind: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      },
      parentSessionId: 'parent-1' as SessionId,
      fromFeedbackPostId: 'feedback-1',
    });

    expect(patch).toEqual({
      id: 'session-1',
      machineId: 'machine-1',
      userId: 'user-1',
      status: { type: 'idle' },
      isArchived: false,
      createdAt: '2026-04-19T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      project: {
        kind: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      },
      repoFullName: 'loro-dev/lody',
      baseBranch: 'main',
      parentSessionId: 'parent-1',
      fromFeedbackPostId: 'feedback-1',
    });
  });

  it('does not persist an unresolved local branch selector as baseBranch', () => {
    const patch = buildInitialSessionMetaPatch({
      sessionId: 'session-local' as SessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: '2026-08-02T00:00:00.000Z',
      project: {
        kind: 'local',
        localProjectId: 'project-1' as never,
        branch: 'lody:branch:remote:origin:foo',
        useWorktree: true,
      },
    });

    expect(patch.project).toMatchObject({ branch: 'lody:branch:remote:origin:foo' });
    expect(patch).not.toHaveProperty('baseBranch');
  });
});
