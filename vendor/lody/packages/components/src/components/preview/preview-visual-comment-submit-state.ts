import type {
  PreviewVisualCommentDocInput,
  PreviewVisualComment,
  VisualAnnotationReferencePayload,
} from '@lody/shared';

type PreviewVisualCommentTurnLike = {
  comments: PreviewVisualComment[];
};

const isPreviewVisualCommentTurnLike = (value: unknown): value is PreviewVisualCommentTurnLike =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { comments?: unknown }).comments);

export const markVisualAnnotationReferencesSubmittedInDoc = (
  draft: PreviewVisualCommentDocInput,
  references: readonly VisualAnnotationReferencePayload[],
  submittedAt: number
): number => {
  if (references.length === 0) {
    return 0;
  }

  const commentIds = new Set(references.map((reference) => reference.commentId));
  let changed = 0;

  for (const turn of Object.values(draft.turns)) {
    if (!isPreviewVisualCommentTurnLike(turn)) {
      continue;
    }
    for (const comment of turn.comments) {
      if (!commentIds.has(comment.id) || comment.status === 'submitted') {
        continue;
      }
      comment.status = 'submitted';
      comment.submittedAt = submittedAt;
      comment.updatedAt = submittedAt;
      changed += 1;
    }
  }

  return changed;
};
