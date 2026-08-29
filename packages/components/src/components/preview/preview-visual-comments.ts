import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';

export const isPreviewVisualCommentVisible = (comment: PreviewVisualComment): boolean =>
  comment.resolvedAt === undefined;

export const getVisiblePreviewVisualComments = (
  comments: readonly PreviewVisualComment[]
): PreviewVisualComment[] => comments.filter(isPreviewVisualCommentVisible);
