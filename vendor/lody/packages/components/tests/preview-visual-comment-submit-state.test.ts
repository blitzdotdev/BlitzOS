import { describe, expect, it } from 'vitest';
import type { PreviewVisualCommentDocInput, VisualAnnotationReferencePayload } from '@lody/shared';
import { createPreviewVisualComment } from '@lody/shared/preview-comment-types';
import type { MinimalVisualAnnotationAnchor } from '@lody/shared/visual-annotation-types';
import { markVisualAnnotationReferencesSubmittedInDoc } from '../src/components/preview/preview-visual-comment-submit-state';

const anchor: MinimalVisualAnnotationAnchor = {
  version: 1,
  page: {
    url: '/preview',
    pathname: '/preview',
    viewport: { width: 600, height: 400, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  },
  click: {
    clientX: 120,
    clientY: 180,
    pageX: 120,
    pageY: 180,
    viewportXRatio: 0.2,
    viewportYRatio: 0.45,
  },
  target: {
    tag: 'button',
    attributes: {},
    text: 'Start review',
    rect: { x: 100, y: 160, width: 120, height: 40 },
    rectRatio: { x: 0.17, y: 0.4, width: 0.2, height: 0.1 },
    selector: 'button',
  },
  context: { ancestors: [], nearbyText: ['Start review'] },
};

const createReference = (commentId: string): VisualAnnotationReferencePayload => ({
  source: 'visual_annotation',
  commentId,
  turnId: 'turn-1',
  body: 'Move this action closer to the copy.',
  status: 'completed',
  anchor,
});

describe('markVisualAnnotationReferencesSubmittedInDoc', () => {
  it('marks sent visual annotation references as submitted in the preview comment doc', () => {
    const doc: PreviewVisualCommentDocInput = {
      meta: { sessionId: 'session-1' },
      turns: {
        'turn-1': {
          turnId: 'turn-1',
          comments: [
            createPreviewVisualComment({
              id: 'comment-1',
              turnId: 'turn-1',
              body: 'Move this action closer to the copy.',
              anchor,
              authorId: 'user-1',
              createdAt: 100,
            }),
            createPreviewVisualComment({
              id: 'comment-2',
              turnId: 'turn-1',
              body: 'Leave this one alone.',
              anchor,
              authorId: 'user-1',
              createdAt: 200,
            }),
          ],
        },
      },
    };

    const changed = markVisualAnnotationReferencesSubmittedInDoc(
      doc,
      [createReference('comment-1')],
      300
    );

    expect(changed).toBe(1);
    expect(doc.turns['turn-1']?.comments[0]?.status).toBe('submitted');
    expect(doc.turns['turn-1']?.comments[0]?.submittedAt).toBe(300);
    expect(doc.turns['turn-1']?.comments[0]?.updatedAt).toBe(300);
    expect(doc.turns['turn-1']?.comments[1]?.status).toBe('completed');
  });
});
