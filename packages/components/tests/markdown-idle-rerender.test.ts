// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionMeta } from '@lody/shared';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';

const markdownRendererStats = vi.hoisted(() => ({
  renderCount: 0,
  callbacks: [] as Array<((href: string) => void) | undefined>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../src/components/ai-gui/markdown-renderer', async () => {
  const React = await import('react');
  type MarkdownRendererProps = Pick<
    ComponentProps<typeof import('../src/components/ai-gui/markdown-renderer').MarkdownRenderer>,
    'text' | 'onAgentFileLinkClick'
  >;

  return {
    MarkdownRenderer: React.memo(function MockMarkdownRenderer({
      text,
      onAgentFileLinkClick,
    }: MarkdownRendererProps) {
      markdownRendererStats.renderCount += 1;
      markdownRendererStats.callbacks.push(onAgentFileLinkClick);
      return React.createElement('div', { 'data-testid': 'markdown-renderer' }, text);
    }),
  };
});

// `MarkdownBlock` is the live memo boundary that renders assistant markdown
// (via `renderAssistantContent` inside the assistant virtual rows). It replaces
// the removed `AgentChatBubble` as the target for these idle-rerender guards.
import { MarkdownBlock } from '../src/components/ai-gui/view';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'idle-session-1' as SessionId;

const markdownText = [
  '### Long idle markdown',
  '',
  'This text stays identical while session metadata changes elsewhere.',
  '',
  '[Open file](packages/components/src/components/ai-gui/view.tsx)',
].join('\n');

describe('idle markdown rendering', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    markdownRendererStats.renderCount = 0;
    markdownRendererStats.callbacks = [];
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  const renderMarkdown = async (onFilePathClick: (filePath: string) => void): Promise<void> => {
    if (!root) {
      throw new Error('Expected test root to be initialized');
    }

    await act(async () => {
      root?.render(
        createElement(MarkdownBlock, {
          text: markdownText,
          onFilePathClick,
        })
      );
    });
  };

  it('does not rerender markdown when only the file-link callback identity changes', async () => {
    const firstOpen = vi.fn();
    const secondOpen = vi.fn();

    await renderMarkdown(firstOpen);
    expect(markdownRendererStats.renderCount).toBe(1);

    const stableFileLinkCallback = markdownRendererStats.callbacks[0];
    await renderMarkdown(secondOpen);

    expect(markdownRendererStats.renderCount).toBe(1);
    expect(stableFileLinkCallback).toBeDefined();

    // The stable callback always routes to the latest handler, so calling the
    // first render's callback invokes the second render's `onFilePathClick`.
    const rawFileHref =
      'workspace/lody/packages/components/src/components/ai-gui/view.tsx#L10';
    stableFileLinkCallback?.(rawFileHref);
    expect(firstOpen).not.toHaveBeenCalled();
    expect(secondOpen).toHaveBeenCalledWith(rawFileHref);
  });

  it('does not rerender markdown when only Code Collab session metadata changes', async () => {
    if (!root) {
      throw new Error('Expected test root to be initialized');
    }
    const store = createStore();
    const roomId = getSessionRoomId(sessionId);
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1',
      createdAt: '2026-05-20T00:00:00.000Z',
      userId: 'user-1',
      status: { type: 'idle' },
      cliType: 'builtin',
      agentType: 'codex',
    } as SessionMeta;

    store.set(sessionMetaCacheAtom, { [roomId]: sessionMeta });

    await act(async () => {
      root?.render(
        createElement(Provider, { store }, createElement(MarkdownBlock, { text: markdownText }))
      );
    });
    expect(markdownRendererStats.renderCount).toBe(1);

    await act(async () => {
      store.set(sessionMetaCacheAtom, {
        [roomId]: {
          ...sessionMeta,
          workspaceDirty: true,
        } as SessionMeta,
      });
    });

    // The assistant markdown subtree must not subscribe to session metadata, so
    // an unrelated Code Collab meta change leaves the memoized renderer untouched.
    expect(markdownRendererStats.renderCount).toBe(1);
  });
});
