import { describe, expect, it } from 'vitest';

import {
  REVIEW_BUNDLE_SNAPSHOT_VERSION,
  createReviewBundleSnapshot,
  isReviewBundleSnapshot,
  unwrapReviewBundle,
} from '../src/snapshot';
import { createReviewFixtureBundle } from '../src/stories/review-fixture-bundle';
import groupedRefactorReview from '../src/stories/fixtures/grouped-refactor.review.md?raw';

const fixtureBundle = createReviewFixtureBundle({
  reviewFilePath: '/storybook/grouped-refactor.review.md',
  markdown: groupedRefactorReview,
  commits: [
    {
      ref: 'a11b22c',
      sha: 'a11b22c3d4e5f60718293a4b5c6d7e8f90123456',
      authorName: 'Dana Lee',
      authorEmail: 'dana@example.com',
      authorDate: '2026-05-21T09:14:00Z',
      subject: 'refactor(adaptors): drop legacy aliases from the public surface',
      body: '',
    },
  ],
  files: [
    {
      path: 'packages/adaptors/src/index.ts',
      status: 'modified',
      oldText: 'export const ADAPTER_ALIASES = {};\n',
      newText: 'export const ADAPTER_FACTORIES = {};\n',
      additions: 1,
      deletions: 1,
    },
  ],
});

describe('snapshot', () => {
  it('creates a versioned snapshot with source metadata', () => {
    const renderedAt = new Date('2026-06-17T12:00:00.000Z');
    const snapshot = createReviewBundleSnapshot(fixtureBundle, renderedAt);

    expect(snapshot.version).toBe(REVIEW_BUNDLE_SNAPSHOT_VERSION);
    expect(snapshot.renderedAt).toBe('2026-06-17T12:00:00.000Z');
    expect(snapshot.source.reviewFilePath).toBe(fixtureBundle.reviewFilePath);
    expect(snapshot.source.repoPath).toBe(fixtureBundle.repoPath);
    expect(snapshot.source.mergeBase).toBe(
      fixtureBundle.document.frontmatter.mergeBase
    );
    expect(snapshot.source.currentCommit).toBe(
      fixtureBundle.document.frontmatter.currentCommit
    );
    expect(snapshot.bundle).toBe(fixtureBundle);
  });

  it('detects snapshot shapes', () => {
    expect(isReviewBundleSnapshot(fixtureBundle)).toBe(false);
    expect(isReviewBundleSnapshot(createReviewBundleSnapshot(fixtureBundle))).toBe(
      true
    );
    expect(isReviewBundleSnapshot(null)).toBe(false);
    expect(isReviewBundleSnapshot({ version: 2, bundle: {} })).toBe(false);
  });

  it('unwraps snapshots and passes through raw bundles', () => {
    const snapshot = createReviewBundleSnapshot(fixtureBundle);
    expect(unwrapReviewBundle(snapshot)).toBe(fixtureBundle);
    expect(unwrapReviewBundle(fixtureBundle)).toBe(fixtureBundle);
  });
});
