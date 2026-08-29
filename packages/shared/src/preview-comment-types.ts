import type { MinimalVisualAnnotationAnchor } from './visual-annotation-types';
import type { VisualAnnotationReferencePayload } from './ai';
import type { SessionId, WorkspaceId } from './index';

export const PREVIEW_COMMENT_DOC_PREFIX = 'preview-comment-';
export const LORO_PREVIEW_COMMENT_STREAM_SEGMENT = 'pc';

export const getPreviewCommentRoomId = (sessionId: SessionId): string =>
  `${PREVIEW_COMMENT_DOC_PREFIX}${sessionId}`;

export const isPreviewCommentDocRoomId = (roomId: string): boolean =>
  roomId.startsWith(PREVIEW_COMMENT_DOC_PREFIX);

export const getSessionIdFromPreviewCommentRoomId = (roomId: string): SessionId | null => {
  if (!isPreviewCommentDocRoomId(roomId)) {
    return null;
  }
  const sessionId = roomId.slice(PREVIEW_COMMENT_DOC_PREFIX.length);
  return sessionId ? (sessionId as SessionId) : null;
};

export const getLoroPreviewCommentStreamId = (
  workspaceId: WorkspaceId,
  sessionId: SessionId
): string => `${workspaceId}:${LORO_PREVIEW_COMMENT_STREAM_SEGMENT}:${sessionId}`;

export type PreviewVisualCommentStatus = 'completed' | 'submitted' | 'cancelled';

export type PreviewVisualComment = {
  id: string;
  turnId: string;
  status: PreviewVisualCommentStatus;
  body: string;
  anchor: MinimalVisualAnnotationAnchor;
  authorId: string;
  authorName?: string;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  submittedMessageId?: string;
  resolvedAt?: number;
  resolvedBy?: string;
};

export type NewPreviewVisualComment = Omit<
  PreviewVisualComment,
  'status' | 'submittedAt' | 'submittedMessageId' | 'resolvedAt' | 'resolvedBy'
> & {
  status: 'completed';
  submittedAt?: never;
  submittedMessageId?: never;
  resolvedAt?: never;
  resolvedBy?: never;
};

export type PreviewVisualCommentTurn = {
  turnId: string;
  comments: PreviewVisualComment[];
};

export type PreviewVisualCommentDoc = {
  meta: {
    sessionId: SessionId;
  };
  turns: Record<string, PreviewVisualCommentTurn>;
};

export type PreviewVisualCommentInput = {
  id: string;
  turnId: string;
  body: string;
  anchor: MinimalVisualAnnotationAnchor;
  authorId: string;
  authorName?: string;
  createdAt: number;
  updatedAt?: number;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const createPreviewVisualCommentDoc = (sessionId: SessionId): PreviewVisualCommentDoc => ({
  meta: { sessionId },
  turns: {},
});

export const createPreviewVisualComment = (
  input: PreviewVisualCommentInput
): NewPreviewVisualComment => ({
  id: input.id,
  turnId: input.turnId,
  status: 'completed',
  body: input.body,
  anchor: input.anchor,
  authorId: input.authorId,
  ...(isNonEmptyString(input.authorName) ? { authorName: input.authorName } : {}),
  createdAt: input.createdAt,
  updatedAt: input.updatedAt ?? input.createdAt,
});

export const createVisualAnnotationReferenceFromPreviewComment = (
  comment: PreviewVisualComment
): VisualAnnotationReferencePayload => ({
  source: 'visual_annotation',
  commentId: comment.id,
  turnId: comment.turnId,
  body: comment.body,
  ...(isNonEmptyString(comment.authorName) ? { authorName: comment.authorName } : {}),
  status: comment.status,
  anchor: comment.anchor,
});
