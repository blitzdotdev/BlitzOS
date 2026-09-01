// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MobileInlineMenu } from '../src/components/mobile/mobile-inline-picker';

describe('MobileInlineMenu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  function renderMenu() {
    act(() => {
      root?.render(
        <MobileInlineMenu id="test-menu" ariaLabel="More actions" triggerContent="More">
          {() => (
            <div>
              <button type="button">First action</button>
              <button type="button">Second action</button>
            </div>
          )}
        </MobileInlineMenu>
      );
    });
  }

  it('owns keyboard navigation while open', () => {
    renderMenu();

    const trigger = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]'
    )!;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.focus();
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      );
    });

    expect(document.activeElement?.textContent).toBe('First action');

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      );
    });

    expect(document.activeElement?.textContent).toBe('Second action');

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
