// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarUpdatedSessionList } from '../src/components/sidebar-updated-session-list';
import { SessionList } from '../src/components/session-list';
import { initI18n } from '../src/i18n';
import type { SessionSharingState } from '../src/lib/session-sharing';

const PRIVATE_SHARING: SessionSharingState = {
  visibility: 'private',
  privateReason: 'machine',
  canManage: true,
  machineId: null,
  localProjectId: null,
  machineName: null,
  projectName: null,
};

describe('sidebar share-only context menus', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
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

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function openContextMenu(row: Element | null) {
    expect(row).not.toBeNull();
    flushSync(() => {
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      );
    });
  }

  function getShareMenuItem() {
    return Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) =>
      node.textContent?.includes('Share with team')
    );
  }

  it('keeps the SessionList menu reachable when Share is its only action', () => {
    const onShareSessionWithTeam = vi.fn();

    flushSync(() => {
      root?.render(
        React.createElement(SessionList, {
          sessions: [
            {
              sessionId: 'task-list-session',
              title: 'Private conversation',
              repoFullName: 'loro-dev/lody',
              branchName: '',
              latestMessageAt: '2026-07-19T00:00:00.000Z',
              addedLines: 0,
              deletedLines: 0,
              isWorking: false,
              hasUnreadMessages: false,
              isOffline: false,
              isWaitingPermission: false,
              sharing: PRIVATE_SHARING,
            },
          ],
          repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
          onShareSessionWithTeam,
        })
      );
    });

    openContextMenu(container?.querySelector('[data-sidebar-session-id="task-list-session"]'));
    const shareItem = getShareMenuItem();
    expect(shareItem).not.toBeUndefined();

    flushSync(() => {
      shareItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onShareSessionWithTeam).toHaveBeenCalledWith('task-list-session');
  });

  it('keeps the Updated list menu reachable when Share is its only action', () => {
    const onShareItemWithTeam = vi.fn();

    flushSync(() => {
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          now: new Date('2026-07-19T01:00:00.000Z'),
          items: [
            {
              id: 'updated-session',
              kind: 'local',
              title: 'Private conversation',
              sectionLabel: 'Local Projects · lody',
              latestMessageAt: new Date('2026-07-19T00:00:00.000Z'),
              sharing: PRIVATE_SHARING,
            },
          ],
          onShareItemWithTeam,
        })
      );
    });

    openContextMenu(container?.querySelector('[data-sidebar-updated-id="updated-session"]'));
    const shareItem = getShareMenuItem();
    expect(shareItem).not.toBeUndefined();

    flushSync(() => {
      shareItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onShareItemWithTeam).toHaveBeenCalledWith('updated-session');
  });
});
