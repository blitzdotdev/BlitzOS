import type { ReviewBundle } from './types';

export const REVIEW_BUNDLE_SNAPSHOT_VERSION = 1;

export interface ReviewBundleSnapshot {
  readonly version: typeof REVIEW_BUNDLE_SNAPSHOT_VERSION;
  readonly renderedAt: string;
  readonly source: {
    readonly reviewFilePath: string;
    readonly repoPath: string;
    readonly mergeBase: string;
    readonly currentCommit: string;
  };
  readonly bundle: ReviewBundle;
}

export type ReviewBundleInput = ReviewBundle | ReviewBundleSnapshot;

export function createReviewBundleSnapshot(
  bundle: ReviewBundle,
  renderedAt: Date = new Date()
): ReviewBundleSnapshot {
  return {
    version: REVIEW_BUNDLE_SNAPSHOT_VERSION,
    renderedAt: renderedAt.toISOString(),
    source: {
      reviewFilePath: bundle.reviewFilePath ?? '',
      repoPath: bundle.repoPath ?? '',
      mergeBase: bundle.document.frontmatter.mergeBase,
      currentCommit: bundle.document.frontmatter.currentCommit,
    },
    bundle,
  };
}

export function isReviewBundleSnapshot(value: unknown): value is ReviewBundleSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    (value as Record<string, unknown>).version === REVIEW_BUNDLE_SNAPSHOT_VERSION &&
    'bundle' in value &&
    typeof (value as Record<string, unknown>).bundle === 'object' &&
    (value as Record<string, unknown>).bundle !== null
  );
}

export function unwrapReviewBundle(input: ReviewBundleInput): ReviewBundle {
  return isReviewBundleSnapshot(input) ? input.bundle : input;
}
