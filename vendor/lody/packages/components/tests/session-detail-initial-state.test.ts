import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import { getSessionDetailInitialTabState } from '../src/lib/session-detail-initial-state';
import type { PersistedLastActiveTabState } from '../src/lib/session-draft-tabs';

const parentSessionId = 'parent-session' as SessionId;

const persistedProviderFileState: PersistedLastActiveTabState = {
  sessionTabId: 'child-session',
  viewerTab: {
    id: 'file:file-1',
    type: 'file',
    filePath: 'src/renamed.ts',
    fileId: 'file-1',
    label: 'renamed.ts',
    startLine: 4,
    endLine: 8,
    focusRequestSeq: 2,
  },
  sidePanel: {
    open: true,
    tab: 'browser',
    tabs: ['files', 'browser'],
    sideSessionId: 'side-session-1',
  },
};

describe('getSessionDetailInitialTabState', () => {
  it('restores the persisted session tab and provider file viewer state when the URL has no tab', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, undefined, {
        readPersistedState: () => persistedProviderFileState,
      })
    ).toEqual({
      activeTabSessionId: 'child-session',
      viewerTabs: [persistedProviderFileState.viewerTab],
      activeViewerTabId: 'file:file-1',
      sidePanel: {
        open: true,
        tab: 'browser',
        tabs: ['files', 'browser'],
        sideSessionId: 'side-session-1',
      },
    });
  });

  it('lets an explicit URL session tab override persisted viewer state', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, 'session:url-child', {
        readPersistedState: () => persistedProviderFileState,
      })
    ).toEqual({
      activeTabSessionId: 'url-child',
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: {
        open: false,
        tab: null,
        tabs: [],
        sideSessionId: null,
      },
    });
  });

  it('normalizes a URL tab pointing at the parent session and clears viewer state', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, 'session:parent-session', {
        readPersistedState: () => persistedProviderFileState,
      })
    ).toEqual({
      activeTabSessionId: parentSessionId,
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: {
        open: false,
        tab: null,
        tabs: [],
        sideSessionId: null,
      },
    });
  });

  it('treats invalid URL tab state as an explicit parent-session reset', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, 'file:src/index.ts', {
        readPersistedState: () => persistedProviderFileState,
      })
    ).toEqual({
      activeTabSessionId: parentSessionId,
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: {
        open: false,
        tab: null,
        tabs: [],
        sideSessionId: null,
      },
    });
  });

  it('defaults the side panel state when older persisted state has no side panel entry', () => {
    expect(
      getSessionDetailInitialTabState(parentSessionId, undefined, {
        readPersistedState: () => ({
          sessionTabId: 'child-session',
          viewerTab: null,
        }),
      })
    ).toEqual({
      activeTabSessionId: 'child-session',
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: {
        open: false,
        tab: null,
        tabs: [],
        sideSessionId: null,
      },
    });
  });
});
