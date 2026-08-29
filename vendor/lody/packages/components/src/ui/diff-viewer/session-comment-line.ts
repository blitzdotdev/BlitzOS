import type { LineTypes } from '@pierre/diffs';

export type CommentableDiffLineType = Extract<LineTypes, 'change-addition' | 'change-deletion'>;

export function isCommentableDiffLineType(
  lineType: LineTypes
): lineType is CommentableDiffLineType {
  return lineType === 'change-addition' || lineType === 'change-deletion';
}
