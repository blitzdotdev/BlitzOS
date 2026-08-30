import { describe, expect, it } from 'vitest';
import type { SessionPullRequestMeta } from '@lody/shared';

import {
  getAutoArchivePrDecision,
  getAutoArchivePrSnapshot,
  pickLatestPr,
  type AutoArchivePrSnapshot,
} from '../src/lib/auto-archive-pr';

const createPullRequest = (
  overrides: Partial<SessionPullRequestMeta> = {}
): SessionPullRequestMeta => ({
  url: 'https://github.com/loro-dev/lody/pull/2000',
  number: 2000,
  repository: 'loro-dev/lody',
  branch: 'fix/pr-auto-archive',
  status: 'open',
  reportedAt: '2026-05-05T10:00:00.000Z',
  ...overrides,
});

const snapshot = (overrides: Partial<AutoArchivePrSnapshot> = {}): AutoArchivePrSnapshot => ({
  url: 'https://github.com/loro-dev/lody/pull/2000',
  status: 'open',
  ...overrides,
});

describe('pickLatestPr', () => {
  it('picks the newest PR by reportedAt even when input is not sorted', () => {
    expect(
      pickLatestPr([
        createPullRequest({
          number: 1,
          url: 'https://github.com/loro-dev/lody/pull/1',
          reportedAt: '2026-05-05T10:00:00.000Z',
        }),
        createPullRequest({
          number: 2,
          url: 'https://github.com/loro-dev/lody/pull/2',
          reportedAt: '2026-05-05T11:00:00.000Z',
        }),
      ])?.number
    ).toBe(2);
  });
});

describe('getAutoArchivePrSnapshot', () => {
  it('returns the latest PR identity and status', () => {
    expect(
      getAutoArchivePrSnapshot([
        createPullRequest({
          status: 'merged',
          reportedAt: '2026-05-05T11:00:00.000Z',
        }),
      ])
    ).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/2000',
      status: 'merged',
    });
  });
});

describe('getAutoArchivePrDecision', () => {
  it('archives when an observed PR transitions from open to merged', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'merged' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: true, status: 'merged' });
  });

  it('does not archive a restored session whose PR is still merged', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'merged' }),
        current: snapshot({ status: 'merged' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: false, status: 'merged' });
  });

  it('does not retro-archive when the first observed PR state is terminal', () => {
    expect(
      getAutoArchivePrDecision({
        previous: undefined,
        current: snapshot({ status: 'closed' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: false, status: 'closed' });
  });

  it('archives if a restored PR later changes to a new enabled terminal state', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'closed' }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: true, status: 'closed' });
  });

  it('does not archive a different PR that is first observed as terminal', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({
          url: 'https://github.com/loro-dev/lody/pull/1999',
          status: 'open',
        }),
        current: snapshot({
          url: 'https://github.com/loro-dev/lody/pull/2000',
          status: 'merged',
        }),
        archiveOnMerged: true,
        archiveOnClosed: true,
      })
    ).toEqual({ shouldArchive: false, status: 'merged' });
  });

  it('respects the merged and closed settings independently', () => {
    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'merged' }),
        archiveOnMerged: false,
        archiveOnClosed: true,
      }).shouldArchive
    ).toBe(false);

    expect(
      getAutoArchivePrDecision({
        previous: snapshot({ status: 'open' }),
        current: snapshot({ status: 'closed' }),
        archiveOnMerged: true,
        archiveOnClosed: false,
      }).shouldArchive
    ).toBe(false);
  });
});
