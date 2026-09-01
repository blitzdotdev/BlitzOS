// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, useCommand, useKeyScope } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useCommand', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(window, {
      __LODY_ELECTRON__: true,
      __LODY_PLATFORM__: { os: 'linux' },
    });
    __resetPlatformCacheForTests();
    commands.attach(window);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    commands.detach();
    commands.unregister('session.closeFocusedTab');
    vi.unstubAllGlobals();
    delete window.__LODY_ELECTRON__;
    delete window.__LODY_PLATFORM__;
    __resetPlatformCacheForTests();
  });

  it('forwards allowInTextInput so tab commands work inside an editing scope', () => {
    const run = vi.fn();

    function Harness() {
      const editorRef = useRef<HTMLDivElement>(null);
      useKeyScope('test-editor', editorRef);
      useCommand({
        id: 'session.closeFocusedTab',
        title: 'Close Focused Tab',
        keybindings: ['$mod+w'],
        allowInTextInput: true,
        run,
      });
      return (
        <div ref={editorRef}>
          <textarea aria-label="Editor" />
        </div>
      );
    }

    act(() => root.render(<Harness />));
    const editor = container.querySelector('[aria-label="Editor"]');
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      editor?.dispatchEvent(event);
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
