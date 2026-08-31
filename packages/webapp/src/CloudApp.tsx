import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createClient, type WebDAVClient } from 'webdav';
import {
  ApiAdapter,
  ApiError,
  type V2WorkspaceRecord,
} from './api-adapter';
import type { ControlPlaneClient } from './api';
import type { CredentialRequestView, FolderAttachmentView } from '@blitzos/schema';
import {
  SPAWN_SESSION_LABELS,
  type WebAppTabModel,
  type SpawnSessionType,
} from './WebAppHeader';
import { FileIcon } from './WebAppIcons';
import type { DriveRailSession } from './shell/rail-sessions';
import { ShareToDriveDialog } from './files/ShareToDriveDialog';
import type { CreateWorkspaceDialogInput } from './CreateWorkspaceDialog';
import { ConfirmationDialog } from './ConfirmationDialog';
import { SessionShareDialog } from './SessionShareDialog';
import { caughtErrorMessage } from './error-message';
import {
  WebAppLoadingPane,
  WebAppLoadingShell,
} from './LoadingSkeleton';
import { machineTypeLabel } from './MachineCatalogGrid';
import {
  bindVisualViewportGeometry,
  useMobileWebApp,
} from './mobile-webapp';
import { PasteCodeModal } from './shell/PasteCodeModal';
import { ShellDialogs, type WebAppConfirmation } from './shell/ShellDialogs';
import type { WorkspaceDetailsTab } from './WorkspaceDetailsDialog';
import { ShellNav } from './shell/ShellNav';
import { isSecondaryRoute, SecondaryRoutes } from './shell/SecondaryRoutes';
import { NewTabControl } from './shell/NewTabControl';
import { WorkPanes } from './shell/WorkPanes';
import { LodySessionsRegion } from './lody/LodySessionsRegion';
import { useLodyRail } from './lody/use-lody-rail';
import { useSharedSessions } from './lody/use-shared-sessions';
import type { LodySessionSurfaceApi } from './lody/SessionSurface';
import {
  drivePath,
  folderPagePath,
  parseAppRoute,
  settingsPath,
  workspacePath,
  type SettingsSection,
} from './sessions-page-state';
import {
  clampDrawerWidth,
  defaultWorkspaceFiles,
  isManagedWorkspaceTab,
  tabRegion,
  withPreviewTabPath,
  type StorageNamespace,
  type WorkspaceDrawerSegment,
  type WorkspaceRegion,
  type WorkspaceTab,
  type WorkspaceTabs,
} from './storage';
import {
  appendTab,
  closeFileTabsAtPath,
  closeTab as closePaneTab,
  filesHostRegion,
  moveTab,
  paneRegions,
  panelTab,
  regionActiveId,
  renameTab,
  showPanelTab,
  splitTab,
  togglePanelTab,
  withRegionActiveId,
} from './workspace-panes';
import { useWorkspaceTabDrag } from './use-workspace-tab-drag';
import { WorkspaceRailStrip } from './WorkspaceRailStrip';
import { TERMINAL_KEYBOARD_EVENT, TERMINAL_PASTE_EVENT } from './terminal-touch';
import { TERMINAL_SUBMIT_EVENT } from './TtydTerminal';
import { WorkspaceErrorState } from './WorkspaceErrorState';
import { FilesSidebar } from './FilesSidebar';
import { fullDavPath, isPathAtOrBelow } from './files';
import { dropPasteText, uploadDroppedFiles } from './file-drop';
import {
  initialWorkspaceStore,
  selectControllableWorkspaceId,
  workspaceReducer,
} from './workspace-store';
import {
  isPreviewPath,
  isPreviewPort,
  newestPorts,
  newestPreviewLinks,
  previewLinkLabel,
} from './preview';
import { decideUpdateAction, extractIndexAsset } from './update-check';
import { LoginForm } from './components/LoginForm';
import { CreateOrgPage } from './components/CreateOrgPage';
import type { IdentityRecord } from './protocol';
import { FILES_DAV_ROOT, type EndpointResolver } from './resolver';
import { type ConnectionsPanelFocus, WorkspaceDrawer } from './WorkspaceDrawer';
import {
  rememberWorkspaceEndpoints,
  type WorkspaceEndpoints,
} from './workspace-endpoints';
import { useWorkspacePersistence } from './use-workspace-persistence';
import {
  useWorkspaceBootstrap,
  useWorkspacePolling,
} from './use-workspace-lifecycle';
import { useWorkspacePreviewSources } from './use-workspace-preview-sources';
import { useWorkspaceConnectionsFocus } from './use-workspace-connections-focus';
import { useWorkspacePreviewFocus } from './use-workspace-preview-focus';

/** Shared empty list for a workspace whose tabs have not loaded. A fresh `[]`
 * per render would give every callback derived from it a new identity, and the
 * terminal touch controller rebinds on those identities. */
const NO_WORKSPACE_TABS: WorkspaceTab[] = [];
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1_000;
const UPDATE_RELOAD_MARKER_PREFIX = 'blitzos:update-reloaded:';

function updateReloaded(hash: string): boolean {
  try {
    return window.sessionStorage.getItem(`${UPDATE_RELOAD_MARKER_PREFIX}${hash}`) === '1';
  } catch {
    return true;
  }
}

function markUpdateReloaded(hash: string): boolean {
  try {
    window.sessionStorage.setItem(`${UPDATE_RELOAD_MARKER_PREFIX}${hash}`, '1');
    return true;
  } catch {
    return false;
  }
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1.75" y="2.75" width="16.5" height="14.5" rx="3" />
      <path d="m5.5 7 2.6 2.45L5.5 12M10.4 12h4.1" />
    </svg>
  );
}

export { terminalWebSocketUrl } from './workspace-endpoints';

type FileCloseConfirmation = {
  id: string;
  label: string;
};

const PANEL_LABELS = {
  files: 'Files',
  previews: 'teenyapps',
  connections: 'Connections',
} satisfies Record<WorkspaceDrawerSegment, string>;

export type CloudAppProps = {
  client: ControlPlaneClient;
  resolver: EndpointResolver;
};

export default function CloudApp({ client, resolver }: CloudAppProps) {
  const mobileWebApp = useMobileWebApp();
  const [store, dispatch] = useReducer(workspaceReducer, initialWorkspaceStore);
  const [route, setRoute] = useState(() => parseAppRoute(window.location.pathname));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => route.workspaceId ?? '');
  const [storageNamespace, setStorageNamespace] = useState<StorageNamespace | null>(null);
  const [identityOnly, setIdentityOnly] = useState<IdentityRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateAvailableHash, setUpdateAvailableHash] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  /** The workspace a "new workspace from existing" is copying, or null for a
   * blank create. Cleared with the dialog. */
  const [cloneFromWorkspaceId, setCloneFromWorkspaceId] = useState<string | null>(null);
  const [details, setDetails] = useState<
    { workspaceId: string; tab: WorkspaceDetailsTab; focusAddMember?: boolean } | null
  >(null);
  const [machineWorkspaceId, setMachineWorkspaceId] = useState<string | null>(null);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<WebAppConfirmation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  // The section the member last chose in the mobile sheet, or null while they
  // have chosen none and a persisted panel still speaks for them.
  const [mobileSegment, setMobileSegment] = useState<WorkspaceDrawerSegment | null>(null);
  const [terminalSignInUrl, setTerminalSignInUrl] = useState<string | null>(null);
  const [showPasteCodeModal, setShowPasteCodeModal] = useState(false);
  const [dirtyFileIds, setDirtyFileIds] = useState<Set<string>>(new Set());
  const [fileCloseConfirmation, setFileCloseConfirmation] = useState<FileCloseConfirmation | null>(null);
  const [filesRefreshVersion, setFilesRefreshVersion] = useState(0);
  const [workspaceAttachments, setWorkspaceAttachments] = useState<{
    workspaceId: string;
    folders: FolderAttachmentView[];
  }>({ workspaceId: '', folders: [] });
  const [attachmentsVersion, setAttachmentsVersion] = useState(0);
  const [shareToDrivePath, setShareToDrivePath] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<CredentialRequestView[]>([]);
  const [pendingRequestsError, setPendingRequestsError] = useState<string | null>(null);
  // The latest `blitz connections open` focus for the active workspace; a
  // fresh object per event so the panel re-selects on a repeat ask.
  const [connectionsFocus, setConnectionsFocus] = useState<ConnectionsPanelFocus | null>(null);
  // Which column the keyboard, statusline and rail follow. Not persisted: the
  // panes are, but the focus between them is a per-view detail.
  const [focusedRegion, setFocusedRegion] = useState<WorkspaceRegion>('main');
  const panesRef = useRef<HTMLDivElement>(null);
  // Mouse events on purpose: the drag must not depend on pointer capture, and
  // window listeners keep it alive over the terminal and the other pane.
  const [paneResizing, setPaneResizing] = useState(false);
  const endPaneResize = useRef<(() => void) | null>(null);
  useEffect(() => () => endPaneResize.current?.(), []);
  const shellRef = useRef<HTMLElement>(null);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const storeRef = useRef(store);
  const workspaceEndpoints = useRef(new Map<string, WorkspaceEndpoints>());
  const firstWorkspacePrompted = useRef(false);
  // Visit once, then retain: tab switches preserve live state without eagerly
  // opening every saved terminal and WebGL surface.
  const retainedSessionIdsRef = useRef<{ workspaceId: string; ids: Set<string> }>({
    workspaceId: '',
    ids: new Set(),
  });
  storeRef.current = store;

  useEffect(() => {
    if (!mobileWebApp || !shellRef.current) return;
    return bindVisualViewportGeometry(shellRef.current);
  }, [loaded, mobileWebApp]);

  useEffect(() => {
    if (!mobileWebApp) {
      setDrawerOpen(false);
      setFilesDrawerOpen(false);
    }
  }, [mobileWebApp]);

  useEffect(() => {
    setDrawerOpen(false);
    setFilesDrawerOpen(false);
  }, [route.page, route.workspaceId]);

  useEffect(() => {
    if (!mobileWebApp) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        setFilesDrawerOpen(false);
      }
    };
    let edgeStart: { x: number; y: number; pointerId: number } | null = null;
    const startEdgeSwipe = (event: PointerEvent) => {
      if (!drawerOpen && event.isPrimary && event.clientX <= 24) {
        edgeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      }
    };
    const finishEdgeSwipe = (event: PointerEvent) => {
      if (!edgeStart || edgeStart.pointerId !== event.pointerId) return;
      const horizontalTravel = event.clientX - edgeStart.x;
      const verticalTravel = Math.abs(event.clientY - edgeStart.y);
      edgeStart = null;
      if (horizontalTravel >= 48 && verticalTravel <= 40) setDrawerOpen(true);
    };
    const cancelEdgeSwipe = () => { edgeStart = null; };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', startEdgeSwipe, { passive: true });
    window.addEventListener('pointerup', finishEdgeSwipe, { passive: true });
    window.addEventListener('pointercancel', cancelEdgeSwipe, { passive: true });
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', startEdgeSwipe);
      window.removeEventListener('pointerup', finishEdgeSwipe);
      window.removeEventListener('pointercancel', cancelEdgeSwipe);
    };
  }, [drawerOpen, mobileWebApp]);

  const handleUnauthorized = useCallback(() => {
    setSignedOut(true);
    setLoaded(true);
  }, []);
  const api = useMemo(
    () => new ApiAdapter(client, handleUnauthorized),
    [client, handleUnauthorized],
  );
  const handlePersistenceError = useCallback((cause: Error) => {
    if (cause instanceof ApiError && cause.status === 401) return;
    setError(caughtErrorMessage(cause, 'Could not save webApp state.'));
  }, []);
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSignedOut(true);
    }
  }, [api]);
  const listMachineTypes = useCallback(() => api.listMachineTypes(), [api]);
  const refreshWorkspaceRecords = useCallback(async () => {
    try {
      const records = await api.listWorkspaces();
      rememberWorkspaceEndpoints(workspaceEndpoints.current, records, resolver, true);
      dispatch({ type: 'workspace_records_refreshed', records });
    } catch (refreshError) {
      if (!(refreshError instanceof ApiError && refreshError.status === 401)) {
        console.warn('Unable to refresh workspace status', refreshError);
      }
    }
  }, [api, resolver]);

  const activeWorkspace = useMemo(
    () => store.workspaces.find(({ id, canControl }) => id === activeWorkspaceId && canControl),
    [activeWorkspaceId, store.workspaces],
  );
  const persistenceMetadata = useMemo(() => activeWorkspace === undefined
    ? null
    : {
        title: activeWorkspace.title,
        serverName: activeWorkspace.serverName,
        agentDefault: activeWorkspace.agentDefault,
        canWrite: activeWorkspace.accessRole !== 'viewer',
      }, [activeWorkspace]);
  const {
    workspaceTabs,
    setWorkspaceTabs,
    workspaceFiles,
    setWorkspaceFiles,
  } = useWorkspacePersistence(
    api,
    storageNamespace !== null,
    activeWorkspaceId,
    persistenceMetadata,
    handlePersistenceError,
  );
  const activeIngressEntry = activeWorkspace
    ? workspaceEndpoints.current.get(activeWorkspace.id) ?? null
    : null;
  const activeWorkspaceRunning = activeWorkspace?.lifecycleStatus === 'running';
  const activeSessionUrl = activeWorkspaceRunning
    ? activeIngressEntry?.terminalUrl ?? null
    : null;
  const activeFilesBase = activeWorkspaceRunning ? activeIngressEntry?.filesBase ?? null : null;
  const activeFiles = workspaceFiles.workspaceId === activeWorkspaceId
    ? workspaceFiles.value
    : defaultWorkspaceFiles();
  const activeWorkspaceTabs = workspaceTabs.workspaceId === activeWorkspaceId
    && workspaceTabs.loaded
    ? workspaceTabs.value
    : null;
  // Below the mobile breakpoint the panes never split: the workspace keeps one
  // tab strip and the panels stay an off-canvas sheet.
  const splitEnabled = !mobileWebApp;
  const openPanels = new Set(
    (activeWorkspaceTabs?.tabs ?? []).flatMap(
      (tab) => (tab.type === 'panel' ? [tab.panel] : []),
    ),
  );
  const sidePanelTab = activeWorkspaceTabs === null
    ? null
    : activeWorkspaceTabs.tabs.find(
        (tab) => tab.type === 'panel' && tab.id === regionActiveId(activeWorkspaceTabs, 'side'),
      ) ?? null;
  // The sheet needs a selected segment even before its panel tab exists.
  //
  const storedSegment: WorkspaceDrawerSegment = sidePanelTab?.type === 'panel'
    ? sidePanelTab.panel
    : 'files';
  // On mobile a tap cannot go through the tab model. A panel tab that would be
  // the only tab collapses into `main` (normalizedWorkspaceTabs refuses a side
  // pane with an empty main), which leaves `sideActiveId` undefined, and the
  // mobile strip hides panel tabs anyway — so the sheet read Files forever and
  // its Connections and teenyapps tabs did nothing.
  //
  // A tap is an override, not a replacement: until one happens a panel the
  // member left open still opens the sheet on its own section.
  const drawerSegment: WorkspaceDrawerSegment = mobileWebApp
    ? mobileSegment ?? storedSegment
    : storedSegment;
  const filesTab = activeWorkspaceTabs === null
    ? null
    : panelTab(activeWorkspaceTabs, 'files');
  const filesOpen = mobileWebApp ? filesDrawerOpen : filesTab !== null;
  const filesSegmentVisible = mobileWebApp
    ? filesDrawerOpen && drawerSegment === 'files'
    : activeWorkspaceTabs !== null
      && filesTab !== null
      && regionActiveId(activeWorkspaceTabs, tabRegion(filesTab)) === filesTab.id;
  const { livePorts, previewLinks } = useWorkspacePreviewSources(
    route.page === 'webApp' && activeWorkspaceRunning,
    activeWorkspaceId,
    activeFilesBase,
  );
  // The in-box agent's `blitz preview open` raises a focus marker; open it as a
  // tab so the user never hunts for the preview. `openPreviewPort` is defined
  // below and only referenced when a focus arrives (after render), so its
  // temporal position is fine. The pre-split drawer-segment nudge is gone:
  // panels are tabs now, and forcing one open would steal the pane.
  useWorkspacePreviewFocus(
    route.page === 'webApp' && activeWorkspaceRunning,
    activeWorkspaceId,
    activeFilesBase,
    (focus) => {
      openPreviewPort(focus.port, focus.path);
    },
  );

  // The in-box agent's `blitz connections open <provider>` raises the other
  // focus: open the connections panel and point at the provider, so the
  // person lands exactly where the agent sent them to authorize. Same
  // temporal-position note as above for the setters referenced below.
  useWorkspaceConnectionsFocus(
    route.page === 'webApp' && activeWorkspaceRunning,
    activeWorkspaceId,
    activeFilesBase,
    (focus) => {
      // The marker's own `requestedAt`, not `Date.now()`: the panel re-selects
      // on a fresh `at`, and a focus replayed from the box must carry the time
      // the box raised it.
      setConnectionsFocus({ provider: focus.provider, at: focus.requestedAt });
      if (mobileWebApp) setFilesDrawerOpen(true);
      updateWorkspaceTabs((tabs) => showPanelTab(tabs, 'connections'));
      if (!mobileWebApp) setFocusedRegion('side');
    },
  );

  // A focus belongs to the workspace whose box raised it; a switch drops it
  // rather than highlighting the same provider name somewhere else.
  useEffect(() => {
    setConnectionsFocus(null);
  }, [activeWorkspaceId]);

  // Drive attachments feed the files view (shared pin count, context-menu
  // "Open in Drive"); refetched on workspace switch and after a share.
  useEffect(() => {
    if (activeWorkspaceId === '' || !filesSegmentVisible) return;
    let active = true;
    void client.listWorkspaceFolders(activeWorkspaceId).then(
      ({ folders }) => {
        if (active) setWorkspaceAttachments({ workspaceId: activeWorkspaceId, folders });
      },
      () => undefined,
    );
    return () => { active = false; };
  }, [activeWorkspaceId, client, filesSegmentVisible, attachmentsVersion]);

  useEffect(() => {
    if (route.page !== 'webApp' || !activeWorkspaceId || signedOut) {
      setPendingRequests([]);
      setPendingRequestsError(null);
      return;
    }
    let disposed = false;
    let request: AbortController | null = null;
    const poll = async () => {
      if (request || document.visibilityState !== 'visible') return;
      request = new AbortController();
      const current = request;
      try {
        const response = await client.listCredentialRequests(current.signal, 'pending');
        if (!disposed && request === current && !current.signal.aborted) {
          setPendingRequests(response.requests);
          setPendingRequestsError(null);
        }
      } catch (caught) {
        if (!disposed && request === current && !current.signal.aborted) {
          setPendingRequestsError(caughtErrorMessage(caught, 'The control plane request failed.'));
        }
      } finally {
        if (request === current) request = null;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, filesOpen ? 5_000 : 15_000);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
    };
  }, [activeWorkspaceId, client, filesOpen, route.page, signedOut]);

  const filesClient = useMemo<WebDAVClient | null>(() => {
    if (!activeFilesBase) return null;
    return createClient(activeFilesBase, { withCredentials: true, remoteBasePath: FILES_DAV_ROOT });
  }, [activeFilesBase]);
  const getFilesClient = useCallback((): WebDAVClient | null => {
    const workspaceId = activeWorkspaceIdRef.current;
    const workspace = storeRef.current.workspaces.find(({ id }) => id === workspaceId);
    const filesBase = workspaceEndpoints.current.get(workspaceId)?.filesBase;
    if (workspace?.lifecycleStatus !== 'running' || !filesBase) return null;
    return createClient(filesBase, { withCredentials: true, remoteBasePath: FILES_DAV_ROOT });
  }, []);
  const [dropActive, setDropActive] = useState(false);
  const [dropBusy, setDropBusy] = useState(false);
  // Drop a screenshot on a tab and its path lands in the TUI. Upload reuses the
  // workspace's dufs WebDAV server; the paste reuses TERMINAL_SUBMIT_EVENT with
  // enters: 0, so the path is typed and the user still decides when to send.
  const handleFilesDropped = useCallback(async (files: readonly File[]) => {
    if (filesClient === null || files.length === 0) return;
    setDropBusy(true);
    try {
      const result = await uploadDroppedFiles({
        exists: (path) => filesClient.exists(path),
        putFileContents: (path, data) => filesClient.putFileContents(path, data),
      }, files);
      if (result.failed.length > 0) {
        setError(
          `Could not upload ${result.failed.map((f) => `“${f.name}”`).join(', ')}: `
            + result.failed[0]!.error,
        );
      }
      const text = dropPasteText(result.uploaded);
      if (text) {
        window.dispatchEvent(
          new CustomEvent(TERMINAL_SUBMIT_EVENT, { detail: { data: text, enters: 0 } }),
        );
      }
    } finally {
      setDropBusy(false);
    }
  }, [filesClient]);
  useWorkspaceBootstrap({
    api,
    bootstrapVersion,
    signedOut,
    resolver,
    workspaceEndpoints,
    activeWorkspaceIdRef,
    setActiveWorkspaceId,
    setStorageNamespace,
    setIdentityOnly,
    dispatch,
    setLoaded,
    setError,
  });

  useEffect(() => {
    if (!store.viewer) return;
    let active = true;
    let checking = false;
    let pendingRefocus = false;

    const checkForUpdate = async (check: 'interval' | 'refocus') => {
      if (checking) {
        if (check === 'refocus') pendingRefocus = true;
        return;
      }
      checking = true;
      try {
        const response = await fetch('/', { cache: 'no-store' });
        if (
          !response.ok
          || !response.headers.get('content-type')?.toLowerCase().includes('text/html')
        ) return;
        const target = extractIndexAsset(await response.text());
        if (!active || !target) return;
        const runningSource = [...document.querySelectorAll('script[src], link[href]')]
          .map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? '')
          .find((source) => extractIndexAsset(source, target.extension));
        const current = runningSource
          ? extractIndexAsset(runningSource, target.extension)
          : null;
        const action = decideUpdateAction({
          check,
          currentHash: current?.hash ?? null,
          targetHash: target.hash,
          visible: document.visibilityState === 'visible',
          targetAlreadyReloaded: updateReloaded(target.hash),
        });
        if (action === 'toast') {
          setUpdateAvailableHash(target.hash);
        } else if (action === 'reload') {
          if (markUpdateReloaded(target.hash)) window.location.reload();
          else setUpdateAvailableHash(target.hash);
        }
      } catch {
        // Offline and transient update-check failures leave the webapp untouched.
      } finally {
        checking = false;
        if (active && pendingRefocus) {
          pendingRefocus = false;
          void checkForUpdate('refocus');
        }
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkForUpdate('refocus');
    };
    const interval = window.setInterval(
      () => { void checkForUpdate('interval'); },
      UPDATE_CHECK_INTERVAL_MS,
    );
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [store.viewer]);

  useEffect(() => {
    if (!loaded || signedOut) return;
    const nextId = selectControllableWorkspaceId(store.workspaces, activeWorkspaceIdRef.current);
    if (nextId === activeWorkspaceIdRef.current) return;
    activeWorkspaceIdRef.current = nextId;
    setActiveWorkspaceId(nextId);
  }, [loaded, store.workspaces]);

  useEffect(() => {
    const createWorkspaceRoute = window.location.pathname === '/workspaces/new';
    if (
      !loaded
      || !store.viewer
      || (!createWorkspaceRoute && store.workspaces.length > 0)
      || route.page === 'settings'
      || firstWorkspacePrompted.current
    ) return;
    firstWorkspacePrompted.current = true;
    setShowCreateWorkspace(true);
  }, [loaded, route.page, store.viewer, store.workspaces.length]);

  useEffect(() => {
    const handlePopState = () => {
      const restored = parseAppRoute(window.location.pathname);
      setRoute(restored);
      if (
        restored.workspaceId
        && storeRef.current.workspaces.some(({ id, canControl }) => id === restored.workspaceId && canControl)
      ) {
        activeWorkspaceIdRef.current = restored.workspaceId;
        setActiveWorkspaceId(restored.workspaceId);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const transitioningWorkspaceCount = store.workspaces.filter(
    ({ lifecycleStatus }) => (
      lifecycleStatus === 'creating'
      || lifecycleStatus === 'provisioning'
      || lifecycleStatus === 'parking'
      || lifecycleStatus === 'resuming'
    ),
  ).length;

  useWorkspacePolling({
    loaded,
    signedOut,
    transitioningWorkspaceCount,
    refreshWorkspaceRecords,
  });

  useEffect(() => {
    if (!loaded || !storageNamespace) return;
    const timer = window.setTimeout(() => {
      void api.putGlobalWebAppState({
        version: 1,
        activeWorkspaceId,
        order: store.workspaces.map(({ id }) => id),
      }).catch(handlePersistenceError);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activeWorkspaceId, api, handlePersistenceError, loaded, storageNamespace, store.workspaces]);

  const navigateToWorkspacePage = useCallback((workspaceId: string) => {
    window.history.pushState({}, '', workspacePath(workspaceId));
    setRoute({ workspaceId, page: 'webApp', chat: null });
  }, []);

  const navigateTo = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(parseAppRoute(path));
  }, []);

  const navigateToSettings = useCallback((section: SettingsSection) => {
    window.history.pushState({}, '', settingsPath(section));
    setRoute({ workspaceId: null, page: 'settings', settingsSection: section });
  }, []);

  const returnToWebApp = useCallback(() => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (workspaceId && storeRef.current.workspaces.some(({ id, canControl }) => id === workspaceId && canControl)) {
      navigateToWorkspacePage(workspaceId);
      return;
    }
    window.history.pushState({}, '', '/');
    setRoute({ workspaceId: null, page: 'drive' });
  }, [navigateToWorkspacePage]);

  const deleteWorkspace = useCallback((workspaceId: string) => {
    const workspaceIndex = storeRef.current.workspaces.findIndex(
      ({ id }) => id === workspaceId,
    );
    if (workspaceIndex < 0) return;
    const workspace = storeRef.current.workspaces[workspaceIndex];
    if (!workspace) return;
    setError(null);
    dispatch({ type: 'workspace_deleted', workspaceId });
    const remaining = storeRef.current.workspaces.filter(({ id }) => id !== workspaceId);
    if (remaining.length === 0) firstWorkspacePrompted.current = true;
    if (activeWorkspaceIdRef.current === workspaceId) {
      const nextId = selectControllableWorkspaceId(remaining, '');
      activeWorkspaceIdRef.current = nextId;
      setActiveWorkspaceId(nextId);
      if (nextId) navigateToWorkspacePage(nextId);
      else {
        window.history.pushState({}, '', '/');
        setRoute({ workspaceId: null, page: 'drive' });
      }
    }
    void api.deleteWorkspace(workspaceId)
      .then(() => {
        workspaceEndpoints.current.delete(workspaceId);
      })
      .catch((cause: unknown) => {
        dispatch({
          type: 'workspace_delete_rolled_back',
          workspace,
          index: workspaceIndex,
        });
        setError(`Could not delete “${workspace.title}”: ${caughtErrorMessage(cause, 'The control plane request failed.')}`);
      });
  }, [api, navigateToWorkspacePage]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    if (!store.workspaces.some(({ id, canControl }) => id === workspaceId && canControl)) return;
    if (workspaceId === activeWorkspaceIdRef.current) {
      navigateToWorkspacePage(workspaceId);
      return;
    }
    activeWorkspaceIdRef.current = workspaceId;
    setActiveWorkspaceId(workspaceId);
    navigateToWorkspacePage(workspaceId);
  }, [navigateToWorkspacePage, store.workspaces]);

  // One tail for everything that mints a workspace: the create dialog and
  // recipe launches both adopt the record and navigate to it the same way.
  const adoptCreatedWorkspace = useCallback(async (
    create: () => Promise<V2WorkspaceRecord>,
  ) => {
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const record = await create();
      rememberWorkspaceEndpoints(workspaceEndpoints.current, [record], resolver);
      dispatch({ type: 'workspace_created', record, agentDefault: 'claude' });
      if (record.canControl) {
        activeWorkspaceIdRef.current = record.id;
        setActiveWorkspaceId(record.id);
        navigateToWorkspacePage(record.id);
      }
      setShowCreateWorkspace(false);
    } catch (createFailure) {
      setCreateWorkspaceError(caughtErrorMessage(createFailure, 'The control plane request failed.'));
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [navigateToWorkspacePage, resolver]);
  const createWorkspace = useCallback(
    (input: CreateWorkspaceDialogInput) => adoptCreatedWorkspace(() => api.createWorkspace(input)),
    [adoptCreatedWorkspace, api],
  );
  // A recipe launch has no caller while the recipes surface is disabled; the
  // adapter keeps `launchRecipe`, so restoring the surface restores the flow.

  const setSidePaneWidth = useCallback((width: number) => {
    setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
      ? { ...current, value: { ...current.value, width } }
      : current);
  }, [activeWorkspaceId, setWorkspaceFiles]);

  const updateWorkspaceTabs = useCallback((update: (tabs: WorkspaceTabs) => WorkspaceTabs) => {
    setWorkspaceTabs((current) => {
      if (current.workspaceId !== activeWorkspaceId || !current.loaded) return current;
      const value = update(current.value);
      return value === current.value ? current : { ...current, value };
    });
  }, [activeWorkspaceId, setWorkspaceTabs]);

  const toggleFiles = useCallback(() => {
    if (!activeWorkspaceId) return;
    if (mobileWebApp) {
      setDrawerOpen(false);
      setFilesDrawerOpen((open) => !open);
      return;
    }
    updateWorkspaceTabs((tabs) => togglePanelTab(tabs, 'files'));
  }, [activeWorkspaceId, mobileWebApp, updateWorkspaceTabs]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === 'b') {
        if (!activeWorkspaceId) return;
        event.preventDefault();
        toggleFiles();
      } else if (!event.shiftKey && key === 'n') {
        event.preventDefault();
        setShowCreateWorkspace(true);
      } else if (!event.shiftKey && /^[1-9]$/.test(key)) {
        const workspace = store.workspaces.filter(({ canControl }) => canControl)[Number(key) - 1];
        if (workspace) {
          event.preventDefault();
          selectWorkspace(workspace.id);
        }
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeWorkspaceId, selectWorkspace, store.workspaces, toggleFiles]);

  const requestDeleteWorkspace = useCallback((workspaceId: string) => {
    const workspace = storeRef.current.workspaces.find(({ id }) => id === workspaceId);
    if (!workspace?.canControl) return;
    setConfirmation({
      workspaceId,
      label: workspace.title,
    });
  }, []);

  /** The tile's inline rename. The name is the workspace's own settings field,
   * so it goes through the same PATCH the settings tab writes; the tile shows
   * the new name at once and the next poll agrees. */
  const renameWorkspace = useCallback((workspaceId: string, name: string) => {
    dispatch({ type: 'workspace_renamed', workspaceId, title: name });
    void client.updateWorkspace(workspaceId, { name })
      .catch((caught: Error) => setError(caught.message));
  }, [client]);

  const retryWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = storeRef.current.workspaces.find(({ id }) => id === workspaceId);
    if (workspace?.retryAction === 'destroy') {
      requestDeleteWorkspace(workspaceId);
      return;
    }
    if (workspace?.retryAction === 'create') {
      setShowCreateWorkspace(true);
      return;
    }
    await refreshWorkspaceRecords();
  }, [refreshWorkspaceRecords, requestDeleteWorkspace]);

  const cancelConfirmation = useCallback(() => {
    setConfirmation(null);
  }, []);

  const confirmWebAppAction = useCallback(() => {
    if (!confirmation) return;
    const request = confirmation;
    setConfirmation(null);
    setDetails((current) => current?.workspaceId === request.workspaceId ? null : current);
    deleteWorkspace(request.workspaceId);
  }, [confirmation, deleteWorkspace]);

  const dispatchTerminalKeyboard = () => {
    window.dispatchEvent(new CustomEvent(TERMINAL_KEYBOARD_EVENT));
  };
  const dispatchTerminalPaste = () => {
    window.dispatchEvent(new CustomEvent(TERMINAL_PASTE_EVENT));
  };
  const dispatchTerminalEnter = () => {
    window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
      detail: { data: '\r', enters: 0 },
    }));
  };

  useEffect(() => {
    setDirtyFileIds(new Set());
    setFileCloseConfirmation(null);
    setFilesRefreshVersion(0);
  }, [activeWorkspaceId]);
  useEffect(() => {
    if (dirtyFileIds.size === 0) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirtyFileIds.size]);
  const ttydSessions = activeWorkspaceTabs?.tabs ?? NO_WORKSPACE_TABS;
  // The pane a tab is drawn in. Mobile has one column, so a tab parked in the
  // side pane on a desktop still shows up in the single strip there.
  const surfaceRegion = useCallback((session: WorkspaceTab): WorkspaceRegion => (
    splitEnabled ? tabRegion(session) : 'main'
  ), [splitEnabled]);
  const visibleRegions: WorkspaceRegion[] = splitEnabled && activeWorkspaceTabs !== null
    ? paneRegions(activeWorkspaceTabs)
    : ['main'];
  const mainActiveId = activeWorkspaceTabs === null
    ? null
    : regionActiveId(activeWorkspaceTabs, 'main');
  const sideActiveId = activeWorkspaceTabs === null
    ? null
    : regionActiveId(activeWorkspaceTabs, 'side');
  // The focused session drives the statusline and terminal keyboard events.
  // Mobile skips panel tabs: those live in the sheet, not the strip.
  const focusedSessionId = (() => {
    const preferred = focusedRegion === 'side' ? sideActiveId : mainActiveId;
    for (const candidate of [preferred, mainActiveId, sideActiveId]) {
      if (candidate === null) continue;
      const session = ttydSessions.find((entry) => entry.id === candidate);
      if (session === undefined) continue;
      if (!splitEnabled && session.type === 'panel') continue;
      return String(candidate);
    }
    return null;
  })();
  const ttydActiveId = focusedSessionId;
  const paneActiveId = (region: WorkspaceRegion): string | null => {
    if (!splitEnabled) return focusedSessionId;
    const id = region === 'main' ? mainActiveId : sideActiveId;
    return id === null ? null : String(id);
  };
  useEffect(() => {
    if (retainedSessionIdsRef.current.workspaceId !== activeWorkspaceId) {
      retainedSessionIdsRef.current = { workspaceId: activeWorkspaceId, ids: new Set() };
    }
    // Both panes show a tab at once, so both of their active tabs are visited.
    for (const id of [mainActiveId, sideActiveId]) {
      if (id !== null) retainedSessionIdsRef.current.ids.add(String(id));
    }
  }, [activeWorkspaceId, mainActiveId, sideActiveId]);
  const tabsLoaded = activeWorkspaceTabs !== null;
  // Lody sessions (plans/LODY-SESSIONS.md §8). The hook owns the rail's portal
  // host, the chat address and the fresh-workspace default; with the flag off
  // every field is inert and the rail keeps its native list.
  const lodyRail = useLodyRail(
    route,
    setRoute,
    activeWorkspaceId,
    tabsLoaded,
    activeWorkspaceTabs?.tabs.length ?? 0,
  );
  const [lodyApi, setLodyApi] = useState<LodySessionSurfaceApi | null>(null);
  // Which session the share dialog is open on. One piece of state, because the
  // dialog reads and writes its own grants (plans/LODY-SHARING.md §8).
  const [sharingSessionId, setSharingSessionId] = useState<string | null>(null);
  // Bumped when the share dialog closes, so a grant the viewer just received
  // from themselves — an admin granting on somebody's behalf — reaches the rail
  // without a reload.
  const [shareRevision, setShareRevision] = useState(0);
  // The OTHER half of sharing: what other members shared with this one, and
  // which of those the address has open (plans/LODY-SHARING.md §10.2).
  const sharedSessions = useSharedSessions({
    client,
    // The wire record rather than the store model: the resolver builds URLs
    // from a `WorkspaceView`, and this is the one place that view is kept.
    workspace: activeIngressEntry?.wire ?? null,
    resolver,
    chat: lodyRail.chat,
    revision: shareRevision,
  });
  // The ADDRESS drives the surface, one way: a deep link, a reload and the back
  // button all arrive here, and the surface's own navigations come back through
  // `onActiveSessionChange` below. Both compare before acting, so the pair
  // converges instead of looping.
  useEffect(() => {
    if (lodyApi === null || !lodyRail.visible) return;
    if (lodyRail.sessionId === lodyApi.activeSessionId()) return;
    if (lodyRail.sessionId === null) lodyApi.openLanding();
    else lodyApi.openSession(lodyRail.sessionId);
  }, [lodyApi, lodyRail.sessionId, lodyRail.visible]);
  const ttydLabel = (session: WorkspaceTab) => session.type === 'file'
    ? session.filePath
    : session.type === 'panel'
      ? PANEL_LABELS[session.panel]
      : session.type === 'preview'
        ? 'port' in session
          ? `:${session.port}`
          : previewLinkLabel(session.url, session.title)
        : (
          session.type === 'claude'
          || session.type === 'codex'
          || session.type === 'terminal'
            ? session.title ?? SPAWN_SESSION_LABELS[session.type]
            : session.type
        );
  const ttydTabs = useMemo<WebAppTabModel[]>(() => {
    const basenameCounts = new Map<string, number>();
    for (const session of ttydSessions) {
      if (session.type !== 'file') continue;
      const basename = session.filePath.split('/').at(-1) ?? session.filePath;
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
    }
    return ttydSessions.map((session) => {
      if (session.type === 'panel') {
        return {
          id: String(session.id),
          label: PANEL_LABELS[session.panel],
          agent: 'panel',
          panel: session.panel,
          pending: false,
        };
      }
      if (session.type !== 'file') {
        const tab: WebAppTabModel = {
          id: String(session.id),
          label: ttydLabel(session),
          agent: session.type,
          pending: false,
        };
        if (isManagedWorkspaceTab(session)) {
          tab.customTitle = session.title;
          tab.renameable = true;
        }
        return tab;
      }
      const parts = session.filePath.split('/');
      const basename = parts.at(-1) ?? session.filePath;
      const parent = parts.length > 1 ? parts.at(-2) : '~';
      return {
        id: String(session.id),
        label: basenameCounts.get(basename) === 1 ? basename : `${basename} ·${parent}`,
        agent: 'file',
        pending: false,
        dirty: dirtyFileIds.has(String(session.id)),
        filePath: session.filePath,
        title: fullDavPath(session.filePath),
      };
    });
  }, [dirtyFileIds, ttydSessions]);
  const railSessions = useMemo<DriveRailSession[]>(() => ttydTabs
    .filter((tab) => tab.agent !== 'panel' && tab.agent !== 'file' && tab.agent !== 'preview')
    .map((tab) => {
      const session: DriveRailSession = {
        id: tab.id,
        label: tab.label,
        agent: tab.agent,
      };
      if (tab.filePath !== undefined) session.filePath = tab.filePath;
      return session;
    }), [ttydTabs]);
  const railActiveSessionId = (() => {
    const railIds = new Set(railSessions.map(({ id }) => id));
    if (ttydActiveId !== null && railIds.has(ttydActiveId)) return ttydActiveId;
    // Files, previews and utility panels are not rail sessions. When one has
    // focus, keep the agent-like session still visible in the other pane
    // highlighted instead of making the rail appear to have no active item.
    const fallback = focusedRegion === 'side'
      ? [mainActiveId, sideActiveId]
      : [sideActiveId, mainActiveId];
    for (const id of fallback) {
      if (id !== null && railIds.has(String(id))) return String(id);
    }
    return null;
  })();
  const canEditWorkspaceLayout = activeWorkspace?.accessRole !== 'viewer';
  /** Tab models for one column, in the order that column draws them. */
  const paneTabModels = (region: WorkspaceRegion): WebAppTabModel[] => ttydTabs.filter(
    (tab, index) => {
      const session = ttydSessions[index];
      if (session === undefined) return false;
      if (!splitEnabled && session.type === 'panel') return false;
      return surfaceRegion(session) === region;
    },
  );
  const ttydActiveSession = ttydSessions.find(
    (session) => String(session.id) === ttydActiveId,
  ) ?? null;
  const ttydActiveType = ttydActiveSession?.type ?? null;
  const ttydActiveTerminalType = ttydActiveType === 'claude'
    || ttydActiveType === 'codex'
    || ttydActiveType === 'opencode'
    || ttydActiveType === 'pi'
    || ttydActiveType === 'kimi'
    || ttydActiveType === 'prime'
    || ttydActiveType === 'terminal'
    ? ttydActiveType
    : null;
  const closeChat = lodyRail.closeChat;
  const addWorkspaceTab = useCallback((
    createTab: (id: number) => WorkspaceTab,
    region: WorkspaceRegion = 'main',
  ) => {
    updateWorkspaceTabs((tabs) => appendTab(tabs, region, createTab));
    setFocusedRegion(region);
    // A new tab is a request for the panes, so the chat surface steps aside.
    closeChat();
  }, [closeChat, updateWorkspaceTabs]);
  const spawnTtydSession = (type: SpawnSessionType) => {
    addWorkspaceTab((id) => ({ id, type }));
  };
  const selectTtydSession = useCallback((id: string) => {
    const session = ttydSessions.find((tab) => String(tab.id) === id);
    if (session === undefined) return;
    setFocusedRegion(surfaceRegion(session));
    updateWorkspaceTabs((tabs) => withRegionActiveId(tabs, tabRegion(session), session.id));
    closeChat();
  }, [activeWorkspaceId, closeChat, surfaceRegion, ttydSessions, updateWorkspaceTabs]);
  const openFile = (filePath: string) => {
    const existing = ttydSessions.find(
      (session) => session.type === 'file' && session.filePath === filePath,
    );
    if (existing) {
      selectTtydSession(String(existing.id));
    } else {
      // Files opens files beside itself. Deliberately unlike IntelliJ: the
      // tree and what it opens stay in one column.
      const region = splitEnabled && activeWorkspaceTabs !== null
        ? filesHostRegion(activeWorkspaceTabs)
        : 'main';
      addWorkspaceTab((id) => ({ id, type: 'file', filePath }), region);
    }
    if (mobileWebApp) setFilesDrawerOpen(false);
  };
  const retargetPreviewTab = useCallback((tabId: number, path: string | undefined) => {
    setWorkspaceTabs((current) => {
      if (current.workspaceId !== activeWorkspaceId || !current.loaded) return current;
      const tabs = withPreviewTabPath(current.value.tabs, tabId, path);
      return tabs === current.value.tabs
        ? current
        : { ...current, value: { ...current.value, tabs } };
    });
  }, [activeWorkspaceId, setWorkspaceTabs]);
  const orderedLivePorts = useMemo(() => newestPorts(livePorts), [livePorts]);
  const orderedPreviewLinks = useMemo(
    () => newestPreviewLinks(previewLinks),
    [previewLinks],
  );
  // Handed straight to every terminal pane as `onOpenPreview`, and that prop
  // feeds the touch controller's bindings. A fresh arrow per render rebound the
  // controller constantly, and a paste landing in a rebind window was eaten.
  const openPreviewPort = useCallback((port: number, path?: string) => {
    if (!isPreviewPort(port)) return false;
    // Only a non-root, usable deep-link is recorded, so plain port opens keep
    // the bare { id, type, port } tab shape (and its persisted round-trip).
    const deepLink = path !== undefined && path !== '/' && isPreviewPath(path)
      ? path
      : undefined;
    const existing = ttydSessions.find(
      (tab) => tab.type === 'preview' && 'port' in tab && tab.port === port,
    );
    if (existing) {
      // The agent re-runs `blitz preview open` on every server start, so a
      // second "open /dashboard" almost always lands on a tab this port already
      // has. Re-point that tab instead of ignoring the route.
      retargetPreviewTab(existing.id, deepLink);
      selectTtydSession(String(existing.id));
    } else {
      addWorkspaceTab((id) => deepLink === undefined
        ? { id, type: 'preview', port }
        : { id, type: 'preview', port, path: deepLink });
    }
    return true;
  }, [addWorkspaceTab, retargetPreviewTab, selectTtydSession, ttydSessions]);
  const openPreviewLink = (url: string, title: string) => {
    if (url.trim() === '') return false;
    const existing = ttydSessions.find(
      (tab) => tab.type === 'preview' && 'url' in tab && tab.url === url,
    );
    if (existing) {
      selectTtydSession(String(existing.id));
    } else {
      addWorkspaceTab((id) => ({ id, type: 'preview', url, title }));
    }
    return true;
  };
  const resolveWorkspaceRequest = async (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => {
    if (action === 'approve') await client.approveCredentialRequest(request.id);
    else await client.denyCredentialRequest(request.id);
    setPendingRequests((current) => current.filter(({ id }) => id !== request.id));
  };
  const activePendingRequests = pendingRequests.filter(
    ({ workspace_id }) => workspace_id === activeWorkspaceId,
  );
  const closeTtydSessionNow = (id: string) => {
    updateWorkspaceTabs((tabs) => {
      const tab = tabs.tabs.find((entry) => String(entry.id) === id);
      return tab === undefined ? tabs : closePaneTab(tabs, tab.id);
    });
    retainedSessionIdsRef.current.ids.delete(id);
    setDirtyFileIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const renameTtydSession = (id: string, title: string | undefined) => {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) return;
    updateWorkspaceTabs((tabs) => renameTab(tabs, numericId, title));
  };
  const closeTtydSession = (id: string) => {
    const tab = ttydSessions.find((session) => String(session.id) === id);
    if (tab?.type === 'file' && dirtyFileIds.has(id)) {
      setFileCloseConfirmation({
        id,
        label: tab.filePath.split('/').at(-1) ?? tab.filePath,
      });
      return;
    }
    closeTtydSessionNow(id);
  };
  const updateFileDirty = (id: string, dirty: boolean) => {
    setDirtyFileIds((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const {
    tabDrag,
    beginTabDrag,
    trackTabDrag,
    dropTabDrag,
    clearTabDrag,
    dropTargetLabel,
  } = useWorkspaceTabDrag({
    panesRef,
    visibleRegions,
    enabled: splitEnabled,
    labelFor: (sessionId) => ttydTabs.find((tab) => tab.id === sessionId)?.label ?? '',
    onDrop: (id, target) => {
      setFocusedRegion(target.region);
      updateWorkspaceTabs((tabs) => (target.kind === 'split'
        ? splitTab(tabs, id, target.region)
        : moveTab(tabs, id, target.region, target.beforeId)));
    },
  });
  const statusWorkspace = activeWorkspace
    ? `workspace ${activeWorkspace.lifecycleStatus}`
    : 'workspace pending';
  const hasControllableWorkspace = store.workspaces.some(({ canControl }) => canControl);
  const webAppBooting = route.page === 'webApp' && (
    !loaded || (hasControllableWorkspace && !activeWorkspace)
  );
  const workspaceProvisioning = activeWorkspace?.lifecycleStatus === 'creating'
    || activeWorkspace?.lifecycleStatus === 'provisioning';
  const workspaceWaking = activeWorkspace?.lifecycleStatus === 'parked'
    || activeWorkspace?.lifecycleStatus === 'resuming';
  const workspaceWakingStage = workspaceWaking
    ? activeWorkspace?.lifecycleStatus === 'parked'
      ? 'waking · requesting compute'
      : 'waking · reattaching drive'
    : undefined;
  const workspaceErrored = activeWorkspace !== undefined && (
    activeWorkspace.lifecycleStatus === 'error'
    || (activeWorkspace.lifecycleStatus === 'parked' && activeWorkspace.errorDetail !== null)
  );
  // Terminals need a live box; files, previews and panels draw their
  // own unavailable states and stay mounted while the box wakes.
  const sessionsRenderable = !workspaceErrored
    && activeSessionUrl !== null
    && !workspaceProvisioning
    && tabsLoaded;
  const retainedSessions = retainedSessionIdsRef.current;
  // One renderer for every surface, all siblings in the pane grid. A tab that
  // changes column changes a grid placement, not a parent — so a visited
  // terminal survives the move, and an unvisited one still never mounts.
  const renderedSessions = ttydSessions.filter((session) => {
    if (!splitEnabled && session.type === 'panel') return false;
    const needsBox = session.type !== 'panel'
      && session.type !== 'file'
      && session.type !== 'preview';
    if (needsBox && !sessionsRenderable) return false;
    const sessionId = String(session.id);
    return sessionId === paneActiveId(surfaceRegion(session))
      || (
        retainedSessions.workspaceId === activeWorkspaceId
        && retainedSessions.ids.has(sessionId)
      );
  });
  const loadingStage = activeWorkspace === undefined
    ? 'starting · workspace terminal'
    : workspaceProvisioning
      ? activeWorkspace.lifecycleStatus === 'creating'
        ? `allocating · ${activeWorkspace.machineType
          ? machineTypeLabel(activeWorkspace.machineType)
          : 'workspace VM'}`
        : `starting · ${activeWorkspace.machineType
          ? machineTypeLabel(activeWorkspace.machineType)
          : 'workspace VM'}`
      : workspaceWakingStage ?? 'starting · workspace terminal';
  const loadingLabel = workspaceProvisioning
    ? activeWorkspace?.lifecycleStatus === 'creating'
      ? 'Creating workspace'
      : 'Provisioning workspace'
    : workspaceWaking ? 'Waking workspace' : 'Loading workspace';
  /** What a column shows when its active tab cannot draw itself yet. Files,
   * previews and panels always draw themselves, so they never see this. */
  const paneFallback = (region: WorkspaceRegion): ReactNode => {
    const activeId = paneActiveId(region);
    const session = ttydSessions.find((entry) => String(entry.id) === activeId) ?? null;
    if (
      session !== null
      && (session.type === 'file' || session.type === 'preview' || session.type === 'panel')
    ) return null;
    if (workspaceErrored && activeWorkspace) {
      return (
        <WorkspaceErrorState
          workspaceName={activeWorkspace.title}
          errorDetail={activeWorkspace.errorDetail}
          retryAction={activeWorkspace.retryAction}
          onRetry={() => retryWorkspace(activeWorkspace.id)}
        />
      );
    }
    if (!activeWorkspace) {
      return region !== 'main' ? null : (
        <div className="webapp-empty">
          <TerminalIcon />
          <h1>{store.workspaces.length > 0 ? 'No controllable workspaces' : 'No cloud workspaces'}</h1>
          <p>{store.workspaces.length > 0
            ? 'Workspace metadata remains visible in the rail. Only owners and admins can open terminals.'
            : 'Create a workspace from the rail to open a terminal.'}</p>
          <button className="webapp-action webapp-action--primary" type="button" onClick={() => {
            setShowCreateWorkspace(true);
          }}>Create workspace</button>
        </div>
      );
    }
    if (activeSessionUrl === null || workspaceProvisioning) {
      return <WebAppLoadingPane ariaLabel={loadingLabel} stage={loadingStage} />;
    }
    if (!tabsLoaded) {
      return <WebAppLoadingPane ariaLabel="Loading workspace" stage="loading · local tabs" />;
    }
    return session === null ? <p className="webapp-pane-empty">Empty pane</p> : null;
  };
  const filesSidebar = activeWorkspace === undefined ? null : (
    <FilesSidebar
      key={activeWorkspace.id}
      client={filesClient}
      expanded={activeFiles.expanded}
      getClient={getFilesClient}
      mobile={mobileWebApp}
      open={filesOpen}
      ready={activeWorkspaceRunning}
      refreshVersion={filesRefreshVersion}
      visible={filesSegmentVisible}
      wakingStage={workspaceWakingStage}
      width={activeFiles.width}
      sharedFolders={workspaceAttachments.workspaceId === activeWorkspace.id
        ? workspaceAttachments.folders
        : []}
      canShare={activeWorkspace.accessRole === 'owner' || activeWorkspace.accessRole === 'admin'}
      onClose={() => {
        if (mobileWebApp) setFilesDrawerOpen(false);
        else updateWorkspaceTabs((tabs) => {
          const files = panelTab(tabs, 'files');
          return files === null ? tabs : closePaneTab(tabs, files.id);
        });
      }}
      onExpandedChange={(expanded) => {
        setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
          ? { ...current, value: { ...current.value, expanded } }
          : current);
      }}
      onOpenFile={openFile}
      dirtyFilePaths={ttydSessions.flatMap((tab) => (
        tab.type === 'file' && dirtyFileIds.has(String(tab.id)) ? [tab.filePath] : []
      ))}
      onPathMoved={(source, destination) => {
        updateWorkspaceTabs((tabs) => ({
          ...tabs,
          tabs: tabs.tabs.map((tab) => {
            if (tab.type !== 'file') return tab;
            if (tab.filePath === source) return { ...tab, filePath: destination };
            if (tab.filePath.startsWith(`${source}/`)) {
              return { ...tab, filePath: `${destination}${tab.filePath.slice(source.length)}` };
            }
            return tab;
          }),
        }));
      }}
      onPathDeleted={(path) => {
        const affectedIds = ttydSessions.flatMap((tab) => (
          tab.type === 'file' && isPathAtOrBelow(path, tab.filePath) ? [String(tab.id)] : []
        ));
        for (const id of affectedIds) retainedSessionIdsRef.current.ids.delete(id);
        updateWorkspaceTabs((tabs) => closeFileTabsAtPath(tabs, path));
        setDirtyFileIds((current) => {
          if (!affectedIds.some((id) => current.has(id))) return current;
          const next = new Set(current);
          for (const id of affectedIds) next.delete(id);
          return next;
        });
      }}
      onOpenDriveFolder={(folderId) => navigateTo(folderPagePath(folderId))}
      onShareToDrive={setShareToDrivePath}
      onUnauthorized={handleUnauthorized}
      onWidthChange={setSidePaneWidth}
    />
  );
  const updateNotice = updateAvailableHash && (
    <div className="webapp-notice webapp-notice--update" role="status">
      <span>Updated version available</span>
      <button
        type="button"
        onClick={() => {
          markUpdateReloaded(updateAvailableHash);
          window.location.reload();
        }}
      >
        Reload
      </button>
    </div>
  );

  const shellNav = (railActiveWorkspaceId: string | null) => (
    <ShellNav
      workspaces={store.workspaces}
      viewer={store.viewer}
      activeWorkspaceId={railActiveWorkspaceId}
      activeWorkspace={activeWorkspace}
      showRail={railActiveWorkspaceId !== null || (mobileWebApp && activeWorkspace !== undefined)}
      sessions={railActiveWorkspaceId !== null && railActiveWorkspaceId === activeWorkspaceId
        ? railSessions
        : []}
      activeSessionId={railActiveSessionId ?? ''}
      livePorts={orderedLivePorts}
      previewLinks={orderedPreviewLinks}
      drawerOpen={drawerOpen}
      {...(lodyRail.onVendorHost === undefined
        ? {}
        : { onVendorHost: lodyRail.onVendorHost })}
      onSelectWorkspace={selectWorkspace}
      onRenameWorkspace={renameWorkspace}
      onOpenWorkspaceSettings={(workspaceId) => {
        if (mobileWebApp) setDrawerOpen(false);
        setDetails({ workspaceId, tab: 'settings' });
      }}
      onInviteToWorkspace={(workspaceId) => {
        if (mobileWebApp) setDrawerOpen(false);
        setDetails({ workspaceId, tab: 'members', focusAddMember: true });
      }}
      onCreateWorkspace={() => setShowCreateWorkspace(true)}
      onSwitchOrg={(orgId) => {
        void client.switchOrg(orgId).then(() => window.location.reload());
      }}
      onCreateOrg={() => setShowCreateOrg(true)}
      onOpenDrive={() => navigateTo(drivePath())}
      onOpenSettings={() => navigateToSettings('profile')}
      onSelectSession={selectTtydSession}
      onSpawnSession={spawnTtydSession}
      onOpenPreview={(port) => { openPreviewPort(port); }}
      onOpenPreviewLink={(url, title) => { openPreviewLink(url, title); }}
      onOpenWorkspaceMembers={(workspaceId) => {
        if (mobileWebApp) setDrawerOpen(false);
        setDetails({ workspaceId, tab: 'members' });
      }}
      onOpenWorkspaceDetails={(workspaceId) => {
        if (mobileWebApp) setDrawerOpen(false);
        setDetails({ workspaceId, tab: 'members' });
      }}
      onOpenWorkspaceMachine={(workspaceId) => {
        if (mobileWebApp) setDrawerOpen(false);
        setMachineWorkspaceId(workspaceId);
      }}
      onCloseDrawer={() => setDrawerOpen(false)}
    />
  );
  const railOverlays = (
    <ShellDialogs
      client={client}
      viewer={store.viewer}
      workspaces={store.workspaces}
      showCreateOrg={showCreateOrg}
      onCreateOrg={async (name) => {
        await api.createOrg(name);
        // POST /orgs rebinds the session to the org it just made, so the
        // reload lands inside it, exactly as switching does.
        window.location.reload();
      }}
      onCloseCreateOrg={() => setShowCreateOrg(false)}
      showCreateWorkspace={showCreateWorkspace}
      createWorkspaceBusy={createWorkspaceBusy}
      createWorkspaceError={createWorkspaceError}
      listMachineTypes={listMachineTypes}
      cloneFromWorkspaceId={cloneFromWorkspaceId}
      onCancelCreateWorkspace={() => {
        if (createWorkspaceBusy) return;
        setShowCreateWorkspace(false);
        setCloneFromWorkspaceId(null);
      }}
      onCreateWorkspace={(input) => { void createWorkspace(input); }}
      details={details}
      onCloseDetails={() => setDetails(null)}
      machineWorkspaceId={machineWorkspaceId}
      onCloseMachine={() => setMachineWorkspaceId(null)}
      onCloneWorkspace={(workspaceId) => {
        // "New workspace from existing" IS the template now (§0): the create
        // dialog opens carrying the source, and the server copies its config.
        setDetails(null);
        setCloneFromWorkspaceId(workspaceId);
        setShowCreateWorkspace(true);
      }}
      onRequestDeleteWorkspace={requestDeleteWorkspace}
      confirmation={confirmation}
      onCancelConfirmation={cancelConfirmation}
      onConfirmDelete={confirmWebAppAction}
    />
  );

  if (signedOut) {
    return <LoginForm loginUrl={api.googleLoginUrl()} />;
  }

  if (identityOnly !== null) {
    return (
      <CreateOrgPage
        onCreate={async (name) => {
          await api.createOrg(name);
          setIdentityOnly(null);
          setLoaded(false);
          setBootstrapVersion((version) => version + 1);
        }}
      />
    );
  }

  if (isSecondaryRoute(route)) {
    return (
      <SecondaryRoutes
        route={route}
        client={client}
        viewer={store.viewer}
        loaded={loaded}
        rail={shellNav(null)}
        dialogs={railOverlays}
        updateNotice={updateNotice}
        error={error}
        onDismissError={() => setError(null)}
        onNavigate={navigateTo}
        onOpenRail={() => setDrawerOpen(true)}
        onNavigateToSettings={navigateToSettings}
        onOpenWorkspace={navigateToWorkspacePage}
        onLeaveSettings={returnToWebApp}
        onSignOut={signOut}
        onLeftOrg={() => window.location.reload()}
        activeWorkspaceTitle={activeWorkspace?.title}
      />
    );
  }

  if (webAppBooting) {
    return (
      <main
        ref={shellRef}
        className="webapp-shell webapp-shell--booting"
        aria-busy="true"
      >
        <WebAppLoadingShell
          stage={loaded ? 'loading · workspaces' : 'loading · control plane'}
          mobile={mobileWebApp}
          drawerOpen={drawerOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onCloseDrawer={() => setDrawerOpen(false)}
        />
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {updateNotice}
      </main>
    );
  }

  return (
    <main
      ref={shellRef}
      className="drive-shell drive-shell--workspace"
      onDragOver={(event) => {
        if (filesClient === null) return;
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(event) => {
        // Fires for every child crossing; only clear when the pointer really left.
        // SAFETY: relatedTarget is either the Node receiving the pointer or null when it left the document.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={(event) => {
        if (filesClient === null) return;
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        setDropActive(false);
        void handleFilesDropped([...event.dataTransfer.files]);
      }}
    >
      {(dropActive || dropBusy) && (
        <div className="webapp-drop-overlay" role="status" aria-live="polite">
          {dropBusy ? 'Uploading…' : 'Drop to upload into this workspace'}
        </div>
      )}
      {shellNav(activeWorkspaceId)}
      {railOverlays}

      <div className="drive-ws-frame">
          <section className="webapp-workspace-view">
            {activeWorkspace?.accessRole === 'viewer' && (
              <div className="ws-viewer-hold" role="status">
                <strong>View access is almost here.</strong>
                <span>
                  Read-only terminals arrive with the next platform update. Until
                  then, ask {activeWorkspace.owner?.name ?? 'the owner'} for
                  editor access to use this workspace.
                </span>
              </div>
            )}
            {/* Lody sessions (plans/LODY-SESSIONS.md phases 3-4). Renders null
                unless VITE_BLITZ_LODY_SESSIONS is on, and imports nothing
                until it is: the vendored renderer is a 3.5 MB lazy chunk. It
                owns two mounts — the surface here, and the rail's vendored zone
                through `railHost`, portalled so both share one runtime. It is
                positioned absolutely over the panes rather than replacing them,
                so every ttyd terminal keeps its measured geometry across a
                switch. */}
            <LodySessionsRegion
              endpoints={activeWorkspaceRunning ? activeIngressEntry : null}
              viewerName={store.viewer?.identity.name ?? 'You'}
              viewerAvatarUrl={store.viewer?.identity.avatarUrl ?? null}
              workspaceTitle={activeWorkspace?.title ?? 'Workspace'}
              visible={lodyRail.visible}
              railHost={lodyRail.railHost}
              terminals={railSessions}
              activeTerminalId={railActiveSessionId ?? ''}
              onSelectTerminal={selectTtydSession}
              onOpenSession={lodyRail.openSession}
              onOpenLanding={lodyRail.openLanding}
              terminalsAction={(
                <NewTabControl
                  variant="icon"
                  livePorts={orderedLivePorts}
                  previewLinks={orderedPreviewLinks}
                  onSpawnSession={spawnTtydSession}
                  onOpenPreview={(port) => { openPreviewPort(port); }}
                  onOpenPreviewLink={(url, title) => { openPreviewLink(url, title); }}
                />
              )}
              onApiReady={setLodyApi}
              onActiveSessionChange={lodyRail.mirror}
              onShareSession={setSharingSessionId}
              sharedSessions={sharedSessions.rows}
              sharedOpen={sharedSessions.open}
              onSelectSharedSession={(row) => {
                lodyRail.openSharedSession(row.ownerMembershipId, row.sessionId);
              }}
            />
            <WorkPanes
              client={client}
              panesRef={panesRef}
              visibleRegions={visibleRegions}
              renderedSessions={renderedSessions}
              surfaceRegion={surfaceRegion}
              paneActiveId={paneActiveId}
              paneTabModels={paneTabModels}
              paneFallback={paneFallback}
              sidePaneWidth={activeFiles.width}
              paneResizing={paneResizing}
              tabDrag={tabDrag}
              splitEnabled={splitEnabled}
              mobile={mobileWebApp}
              drawerOpen={drawerOpen}
              tabsLoaded={tabsLoaded}
              workspaceWaking={workspaceWaking}
              canEditWorkspaceLayout={canEditWorkspaceLayout}
              activeWorkspace={activeWorkspace}
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceRunning={activeWorkspaceRunning}
              activeSessionUrl={activeSessionUrl}
              activeFilesBase={activeFilesBase}
              filesClient={filesClient}
              filesSidebar={filesSidebar}
              orgName={store.viewer?.org.name ?? 'Organization'}
              workspaceWakingStage={workspaceWakingStage}
              livePorts={orderedLivePorts}
              previewLinks={orderedPreviewLinks}
              pendingRequests={activePendingRequests}
              pendingRequestsError={pendingRequestsError}
              connectionsFocus={connectionsFocus}
              onOpenDrawer={() => {
                setFilesDrawerOpen(false);
                setDrawerOpen(true);
              }}
              onSelectSession={selectTtydSession}
              onCloseSession={closeTtydSession}
              onRenameSession={renameTtydSession}
              onSpawnSession={spawnTtydSession}
              onTabDragStart={beginTabDrag}
              onTabDragEnd={clearTabDrag}
              onTabDragOver={(event) => {
                if (tabDrag === null) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                trackTabDrag(event);
              }}
              onTabDrop={dropTabDrag}
              onOpenPreview={openPreviewPort}
              onOpenPreviewLink={openPreviewLink}
              onResolveRequest={resolveWorkspaceRequest}
              onFileDirtyChange={updateFileDirty}
              onFilesRefresh={() => setFilesRefreshVersion((version) => version + 1)}
              onUnauthorized={handleUnauthorized}
              onSignInUrl={setTerminalSignInUrl}
              onBeginPaneResize={(event: ReactMouseEvent<HTMLDivElement>) => {
                if (event.button !== 0) return;
                event.preventDefault();
                endPaneResize.current?.();
                const origin = { x: event.clientX, width: activeFiles.width };
                const move = (moveEvent: MouseEvent) => {
                  setSidePaneWidth(clampDrawerWidth(
                    origin.width + origin.x - moveEvent.clientX,
                    window.innerWidth,
                  ));
                };
                const stop = () => endPaneResize.current?.();
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', stop);
                window.addEventListener('blur', stop);
                endPaneResize.current = () => {
                  window.removeEventListener('mousemove', move);
                  window.removeEventListener('mouseup', stop);
                  window.removeEventListener('blur', stop);
                  endPaneResize.current = null;
                  setPaneResizing(false);
                };
                setPaneResizing(true);
              }}
            />
            {mobileWebApp && activeWorkspace && (
              <button
                className={`files-drawer-scrim${filesDrawerOpen ? ' files-drawer-scrim--open' : ''}`}
                type="button"
                aria-label="Close workspace drawer"
                tabIndex={-1}
                onClick={() => setFilesDrawerOpen(false)}
              />
            )}
          </section>

          {(!mobileWebApp || activeWorkspace) && (
            <footer
              className="webapp-statusline"
              aria-label={mobileWebApp ? 'Workspace actions' : 'Workspace status'}
            >
              {!mobileWebApp && (
                <>
                  <span className="webapp-statusline__box">{statusWorkspace}</span>
                  <span
                    className="webapp-statusline__path"
                    title={activeWorkspace?.title ?? 'workspace pending'}
                    role="status"
                    aria-live="polite"
                  >
                    {activeWorkspace?.title ?? 'workspace pending'}
                  </span>
                  {activeSessionUrl && ttydActiveTerminalType && terminalSignInUrl && (
                    <>
                      <button
                        className="webapp-statusline__sign-in"
                        type="button"
                        onClick={() => window.open(terminalSignInUrl, '_blank', 'noopener')}
                      >
                        Open sign-in link
                      </button>
                      <button
                        className="webapp-statusline__paste-code"
                        type="button"
                        onClick={() => setShowPasteCodeModal(true)}
                      >
                        Paste code
                      </button>
                    </>
                  )}
                </>
              )}
              {mobileWebApp && (
                <>
                  {activeSessionUrl && ttydActiveTerminalType && (
                    <div className="webapp-statusline__left-actions">
                      <button
                        className="webapp-statusline__paste"
                        type="button"
                        aria-label="Paste into terminal"
                        onPointerDown={(event) => {
                          if (event.button === 0) event.preventDefault();
                        }}
                        onPointerUp={(event) => {
                          if (event.button === 0) dispatchTerminalPaste();
                        }}
                        onContextMenu={(event) => event.preventDefault()}
                        onClick={(event) => {
                          if (event.detail === 0) dispatchTerminalPaste();
                        }}
                      >
                        <span className="mi-paste" aria-hidden="true" />
                      </button>
                      <button
                        className="webapp-statusline__enter"
                        type="button"
                        aria-label="Send Enter to terminal"
                        onPointerDown={(event) => {
                          if (event.button === 0) event.preventDefault();
                        }}
                        onPointerUp={(event) => {
                          if (event.button === 0) dispatchTerminalEnter();
                        }}
                        onContextMenu={(event) => event.preventDefault()}
                        onClick={(event) => {
                          if (event.detail === 0) dispatchTerminalEnter();
                        }}
                      >
                        <span className="mi-enter" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  {activeSessionUrl && ttydActiveTerminalType && terminalSignInUrl
                    && <div className="webapp-statusline__dynamic-actions">
                    <button
                      className="webapp-statusline__sign-in"
                      type="button"
                      onClick={() => window.open(terminalSignInUrl, '_blank', 'noopener')}
                    >
                      Open sign-in link
                    </button>
                    <button
                      className="webapp-statusline__paste-code"
                      type="button"
                      onClick={() => setShowPasteCodeModal(true)}
                    >
                      Paste code
                    </button>
                  </div>}
                  {activeSessionUrl && ttydActiveTerminalType && (
                    <div className="webapp-statusline__right-actions">
                      <button
                        className="webapp-statusline__keyboard"
                        type="button"
                        aria-label="Toggle terminal keyboard"
                        onPointerDown={(event) => {
                          if (event.button === 0) event.preventDefault();
                        }}
                        onContextMenu={(event) => event.preventDefault()}
                        onClick={dispatchTerminalKeyboard}
                      >
                        <span className="mi-keyboard" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </>
              )}
              {activeWorkspace && (
                <button
                  className="webapp-statusline__files"
                  type="button"
                  aria-label={filesOpen ? 'Close workspace drawer' : 'Open workspace drawer'}
                  aria-controls={mobileWebApp ? 'webapp-workspace-drawer' : undefined}
                  aria-expanded={mobileWebApp ? filesDrawerOpen : undefined}
                  aria-pressed={filesOpen}
                  title={`${filesOpen ? 'Hide' : 'Show'} workspace drawer (Cmd/Ctrl+B)`}
                  onClick={toggleFiles}
                >
                  <FileIcon aria-hidden="true" />
                  <span>drawer</span>
                  {activePendingRequests.length > 0 && (
                    <span className="workspace-pending-badge" aria-label={`${activePendingRequests.length} pending requests`}>
                      {activePendingRequests.length}
                    </span>
                  )}
                </button>
              )}
            </footer>
          )}

          {showPasteCodeModal && (
            <PasteCodeModal
              onCancel={() => setShowPasteCodeModal(false)}
              onSend={(payload) => {
                setShowPasteCodeModal(false);
                window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, { detail: payload }));
              }}
            />
          )}
      </div>

      {activeWorkspace && !mobileWebApp && (
        <WorkspaceRailStrip
          openPanels={openPanels}
          pendingRequestCount={activePendingRequests.length}
          onTogglePanel={(panel) => {
            updateWorkspaceTabs((tabs) => togglePanelTab(tabs, panel));
            setFocusedRegion('side');
          }}
        />
      )}

      {activeWorkspace && mobileWebApp && (
        <WorkspaceDrawer
          client={client}
          workspaceId={activeWorkspace.id}
          mobile
          open={filesOpen}
          width={activeFiles.width}
          segment={drawerSegment}
          orgName={store.viewer?.org.name ?? 'Organization'}
          pendingRequests={activePendingRequests}
          pendingRequestsError={pendingRequestsError}
          workspaceConnections={activeWorkspace.connections}
          connectionsFocus={connectionsFocus}
          readOnly={activeWorkspace.accessRole === 'viewer'}
          onWidthChange={setSidePaneWidth}
          onSegmentChange={setMobileSegment}
          onResolveRequest={resolveWorkspaceRequest}
          livePorts={orderedLivePorts}
          previewLinks={orderedPreviewLinks}
          filesBase={activeFilesBase}
          previewReady={activeWorkspaceRunning}
          onOpenPreview={(port) => { openPreviewPort(port); }}
          onOpenPreviewLink={(url, title) => { openPreviewLink(url, title); }}
          files={filesSidebar}
        />
      )}

      {tabDrag !== null && (
        <>
          <div
            className="webapp-pane-ghost"
            aria-hidden="true"
            style={{
              left: `${tabDrag.pointer.x + 14}px`,
              top: `${tabDrag.pointer.y - 12}px`,
            }}
          >{tabDrag.label}</div>
          <div
            className="webapp-pane-droptip"
            role="status"
            style={{
              left: `${tabDrag.pointer.x + 16}px`,
              top: `${tabDrag.pointer.y + 20}px`,
            }}
          >{dropTargetLabel(tabDrag.target)}</div>
        </>
      )}

      {shareToDrivePath !== null && activeWorkspace && (
        <ShareToDriveDialog
          client={client}
          workspaceId={activeWorkspace.id}
          path={shareToDrivePath}
          onCancel={() => setShareToDrivePath(null)}
          onShared={(folderId) => {
            setShareToDrivePath(null);
            setAttachmentsVersion((version) => version + 1);
            navigateTo(folderPagePath(folderId));
          }}
        />
      )}

      {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      {updateNotice}
      {sharingSessionId !== null && activeWorkspace !== undefined && activeWorkspace !== null && store.viewer !== null && (
        <SessionShareDialog
          client={client}
          workspaceId={activeWorkspace.id}
          sessionId={sharingSessionId}
          // The daemon owns session titles and the rail draws them; the dialog
          // is opened from a row whose id is all that crosses, so the heading
          // names the session by id rather than inventing a second title
          // source that could disagree with the row above it.
          sessionTitle={sharingSessionId.slice(0, 8)}
          members={activeWorkspace.members}
          viewerMembershipId={store.viewer.membership.id}
          onClose={() => {
            setSharingSessionId(null);
            setShareRevision((revision) => revision + 1);
          }}
        />
      )}
      {fileCloseConfirmation && (
        <ConfirmationDialog
          title="Discard changes?"
          description={`Discard unsaved changes to ${fileCloseConfirmation.label}?`}
          confirmLabel="Discard"
          cancelLabel="Cancel"
          onCancel={() => setFileCloseConfirmation(null)}
          onConfirm={() => {
            closeTtydSessionNow(fileCloseConfirmation.id);
            setFileCloseConfirmation(null);
          }}
        />
      )}
    </main>
  );
}
