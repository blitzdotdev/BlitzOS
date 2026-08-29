import { describe, expect, it } from 'vitest';
import type { GitHubPullRequestDetails } from '@lody/shared';

import {
  isPullRequestMergeabilityPending,
  isPullRequestReadyForReviewTransitionPending,
  mergePullRequestDetailsState,
} from '../src/lib/github-pr-details-state';

const createPullRequest = (
  overrides: Partial<GitHubPullRequestDetails> = {}
): GitHubPullRequestDetails => ({
  number: 42,
  nodeId: 'PR_kwDO_test',
  title: 'Fix PR detail state',
  body: '',
  state: 'open',
  merged: false,
  draft: false,
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
  baseRef: 'main',
  headRef: 'fix/pr-detail-state',
  headSha: 'abc123',
  user: null,
  createdAt: '2026-04-21T09:00:00.000Z',
  updatedAt: '2026-04-21T09:05:00.000Z',
  mergedAt: null,
  closedAt: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
  mergeable: true,
  mergeableState: 'clean',
  ...overrides,
});

describe('mergePullRequestDetailsState', () => {
  it('does not let a stale PR details response roll a merged PR back to open', () => {
    const previous = createPullRequest({
      state: 'closed',
      merged: true,
      mergedAt: '2026-04-21T09:10:00.000Z',
      closedAt: '2026-04-21T09:10:00.000Z',
    });
    const incoming = createPullRequest({
      state: 'open',
      merged: false,
      updatedAt: '2026-04-21T09:11:00.000Z',
    });

    const merged = mergePullRequestDetailsState(previous, incoming);

    expect(merged).toMatchObject({
      state: 'closed',
      merged: true,
      mergedAt: '2026-04-21T09:10:00.000Z',
      closedAt: '2026-04-21T09:10:00.000Z',
      updatedAt: '2026-04-21T09:11:00.000Z',
    });
  });

  it('accepts normal PR details updates before the PR is merged', () => {
    const previous = createPullRequest();
    const incoming = createPullRequest({
      title: 'Updated title',
      updatedAt: '2026-04-21T09:15:00.000Z',
    });

    expect(mergePullRequestDetailsState(previous, incoming)).toEqual(incoming);
  });

  it('does not let a stale PR details response roll a ready PR back to draft', () => {
    const previous = createPullRequest({
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      updatedAt: '2026-04-21T09:10:00.000Z',
    });
    const incoming = createPullRequest({
      draft: true,
      mergeable: true,
      mergeableState: 'draft',
      updatedAt: '2026-04-21T09:05:00.000Z',
    });

    expect(mergePullRequestDetailsState(previous, incoming)).toMatchObject({
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      updatedAt: '2026-04-21T09:10:00.000Z',
    });
  });

  it('accepts a newer draft PR details update', () => {
    const previous = createPullRequest({
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      updatedAt: '2026-04-21T09:10:00.000Z',
    });
    const incoming = createPullRequest({
      draft: true,
      mergeable: true,
      mergeableState: 'draft',
      updatedAt: '2026-04-21T09:15:00.000Z',
    });

    expect(mergePullRequestDetailsState(previous, incoming)).toEqual(incoming);
  });
});

describe('isPullRequestReadyForReviewTransitionPending', () => {
  it('stays pending while GitHub still reports the PR as draft', () => {
    expect(
      isPullRequestReadyForReviewTransitionPending(
        createPullRequest({ draft: true, mergeable: null, mergeableState: 'draft' })
      )
    ).toBe(true);
  });

  it('stays pending while GitHub is recomputing mergeability after draft clears', () => {
    expect(
      isPullRequestReadyForReviewTransitionPending(
        createPullRequest({ draft: false, mergeable: null, mergeableState: 'unknown' })
      )
    ).toBe(true);
  });

  it('finishes once a non-draft PR has a resolved mergeability state', () => {
    expect(isPullRequestReadyForReviewTransitionPending(createPullRequest())).toBe(false);
    expect(
      isPullRequestReadyForReviewTransitionPending(
        createPullRequest({ mergeable: false, mergeableState: 'dirty' })
      )
    ).toBe(false);
  });
});

describe('isPullRequestMergeabilityPending', () => {
  it('returns true while GitHub has not resolved mergeability', () => {
    expect(
      isPullRequestMergeabilityPending(
        createPullRequest({ mergeable: null, mergeableState: 'unknown' })
      )
    ).toBe(true);
    expect(
      isPullRequestMergeabilityPending(
        createPullRequest({ mergeable: null, mergeableState: 'clean' })
      )
    ).toBe(true);
    expect(
      isPullRequestMergeabilityPending(
        createPullRequest({ mergeable: true, mergeableState: 'unknown' })
      )
    ).toBe(true);
  });

  it('returns false once the PR is resolved or cannot be merged from this state', () => {
    expect(isPullRequestMergeabilityPending(createPullRequest())).toBe(false);
    expect(
      isPullRequestMergeabilityPending(
        createPullRequest({ mergeable: false, mergeableState: 'dirty' })
      )
    ).toBe(false);
    expect(
      isPullRequestMergeabilityPending(createPullRequest({ draft: true, mergeableState: 'draft' }))
    ).toBe(false);
    expect(
      isPullRequestMergeabilityPending(createPullRequest({ state: 'closed', mergeable: null }))
    ).toBe(false);
    expect(
      isPullRequestMergeabilityPending(createPullRequest({ merged: true, mergeable: null }))
    ).toBe(false);
    expect(isPullRequestMergeabilityPending(null)).toBe(false);
  });
});
