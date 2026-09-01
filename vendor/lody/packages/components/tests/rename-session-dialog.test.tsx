// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';

import { SessionList } from '../src/components/session-list';
import { RenameSessionDialogView } from '../src/components/sessions/rename-session-dialog';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RenameSessionDialogView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    root = undefined;
    container = undefined;
  });

  it('focuses the title and ignores Enter while the IME is composing', async () => {
    const onRename = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <RenameSessionDialogView
          target={{
            sessionId: 'rename-session' as SessionId,
            initialTitle: 'Original title',
          }}
          onClose={onClose}
          onRename={onRename}
        />
      );
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea?.rows).toBe(1);
    expect(document.activeElement).toBe(textarea);
    const singleLineHeight = Number.parseFloat(textarea?.style.height ?? '0');

    await act(async () => {
      if (!textarea) return;
      Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 72 });
      setTextareaValue(textarea, 'Composed title');
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        })
      );
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(Number.parseFloat(textarea?.style.height ?? '0')).toBeGreaterThan(singleLineHeight);

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onRename).toHaveBeenCalledWith('rename-session', 'Composed title');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the shared Rename Chat dialog from a sidebar session title', async () => {
    const onRenameSession = vi.fn();

    await act(async () => {
      root?.render(
        <SessionList
          sessions={[
            {
              sessionId: 'sidebar-session',
              title: 'Sidebar title',
              repoFullName: null,
              branchName: '',
              latestMessageAt: 0,
              addedLines: 0,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
            },
          ]}
          repos={[]}
          onRenameSession={onRenameSession}
        />
      );
    });

    const title = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-sidebar-session-id] span') ?? []
    ).find((element) => element.textContent === 'Sidebar title');
    expect(title).toBeInstanceOf(HTMLElement);

    await act(async () => {
      title?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.value).toBe('Sidebar title');
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      if (!textarea) return;
      setTextareaValue(textarea, 'Renamed from sidebar');
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onRenameSession).toHaveBeenCalledWith('sidebar-session', 'Renamed from sidebar');
  });
});
