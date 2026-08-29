import type { VirtualizerHandle } from 'virtua';

/** Ignore sub-pixel differences when clamping to the true DOM bottom. */
const SCROLL_EPSILON = 1;

export type ScrollElementLike = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;

export function getScrollElementDistanceFromBottom(scrollElement: ScrollElementLike): number {
  return Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
  );
}

export function getScrollElementMaxOffset(scrollElement: ScrollElementLike): number {
  return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
}

export function getScrollBottomPaddingOffset(scrollElement: HTMLElement | null): number {
  if (!scrollElement || typeof getComputedStyle !== 'function') {
    return 0;
  }
  const paddingBottom = Number.parseFloat(getComputedStyle(scrollElement).paddingBottom);
  return Number.isFinite(paddingBottom) ? Math.max(0, paddingBottom) : 0;
}

export function scrollViewportToRealBottom(options: {
  itemCount: number;
  vlist: Pick<VirtualizerHandle, 'scrollToIndex'> | null;
  scrollElement: ScrollElementLike | null;
  bottomOffset?: number;
}): void {
  const { itemCount, vlist, scrollElement, bottomOffset = 0 } = options;
  if (itemCount <= 0) return;

  vlist?.scrollToIndex(itemCount - 1, { align: 'end', offset: bottomOffset });

  if (!scrollElement) return;

  const maxScrollTop = getScrollElementMaxOffset(scrollElement);
  if (Math.abs(scrollElement.scrollTop - maxScrollTop) > SCROLL_EPSILON) {
    scrollElement.scrollTop = maxScrollTop;
  }
}
