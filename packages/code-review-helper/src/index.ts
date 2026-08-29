export { parseReviewMarkdown, parseLineRange, parseReviewRef } from './parser';
export {
  collectBundleDiagnostics,
  countLines,
  hasErrorDiagnostics,
  validateParsedReviewDocument,
  validateResolvedBlock,
} from './validation';
export { createSparseTextForRanges, getSourceLine } from './sparse-text';
export {
  REVIEW_BUNDLE_SNAPSHOT_VERSION,
  createReviewBundleSnapshot,
  isReviewBundleSnapshot,
  unwrapReviewBundle,
} from './snapshot';
export type { ReviewBundleInput, ReviewBundleSnapshot } from './snapshot';
export type {
  LineRange,
  ReviewBundle,
  ReviewChangeBlock,
  ReviewCommentAnchor,
  ReviewDiagnostic,
  ReviewDocument,
  ReviewFileStatus,
  ReviewFinding,
  ReviewFindingRef,
  ReviewFrontmatter,
  ReviewGroup,
  ReviewNote,
  ReviewResolvedBlock,
  ReviewResolvedFile,
  ReviewResolvedGroup,
  ReviewSeverity,
  ReviewSide,
  ReviewUserComment,
} from './types';
