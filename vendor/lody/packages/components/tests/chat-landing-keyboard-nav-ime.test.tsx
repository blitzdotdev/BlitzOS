// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useChatLandingKeyboardNav } from '../src/hooks/use-chat-landing-keyboard-nav';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function KeyboardNavHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  useChatLandingKeyboardNav(rootRef, { enabled: true });

  return (
    <div ref={rootRef}>
      <textarea aria-label="Prompt" />
    </div>
  );
}

describe('chat landing keyboard navigation IME handling', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<KeyboardNavHarness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('does not blur the composer when Escape cancels IME composition', async () => {
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea?.focus();

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        })
      );
    });

    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(document.activeElement).not.toBe(textarea);
  });
});
