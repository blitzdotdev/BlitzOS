import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import { selectHighOwners, type OwnerActivityInput } from './pr-poll-priority';

const sid = (value: string): SessionId => value as SessionId;
const T0 = 1_720_000_000_000;
const OPTIONS = { activityWindowMs: 10 * 60_000, highOwnerCap: 100 };

function owner(
  id: string,
  overrides: Partial<Omit<OwnerActivityInput, 'ownerSessionId'>> = {}
): OwnerActivityInput {
  return {
    ownerSessionId: sid(id),
    memberSessionIds: [sid(id)],
    lastMessageAtMs: null,
    ...overrides,
  };
}

describe('selectHighOwners', () => {
  it('promotes viewed owners (any member counts) and recent-activity owners', () => {
    const high = selectHighOwners(
      [
        owner('viewed'),
        owner('viewed-via-child', { memberSessionIds: [sid('viewed-via-child'), sid('tab')] }),
        owner('active', { lastMessageAtMs: T0 - 5 * 60_000 }),
        owner('stale', { lastMessageAtMs: T0 - 11 * 60_000 }),
        owner('silent'),
      ],
      new Set([sid('viewed'), sid('tab')]),
      T0,
      OPTIONS
    );

    expect(high).toEqual(new Set([sid('viewed'), sid('viewed-via-child'), sid('active')]));
  });

  it('activity exactly at the window boundary still counts; one ms later does not', () => {
    const atBoundary = owner('a', { lastMessageAtMs: T0 - OPTIONS.activityWindowMs });
    const pastBoundary = owner('b', { lastMessageAtMs: T0 - OPTIONS.activityWindowMs - 1 });
    const high = selectHighOwners([atBoundary, pastBoundary], new Set(), T0, OPTIONS);
    expect(high).toEqual(new Set([sid('a')]));
  });

  it('missing signals leave the owner in the low lane (never a precondition)', () => {
    expect(selectHighOwners([owner('s')], new Set(), T0, OPTIONS)).toEqual(new Set());
  });

  it('caps the high lane with a stable ranking: viewed, then recent activity, then id', () => {
    const owners = [
      owner('act-old', { lastMessageAtMs: T0 - 9 * 60_000 }),
      owner('act-new', { lastMessageAtMs: T0 - 1 * 60_000 }),
      owner('viewed-b'),
      owner('viewed-a'),
    ];
    const viewed = new Set([sid('viewed-a'), sid('viewed-b')]);

    const capped = selectHighOwners(owners, viewed, T0, { ...OPTIONS, highOwnerCap: 3 });
    // Viewed first (ties broken by stable id), then newest activity.
    expect(capped).toEqual(new Set([sid('viewed-a'), sid('viewed-b'), sid('act-new')]));

    // Deterministic: input order does not change the result.
    const reversed = selectHighOwners([...owners].reverse(), viewed, T0, {
      ...OPTIONS,
      highOwnerCap: 3,
    });
    expect(reversed).toEqual(capped);
  });
});
