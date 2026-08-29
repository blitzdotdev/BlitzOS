import { describe, expect, it } from 'vitest';
import type { VisualAnnotationReferencePayload } from '@lody/shared';

import {
  addVisualAnnotationReferenceItem,
  getVisualAnnotationReferenceKey,
  toggleVisualAnnotationReferenceItem,
} from '../src/components/chat/visual-annotation-reference-state';

const reference = {
  source: 'visual_annotation',
  commentId: 'comment-1',
  turnId: 'turn-1',
  body: 'Tighten this spacing',
  authorName: 'Ada',
  status: 'completed',
  anchor: {
    version: 1,
    page: {
      url: '/preview',
      pathname: '/preview',
      viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    },
    click: {
      clientX: 120,
      clientY: 180,
      pageX: 120,
      pageY: 180,
      viewportXRatio: 0.12,
      viewportYRatio: 0.3,
    },
    target: {
      tag: 'button',
      attributes: { 'data-testid': 'primary' },
      text: 'Submit',
      rect: { x: 100, y: 160, width: 120, height: 40 },
      rectRatio: { x: 0.1, y: 0.27, width: 0.12, height: 0.07 },
      selector: '[data-testid="primary"]',
    },
    context: { ancestors: [], nearbyText: ['Submit'] },
  },
} satisfies VisualAnnotationReferencePayload;

describe('visual annotation reference state', () => {
  it('keys references by preview comment identity', () => {
    expect(
      getVisualAnnotationReferenceKey({
        ...reference,
        body: 'Updated body',
      })
    ).toBe(getVisualAnnotationReferenceKey(reference));

    expect(
      getVisualAnnotationReferenceKey({
        ...reference,
        commentId: 'comment-2',
      })
    ).not.toBe(getVisualAnnotationReferenceKey(reference));
  });

  it('adds a reference once and reports it as selected', () => {
    const first = addVisualAnnotationReferenceItem([], reference, () => 'local-1');
    expect(first.selected).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.items).toHaveLength(1);

    const duplicate = addVisualAnnotationReferenceItem(first.items, reference, () => 'local-2');
    expect(duplicate.selected).toBe(true);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.items).toHaveLength(1);
  });

  it('toggles a selected reference back out of the input state', () => {
    const added = toggleVisualAnnotationReferenceItem([], reference, () => 'local-1');
    expect(added.selected).toBe(true);
    expect(added.items).toHaveLength(1);

    const removed = toggleVisualAnnotationReferenceItem(added.items, reference, () => 'local-2');
    expect(removed.selected).toBe(false);
    expect(removed.items).toHaveLength(0);
  });
});
