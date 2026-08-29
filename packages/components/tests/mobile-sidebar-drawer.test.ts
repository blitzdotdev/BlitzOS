import { describe, expect, it } from 'vitest';
import {
  hasActiveTextSelection,
  resolveMobileDrawerWidth,
  shouldIgnoreSidebarSwipeGesture,
} from '../src/components/mobile/mobile-sidebar-drawer';

type FakeElement = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  dataset?: Record<string, string | undefined>;
  parentElement?: FakeElement | null;
};

type FakeSelection = {
  rangeCount: number;
  isCollapsed: boolean;
};

function createFakeDocument({
  activeElement = null,
  selection = null,
}: {
  activeElement?: FakeElement | null;
  selection?: FakeSelection | null;
}) {
  return {
    activeElement,
    getSelection: () => selection,
  };
}

describe('resolveMobileDrawerWidth', () => {
  it('uses the preferred width when it is within the viewport cap', () => {
    expect(resolveMobileDrawerWidth(320, 500)).toBe(320);
  });

  it('caps the drawer at 80 percent of the viewport width', () => {
    expect(resolveMobileDrawerWidth(320, 390)).toBe(312);
  });

  it('rounds down fractional viewport caps for stable drag distances', () => {
    expect(resolveMobileDrawerWidth(320, 401)).toBe(320);
    expect(resolveMobileDrawerWidth(400, 401)).toBe(320);
  });
});

describe('hasActiveTextSelection', () => {
  it('treats expanded text input selections as active', () => {
    expect(
      hasActiveTextSelection(
        createFakeDocument({
          activeElement: {
            tagName: 'input',
            type: 'text',
            selectionStart: 1,
            selectionEnd: 4,
          },
        })
      )
    ).toBe(true);
  });

  it('treats non-collapsed document selections as active', () => {
    expect(
      hasActiveTextSelection(
        createFakeDocument({
          selection: {
            rangeCount: 1,
            isCollapsed: false,
          },
        })
      )
    ).toBe(true);
  });

  it('ignores collapsed selections', () => {
    expect(
      hasActiveTextSelection(
        createFakeDocument({
          activeElement: {
            tagName: 'textarea',
            selectionStart: 3,
            selectionEnd: 3,
          },
          selection: {
            rangeCount: 1,
            isCollapsed: true,
          },
        })
      )
    ).toBe(false);
  });
});

describe('shouldIgnoreSidebarSwipeGesture', () => {
  it('ignores gestures that start inside editable text controls', () => {
    const textarea: FakeElement = { tagName: 'textarea' };
    const child: FakeElement = { tagName: 'span', parentElement: textarea };

    expect(shouldIgnoreSidebarSwipeGesture(createFakeDocument({}), child as EventTarget)).toBe(
      true
    );
  });

  it('ignores gestures while page text is selected', () => {
    const target: FakeElement = { tagName: 'div' };

    expect(
      shouldIgnoreSidebarSwipeGesture(
        createFakeDocument({
          selection: {
            rangeCount: 1,
            isCollapsed: false,
          },
        }),
        target as EventTarget
      )
    ).toBe(true);
  });

  it('allows gestures when there is no active selection or editable target', () => {
    const target: FakeElement = { tagName: 'div' };

    expect(shouldIgnoreSidebarSwipeGesture(createFakeDocument({}), target as EventTarget)).toBe(
      false
    );
  });

  it('ignores gestures inside panels that disable sidebar swipe-open', () => {
    const panel: FakeElement = {
      tagName: 'div',
      dataset: { sidebarSwipeOpenDisabled: '' },
    };
    const child: FakeElement = { tagName: 'button', parentElement: panel };

    expect(shouldIgnoreSidebarSwipeGesture(createFakeDocument({}), child as EventTarget)).toBe(
      true
    );
  });
});
