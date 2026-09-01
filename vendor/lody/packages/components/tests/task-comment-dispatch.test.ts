import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@lody/shared';
import {
  buildTaskCommentPrompt,
  findTaskAgentMentions,
  findTaskUserMentions,
  resolveTaskCommentTarget,
} from '../src/hooks/use-task-comment-dispatch';

const agents = [
  { id: 'a1', name: 'Design' },
  { id: 'a2', name: 'Design Agent' },
  { id: 'a3', name: 'Codex' },
];

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'session-1',
    machineId: 'machine-1',
    createdAt: '2026-07-26T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'codex',
    ...overrides,
  }) as SessionMeta;

describe('findTaskAgentMentions', () => {
  it('finds nothing in an ordinary comment, so it never dispatches', () => {
    expect(findTaskAgentMentions('looks good, ship it', agents).agentConfigIds).toEqual([]);
    // An email-ish string is not a mention of a configured agent.
    expect(findTaskAgentMentions('ping me at a@b.com', agents).agentConfigIds).toEqual([]);
  });

  it('matches a configured agent by name', () => {
    expect(findTaskAgentMentions('@Codex please retry', agents).agentConfigIds).toEqual(['a3']);
  });

  it('prefers the longest name so a shorter one does not shadow it', () => {
    expect(findTaskAgentMentions('@Design Agent take this', agents).agentConfigIds).toEqual(['a2']);
  });

  it('is case insensitive', () => {
    expect(findTaskAgentMentions('@codex', agents).agentConfigIds).toEqual(['a3']);
  });

  it('does not repeat an agent mentioned twice', () => {
    expect(findTaskAgentMentions('@Codex and @Codex again', agents).agentConfigIds).toEqual(['a3']);
  });

  it('ignores agents with a blank name', () => {
    expect(findTaskAgentMentions('@ hello', [{ id: 'x', name: '  ' }]).agentConfigIds).toEqual([]);
  });
});

describe('resolveTaskCommentTarget', () => {
  it('returns nothing when the task has no sessions yet', () => {
    expect(resolveTaskCommentTarget([], ['a1'])).toBeNull();
  });

  it('queues behind a running session rather than starting a second turn', () => {
    const sessions = [
      session({ id: 'idle', lastMessageAt: 100 }),
      session({ id: 'busy', status: { type: 'running' }, lastMessageAt: 1 }),
    ];
    expect(resolveTaskCommentTarget(sessions, [])).toEqual({ sessionId: 'busy', busy: true });
  });

  it('treats an initializing session as busy', () => {
    const sessions = [session({ id: 'starting', status: { type: 'initializing' } })];
    expect(resolveTaskCommentTarget(sessions, [])).toEqual({
      sessionId: 'starting',
      busy: true,
    });
  });

  it('continues the most recently active session when none is running', () => {
    const sessions = [
      session({ id: 'old', lastMessageAt: 10 }),
      session({ id: 'recent', lastMessageAt: 99 }),
    ];
    expect(resolveTaskCommentTarget(sessions, [])).toEqual({ sessionId: 'recent', busy: false });
  });

  it('prefers a session run by the mentioned agent', () => {
    const sessions = [
      session({ id: 'other', agentConfigId: 'a9', lastMessageAt: 99 }),
      session({ id: 'mine', agentConfigId: 'a3', lastMessageAt: 1 }),
    ];
    expect(resolveTaskCommentTarget(sessions, ['a3'])).toEqual({
      sessionId: 'mine',
      busy: false,
    });
  });

  it('returns nothing when the mentioned agent has no session here', () => {
    // This used to fall back to any session on the task. That was wrong: the
    // caller resolves the prompt config from the SESSION, so the fallback ran
    // the request as a different agent and told that agent it had been
    // mentioned. No target lets the UI point at Run instead.
    const sessions = [session({ id: 'other', agentConfigId: 'a9', lastMessageAt: 5 })];
    expect(resolveTaskCommentTarget(sessions, ['a3'])).toBeNull();
  });
});

describe('findTaskAgentMentions boundaries', () => {
  it('does not treat a name inside a longer word as a mention', () => {
    // A mention is the ONE thing that turns a comment into real work, so a
    // short agent name must not be dispatched by "@alice".
    expect(
      findTaskAgentMentions('@alice can you look at this?', [{ id: 'agent-a', name: 'a' }])
        .agentConfigIds
    ).toEqual([]);
  });

  it('ignores an email address in the comment body', () => {
    expect(
      findTaskAgentMentions('ping notify@a.com when done', [{ id: 'agent-a', name: 'a' }])
        .agentConfigIds
    ).toEqual([]);
  });

  it('still matches a standalone mention next to punctuation', () => {
    expect(
      findTaskAgentMentions('hey @a, please start', [{ id: 'agent-a', name: 'a' }]).agentConfigIds
    ).toEqual(['agent-a']);
  });

  it('matches names containing regex metacharacters', () => {
    // Matching is indexOf-based, so "C++" needs no escaping — pin that.
    expect(
      findTaskAgentMentions('@C++ please build', [{ id: 'cpp', name: 'C++' }]).agentConfigIds
    ).toEqual(['cpp']);
  });
});

describe('resolveTaskCommentTarget agent scoping', () => {
  const idle = (id: string, agentConfigId: string, lastMessageAt = 1) =>
    ({ id, agentConfigId, lastMessageAt, status: { type: 'idle' } }) as never;

  it('does not route a mention into another agent\'s session', () => {
    // The caller resolves the prompt config from the session, so falling back
    // here would run "@Codex do X" as Claude and tell Claude it was mentioned.
    expect(resolveTaskCommentTarget([idle('s-claude', 'claude-cfg')], ['codex-cfg'])).toBeNull();
  });

  it('routes to the mentioned agent when it has a session', () => {
    const target = resolveTaskCommentTarget(
      [idle('s-claude', 'claude-cfg', 5), idle('s-codex', 'codex-cfg', 2)],
      ['codex-cfg']
    );

    expect(target).toEqual({ sessionId: 's-codex', busy: false });
  });

  it('prefers the mentioned agent even when another session is more recent', () => {
    const target = resolveTaskCommentTarget(
      [idle('s-claude', 'claude-cfg', 999), idle('s-codex', 'codex-cfg', 1)],
      ['codex-cfg']
    );

    expect(target?.sessionId).toBe('s-codex');
  });
});

describe('findTaskUserMentions', () => {
  const people = [
    { id: 'u1', name: 'Zixuan' },
    { id: 'u2', name: 'Ada Lovelace' },
    { id: 'u3', name: 'a' },
  ];

  it('matches a participant by name', () => {
    expect(findTaskUserMentions('@Zixuan can you take this?', people)).toEqual(['u1']);
  });

  it('prefers the longer name so a shorter one is not shadowed', () => {
    // "@Ada Lovelace" must not also count as an @Ada, mirroring the agent rule.
    expect(findTaskUserMentions('@Ada Lovelace please review', people)).toEqual(['u2']);
  });

  it('does not match a name inside a longer word', () => {
    expect(findTaskUserMentions('@alice will handle it', people)).toEqual([]);
  });

  it('ignores an email address', () => {
    expect(findTaskUserMentions('mail me at notify@a.com', people)).toEqual([]);
  });

  it('returns nothing for a comment with no mention, so it stays a plain record', () => {
    expect(findTaskUserMentions('Just noting progress here.', people)).toEqual([]);
  });
});

describe('buildTaskCommentPrompt', () => {
  it('carries the quoted fragment so "fix this" has a referent', () => {
    const prompt = buildTaskCommentPrompt(
      'Ship the exporter',
      '@Codex fix this',
      'The old endpoint must stay until the mobile release ships.'
    );

    expect(prompt).toContain('> The old endpoint must stay until the mobile release ships.');
    expect(prompt).toContain('@Codex fix this');
    // Quote first: the agent reads what is being discussed before the request.
    expect(prompt.indexOf('> The old endpoint')).toBeLessThan(prompt.indexOf('@Codex fix this'));
  });

  it('marks every line of a multi-line quote', () => {
    const prompt = buildTaskCommentPrompt('T', 'see above', 'first line\nsecond line');

    expect(prompt).toContain('> first line\n> second line');
  });

  it('omits the quote block entirely when there is none', () => {
    expect(buildTaskCommentPrompt('T', 'plain comment')).not.toContain('>');
  });

  it('treats a whitespace-only quote as absent', () => {
    expect(buildTaskCommentPrompt('T', 'plain comment', '   \n  ')).not.toContain('>');
  });
});
