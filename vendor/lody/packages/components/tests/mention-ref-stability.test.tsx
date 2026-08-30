// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Mention, MentionInput, MentionItem, useMentionContext } from '../src/ui/mention';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Mention ref stability', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

  beforeEach(() => {
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (
        globalThis as typeof globalThis & { requestAnimationFrame?: typeof requestAnimationFrame }
      ).requestAnimationFrame;
    }
    originalRequestAnimationFrame = undefined;
  });

  function renderMention(tick: number) {
    act(() => {
      root?.render(
        <Mention inputValue="@" defaultOpen>
          <MentionItem value="src/" label={`src-${tick}`}>
            src/
          </MentionItem>
          <MentionItem value="docs/" label="docs">
            docs/
          </MentionItem>
        </Mention>
      );
    });
  }

  it('does not re-enter updates when item rows mount and the parent rerenders', () => {
    renderMention(0);
    renderMention(1);
    renderMention(2);

    expect(container?.querySelectorAll('[data-slot="mention-item"]')).toHaveLength(2);
  });

  it('reuses the virtual anchor for repeated updates at the same trigger position', () => {
    const anchors: unknown[] = [];

    function VirtualAnchorProbe() {
      const context = useMentionContext('VirtualAnchorProbe');
      React.useEffect(() => {
        anchors.push(context.virtualAnchor);
      }, [context.virtualAnchor]);
      return null;
    }

    act(() => {
      root?.render(
        <Mention inputValue="@src" defaultOpen>
          <VirtualAnchorProbe />
          <MentionInput value="@src" onChange={() => {}} />
          <MentionItem value="src/" label="src">
            src/
          </MentionItem>
        </Mention>
      );
    });

    const input = container?.querySelector('textarea');
    if (!input) throw new Error('Expected mention textarea to render');

    act(() => {
      input.setSelectionRange(4, 4);
      input.focus();
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nonNullAnchors = anchors.filter(Boolean);
    expect(nonNullAnchors.length).toBeGreaterThan(0);
    expect(new Set(nonNullAnchors).size).toBe(1);
  });
});
