import { describe, expect, it, vi } from 'vitest';
import {
  OUTLINE_ANCHOR_TOLERANCE_PX,
  buildOutlineAnchors,
  resolveActiveOutlineIndex,
  type ConversationOutlineAnchor,
  type ConversationOutlineEntry,
} from '../src/lib/conversation-outline';

/**
 * Reader position is resolved from Virtua's index math, never from the DOM —
 * the conversation is virtualized, so most rounds have no element to observe.
 * These tests drive that math with a plain offset table: no DOM, no timers, no
 * virtualizer.
 */

const entry = (messageIndex: number): ConversationOutlineEntry => ({
  key: `k${messageIndex}`,
  messageId: `m${messageIndex}`,
  messageIndex,
  title: `round ${messageIndex}`,
  preview: '',
  startsWithAgent: false,
  weight: 0,
  timestamp: undefined,
});

/** Row heights → cumulative offsets, the shape Virtua's `getItemOffset` has. */
const offsetTable = (heights: readonly number[]): ((rowIndex: number) => number) => {
  const offsets: number[] = [];
  let total = 0;
  for (const height of heights) {
    offsets.push(total);
    total += height;
  }
  return (rowIndex) => offsets[rowIndex] ?? total;
};

describe('buildOutlineAnchors', () => {
  it('pairs each entry with the first virtual row of its round', () => {
    const rows = [
      { messageIndex: 0 },
      { messageIndex: 1 },
      { messageIndex: 1 },
      { messageIndex: 1 },
      { messageIndex: 2 },
    ];

    expect(buildOutlineAnchors(rows, [entry(0), entry(2)])).toEqual<ConversationOutlineAnchor[]>([
      { outlineIndex: 0, rowIndex: 0 },
      { outlineIndex: 1, rowIndex: 4 },
    ]);
  });

  it('drops a round that produced no rows instead of leaving a hole', () => {
    // Reachable in production: `buildChatStreamItems` discards empty assistant
    // entries, so a round can consist of nothing renderable.
    const rows = [{ messageIndex: 0 }, { messageIndex: 4 }];
    const anchors = buildOutlineAnchors(rows, [entry(0), entry(2), entry(4)]);

    expect(anchors).toEqual<ConversationOutlineAnchor[]>([
      { outlineIndex: 0, rowIndex: 0 },
      { outlineIndex: 2, rowIndex: 1 },
    ]);
  });

  it('returns nothing when there are no rows', () => {
    expect(buildOutlineAnchors([], [entry(0)])).toEqual([]);
  });
});

describe('resolveActiveOutlineIndex', () => {
  const anchors: ConversationOutlineAnchor[] = [
    { outlineIndex: 0, rowIndex: 0 },
    { outlineIndex: 1, rowIndex: 2 },
    { outlineIndex: 2, rowIndex: 5 },
  ];
  // Seven 100px rows, so row N starts at N*100:
  // rows 0,1 → round 0 (0..200) | rows 2,3,4 → round 1 (200..500) | rows 5,6 → round 2 (500..)
  const getRowOffset = offsetTable([100, 100, 100, 100, 100, 100, 100]);

  it('reports the round whose anchor is exactly at the viewport top', () => {
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, 200)).toBe(1);
  });

  it('keeps reporting a round after its anchor has scrolled above the viewport', () => {
    // The property that makes the rail usable during a long turn: highlighting
    // only an on-screen anchor would blank it for most of the scroll.
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, 380)).toBe(1);
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, 490)).toBe(1);
  });

  it('counts a round that starts a hair below the top edge as already current', () => {
    // A jump settles within a couple of pixels of its target, and HiDPI scroll
    // offsets are fractional. Exact-to-the-pixel would report the previous
    // round while its successor visibly owns the top edge.
    expect(
      resolveActiveOutlineIndex(anchors, getRowOffset, 500 - OUTLINE_ANCHOR_TOLERANCE_PX)
    ).toBe(2);
    expect(
      resolveActiveOutlineIndex(anchors, getRowOffset, 500 - OUTLINE_ANCHOR_TOLERANCE_PX - 1)
    ).toBe(1);
  });

  it('advances as soon as the next round reaches the viewport top', () => {
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, 500)).toBe(2);
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, 10_000)).toBe(2);
  });

  it('clamps to the first round above the first anchor', () => {
    // `leadingContent` (session provenance) scrolls above round 0, and a
    // rubber-band overscroll yields a negative offset. Neither means "nowhere".
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, 0)).toBe(0);
    expect(resolveActiveOutlineIndex(anchors, getRowOffset, -120)).toBe(0);
  });

  it('reports the outline index, not the anchor position, when rounds were dropped', () => {
    const sparse: ConversationOutlineAnchor[] = [
      { outlineIndex: 0, rowIndex: 0 },
      { outlineIndex: 7, rowIndex: 2 },
    ];

    expect(resolveActiveOutlineIndex(sparse, getRowOffset, 250)).toBe(7);
  });

  it('reports nothing when there are no anchors', () => {
    expect(resolveActiveOutlineIndex([], getRowOffset, 100)).toBe(-1);
  });

  describe('at the end of the list', () => {
    // The final rounds are usually shorter than the viewport, so the scroll
    // clamps and the top edge still belongs to an earlier round.
    it('reports the last round even though an earlier one owns the top edge', () => {
      expect(resolveActiveOutlineIndex(anchors, getRowOffset, 380, true)).toBe(2);
    });

    it('reports the last round while pinned to the bottom of a streaming turn', () => {
      const streaming: ConversationOutlineAnchor[] = [
        { outlineIndex: 0, rowIndex: 0 },
        { outlineIndex: 1, rowIndex: 6 },
      ];
      expect(resolveActiveOutlineIndex(streaming, getRowOffset, 0, true)).toBe(1);
    });

    it('still reports nothing when there are no anchors', () => {
      expect(resolveActiveOutlineIndex([], getRowOffset, 100, true)).toBe(-1);
    });
  });

  it('asks for a logarithmic number of offsets rather than all of them', () => {
    // This runs on every scroll event, so it must not walk the whole outline.
    const many: ConversationOutlineAnchor[] = Array.from({ length: 1_024 }, (_, index) => ({
      outlineIndex: index,
      rowIndex: index,
    }));
    const spy = vi.fn((rowIndex: number) => rowIndex * 100);

    expect(resolveActiveOutlineIndex(many, spy, 50_050)).toBe(500);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(11);
  });
});
