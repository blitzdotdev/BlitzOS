import type { SessionId } from '@lody/shared';
import {
  readStoredLastActiveTabState,
  type PersistedLastActiveTabState,
  type PersistedSidePanelState,
  type PersistedViewerTab,
} from './session-draft-tabs';
import { parseSessionTabSearch } from './session-tab-url';

const DEFAULT_SIDE_PANEL_STATE: PersistedSidePanelState = {
  open: false,
  tab: null,
  tabs: [],
  sideSessionId: null,
};

export type SessionDetailInitialTabState = {
  readonly activeTabSessionId: string;
  readonly viewerTabs: PersistedViewerTab[];
  readonly activeViewerTabId: string | null;
  readonly sidePanel: PersistedSidePanelState;
};

export type SessionDetailInitialTabStateOptions = {
  readonly readPersistedState?: (parentSessionId: SessionId) => PersistedLastActiveTabState | null;
};

export const getSessionDetailInitialTabState = (
  parentSessionId: SessionId,
  urlTab?: string,
  options: SessionDetailInitialTabStateOptions = {}
): SessionDetailInitialTabState => {
  const parsedUrlTab = parseSessionTabSearch(urlTab);
  if (parsedUrlTab.kind === 'session') {
    return {
      activeTabSessionId:
        parsedUrlTab.sessionId === parentSessionId ? parentSessionId : parsedUrlTab.sessionId,
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: DEFAULT_SIDE_PANEL_STATE,
    };
  }

  if (parsedUrlTab.kind === 'invalid') {
    return {
      activeTabSessionId: parentSessionId,
      viewerTabs: [],
      activeViewerTabId: null,
      sidePanel: DEFAULT_SIDE_PANEL_STATE,
    };
  }

  const persistedState =
    options.readPersistedState?.(parentSessionId) ?? readStoredLastActiveTabState(parentSessionId);
  const viewerTab = persistedState?.viewerTab ?? null;

  return {
    activeTabSessionId: persistedState?.sessionTabId ?? parentSessionId,
    viewerTabs: viewerTab ? [viewerTab] : [],
    activeViewerTabId: viewerTab?.id ?? null,
    sidePanel: persistedState?.sidePanel ?? DEFAULT_SIDE_PANEL_STATE,
  };
};
