'use client';

import type { VisualAnnotationReferencePayload } from '@lody/shared';
import type { VisualAnnotationReferenceChipItem } from './visual-annotation-reference-chip';

export const EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS: readonly string[] = [];

export function getVisualAnnotationReferenceKey(
  reference: VisualAnnotationReferencePayload
): string {
  return JSON.stringify([reference.source, reference.commentId]);
}

export function getVisualAnnotationReferenceKeys(
  items: readonly VisualAnnotationReferenceChipItem[]
): string[] {
  return items.map((item) => getVisualAnnotationReferenceKey(item.reference));
}

export function hasVisualAnnotationReference(
  items: readonly VisualAnnotationReferenceChipItem[],
  reference: VisualAnnotationReferencePayload
): boolean {
  const key = getVisualAnnotationReferenceKey(reference);
  return items.some((item) => getVisualAnnotationReferenceKey(item.reference) === key);
}

export function addVisualAnnotationReferenceItem(
  items: readonly VisualAnnotationReferenceChipItem[],
  reference: VisualAnnotationReferencePayload,
  createLocalId: () => string
): { items: VisualAnnotationReferenceChipItem[]; selected: true; changed: boolean } {
  if (hasVisualAnnotationReference(items, reference)) {
    return { items: [...items], selected: true, changed: false };
  }
  return {
    items: [...items, { localId: createLocalId(), reference }],
    selected: true,
    changed: true,
  };
}

export function toggleVisualAnnotationReferenceItem(
  items: readonly VisualAnnotationReferenceChipItem[],
  reference: VisualAnnotationReferencePayload,
  createLocalId: () => string
): { items: VisualAnnotationReferenceChipItem[]; selected: boolean; changed: true } {
  const key = getVisualAnnotationReferenceKey(reference);
  const idx = items.findIndex((item) => getVisualAnnotationReferenceKey(item.reference) === key);
  if (idx >= 0) {
    return {
      items: items.filter((_, i) => i !== idx),
      selected: false,
      changed: true,
    };
  }
  return {
    items: [...items, { localId: createLocalId(), reference }],
    selected: true,
    changed: true,
  };
}
