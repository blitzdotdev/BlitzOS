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
import { ApiAdapter, ApiError, type TenantMe } from './api-adapter';
import type { ControlPlaneClient } from './api';
import type { CredentialRequestView } from '@blitzos/schema';
import { SPAWN_SESSION_LABELS, type SpawnSessionType } from './NewTabMenu';
import type { WebAppTabModel } from './SessionTypeIcon';
import type { RailSession } from './shell/rail-sessions';
import { workspaceStatusLine } from './shell/workspace-status-line';
import { useBoxGatewayHealth } from './box-gateway-health';
import type { CreateWorkspaceDialogInput } from './CreateWorkspaceDialog';
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
import { AccessApprovalDialog } from './AccessApprovalDialog';
import { useAccessProposals } from './use-access-proposals';
import type { ConnectionsFocus, WorkspaceDetailsTab } from './WorkspaceDetailsDialog';
import { ShellNav } from './shell/ShellNav';
import { isSecondaryRoute, SecondaryRoutes } from './shell/SecondaryRoutes';
import { NewTabControl } from './shell/NewTabControl';
import { WorkPanes } from './shell/WorkPanes';
import { LodySessionsRegion, lodySurfaceMounts } from './lody/LodySessionsRegion';
import { BrowserPanel } from './browser/BrowserPanel';
import { browserFrameUrl, browserTargetFromFocus, type BrowserTarget } from './browser/browser-target';
import {
  BROWSER_SIDE_PANEL_ID,
  sidePanelQuickActionIcon,
  useSidePanelHostState,
  type SessionHostSidePanelTab,
  type SessionSidePanelRequest,
  type SidePanelBinding,
  type SidePanelQuickAction,
} from './lody/side-panel';
import {
  recallWorkspaceChatPath,
  rememberWorkspaceChatPath,
} from './workspace-chat-memory';
import { SurfaceTabContent } from './lody/SurfaceTabContent';
import {
  surfaceTabId,
  toSessionSurfaceTabs,
  workspaceTabIdFromSurfaceTabId,
  type SurfaceTabsBinding,
} from './lody/surface-tabs';
import { useLodyRail, type LodyRailSessions } from './lody/use-lody-rail';
import { useTerminalAddressSync } from './lody/use-terminal-address-sync';
import { useLodySessionsCapability } from './lody/box-capability';
import { LODY_SESSIONS_ENABLED } from './lody/flag';
import { useSharedSessions } from './lody/use-shared-sessions';
import type { LodySessionSurfaceApi } from './lody/SessionSurface';
import {
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
  closeTab as closePaneTab,
  paneRegions,
  regionActiveId,
  renameTab,
  withRegionActiveId,
} from './workspace-panes';
import { ConnectApprovalDialog } from './ConnectApprovalDialog';
import { WorkspaceRailStrip } from './WorkspaceRailStrip';
import { TERMINAL_KEYBOARD_EVENT, TERMINAL_PASTE_EVENT } from './terminal-touch';
import { TERMINAL_SUBMIT_EVENT } from './TtydTerminal';
import { WorkspaceErrorState } from './WorkspaceErrorState';
import { WorkspaceStoppedState } from './WorkspaceStoppedState';
import { dropPasteText, uploadDroppedFiles } from './file-drop';
import {
  initialWorkspaceStore,
  selectControllableWorkspaceId,
  workspaceReducer,
  type WorkspaceAction,
} from './workspace-store';
import {
  isPreviewPath,
  isPreviewPort,
  newestPorts,
  newestPreviewLinks,
  previewLinkLabel,
} from './preview';
import { killTerminalSession } from './terminal-kill';
import { decideUpdateAction, extractIndexAsset } from './update-check';
import { LoginForm } from './components/LoginForm';
import { CreateOrgPage } from './components/CreateOrgPage';
import type { IdentityRecord } from './protocol';
import { FILES_DAV_ROOT, type EndpointResolver } from './resolver';
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
import { ErrorReporterProvider } from './error-dialog/ErrorReporter';
import { useWorkspaceOptimisticCreate } from './use-workspace-optimistic-create';
import { useOrganizationOptimisticTransitions } from './use-organization-optimistic-transitions';

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

const PANEL_LABELS = {
  connections: 'Connections',
} satisfies Record<WorkspaceDrawerSegment, string>;

export type CloudAppProps = {
  client: ControlPlaneClient;
  resolver: EndpointResolver;
};

function CloudAppContent({ client, resolver }: CloudAppProps) {
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
  const [signOutPending, setSignOutPending] = useState(false);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  /** The workspace a "new workspace from existing" is copying, or null for a
   * blank create. Cleared with the dialog. */
  const [cloneFromWorkspaceId, setCloneFromWorkspaceId] = useState<string | null>(null);
  const [details, setDetails] = useState<
    {
      workspaceId: string;
      tab: WorkspaceDetailsTab;
      focusAddMember?: boolean;
      focusProvider?: ConnectionsFocus;
    } | null
  >(null);
  const [machineWorkspaceId, setMachineWorkspaceId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<WebAppConfirmation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [terminalSignInUrl, setTerminalSignInUrl] = useState<string | null>(null);
  const [showPasteCodeModal, setShowPasteCodeModal] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<CredentialRequestView[]>([]);
  const [pendingRequestsError, setPendingRequestsError] = useState<string | null>(null);
  // The access-approval feed (plans/ORG-CREDENTIALS.md §7a): a pending
  // proposal addressed to this member pops the dialog on whichever page they
  // are on, so it polls whenever they are signed in to an org.
  const accessProposals = useAccessProposals(
    client,
    !signedOut && store.viewer !== null,
    store.viewer?.membership.id ?? null,
  );
  // Lody's side panel as it last reported itself (seam patch 23), and `null`
  // while no session detail is on screen. The right icon strip draws from it
  // and drives it through `sidePanelRequest`, one `seq` per press.
  const [sidePanelState, setSidePanelState] = useSidePanelHostState();
  const [sidePanelRequest, setSidePanelRequest] = useState<SessionSidePanelRequest | null>(null);
  // What the browser panel shows (`browser/BrowserPanel.tsx`): set by its
  // address bar and by the box's `blitz browser open`. Held here rather than
  // in the panel so the page survives the tab being switched away and back.
  const [browserTarget, setBrowserTarget] = useState<BrowserTarget | null>(null);
  useEffect(() => {
    setBrowserTarget(null);
  }, [activeWorkspaceId]);
  const requestSidePanel = useCallback((tabId: string, action: 'open' | 'close') => {
    setSidePanelRequest((previous) => ({ tabId, action, seq: (previous?.seq ?? 0) + 1 }));
  }, []);
  // The member's most recently active session, reported by the rail from Lody's
  // own session mirror, and the strip press waiting for it to arrive on screen.
  //
  // WHY THE STRIP NEEDS BOTH. Files, All Changes, Browser and Side Chat are
  // panels of a SESSION. Pressed on the landing there is no session detail
  // mounted, so there is nothing to open them in — which is why the four
  // buttons used to be drawn disabled there. They are live now: the press opens
  // the most recent session, the panel request is HELD, and the effect below
  // replays it the moment the session's panel reports itself.
  const [mostRecentSessionId, setMostRecentSessionId] = useState<string | null>(null);
  const [pendingQuickAction, setPendingQuickAction] = useState<SidePanelQuickAction | null>(null);
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
  // A workspace list request that began before a successful local mutation can
  // finish afterward with the older snapshot. Mutation responses are the
  // authority for their own rows, so such a request is discarded rather than
  // briefly (or permanently) rolling the UI backward.
  const workspaceMutationEpoch = useRef(0);
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
    if (!mobileWebApp) setDrawerOpen(false);
  }, [mobileWebApp]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route.page, route.workspaceId]);

  useEffect(() => {
    if (!mobileWebApp) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
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
    setSignOutPending(false);
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
  const {
    transitionStage: organizationTransitionStage,
    createOrgName,
    setCreateOrgName,
    openCreateOrganization,
    closeCreateOrganization,
    createOrganizationFromIdentity,
    createOrganizationFromDialog,
    switchOrganization,
    leaveOrganization,
  } = useOrganizationOptimisticTransitions({
    api,
    client,
    viewer: store.viewer,
    setIdentityOnly,
    setLoaded,
    setBootstrapVersion,
    setShowCreateOrg,
    setError,
  });
  const signOut = useCallback(async () => {
    setError(null);
    setSignOutPending(true);
    try {
      await api.logout();
      setSignedOut(true);
    } catch (cause) {
      // An auth refusal says there is no usable logout session left.
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        setSignedOut(true);
        return;
      }
      setSignedOut(false);
      setError(`Could not sign out: ${caughtErrorMessage(
        cause,
        'The control plane request failed.',
      )}`);
    } finally {
      setSignOutPending(false);
    }
  }, [api]);
  const listMachineTypes = useCallback(() => api.listMachineTypes(), [api]);
  const refreshWorkspaceRecords = useCallback(async () => {
    const mutationEpoch = workspaceMutationEpoch.current;
    try {
      const records = await api.listWorkspaces();
      if (mutationEpoch !== workspaceMutationEpoch.current) return;
      rememberWorkspaceEndpoints(workspaceEndpoints.current, records, resolver, true);
      dispatch({ type: 'workspace_records_refreshed', records });
    } catch (refreshError) {
      if (!(refreshError instanceof ApiError && refreshError.status === 401)) {
        console.warn('Unable to refresh workspace status', refreshError);
      }
    }
  }, [api, resolver]);
  const commitWorkspaceMutation = useCallback((action: WorkspaceAction) => {
    workspaceMutationEpoch.current += 1;
    dispatch(action);
  }, []);

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
    storageNamespace !== null && activeWorkspace?.pendingCreate !== true,
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
      // With a session on screen the browser panel is the destination: show
      // the target and open our tab. Otherwise the top strip's preview tab is,
      // exactly as `blitz teenyapp open` has always landed.
      const target = browserTargetFromFocus(focus);
      if (sidePanelDriven) {
        setBrowserTarget(target);
        requestSidePanel(BROWSER_SIDE_PANEL_ID, 'open');
      } else if (target.kind === 'port') {
        openPreviewPort(target.port, target.path);
      } else {
        const frameUrl = activeFilesBase === null ? null : browserFrameUrl(target, activeFilesBase);
        openPreviewLink(frameUrl ?? (target.kind === 'url' ? target.url : ''), focus.title);
      }
    },
  );

  // The in-box agent's `blitz connections open <provider>` raises the other
  // focus. The MARKER is unchanged (`connections-focus`, version 2 with a
  // `kind`, pinned by fixtures on three runtimes); what it opens is the
  // workspace-details dialog on its Connections tab, with that provider's row
  // brought into view — the one surface a workspace's connections live on now.
  useWorkspaceConnectionsFocus(
    route.page === 'webApp' && activeWorkspaceRunning,
    activeWorkspaceId,
    activeFilesBase,
    (focus) => {
      // The marker's own `requestedAt`, not `Date.now()`: the row re-highlights
      // on a fresh ask, and a focus replayed from the box must carry the time
      // the box raised it. It rides the dialog's own state beside `tab` and
      // `focusAddMember`, which is where "open this dialog pointed at a thing"
      // already lives.
      setDetails({
        workspaceId: activeWorkspaceId,
        tab: 'connections',
        focusProvider: { provider: focus.provider, at: focus.requestedAt },
      });
    },
  );

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
    // One cadence now: nothing on screen is a connect inbox to hurry for. A
    // pending request pops `ConnectApprovalDialog` wherever the member is.
    const timer = window.setInterval(() => { void poll(); }, 15_000);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
    };
  }, [activeWorkspaceId, client, route.page, signedOut]);

  // The box's dufs WebDAV server, for the drop-to-upload path below.
  const filesClient = useMemo<WebDAVClient | null>(() => {
    if (!activeFilesBase) return null;
    return createClient(activeFilesBase, { withCredentials: true, remoteBasePath: FILES_DAV_ROOT });
  }, [activeFilesBase]);
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
    if (!loaded || signedOut || route.page !== 'home') return;
    const workspaceId = selectControllableWorkspaceId(store.workspaces, '');
    if (workspaceId === '') return;
    activeWorkspaceIdRef.current = workspaceId;
    setActiveWorkspaceId(workspaceId);
    window.history.replaceState({}, '', workspacePath(workspaceId));
    setRoute({ workspaceId, page: 'webApp', chat: null });
  }, [loaded, route.page, signedOut, store.workspaces]);

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
    if (
      !loaded
      || !storageNamespace
      || store.workspaces.some(({ pendingCreate }) => pendingCreate)
    ) return;
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
    // COME BACK WHERE THE MEMBER LEFT. Without this the switch pushes a path
    // with no chat segment and sets `chat: null`, so returning to a workspace
    // lands on the landing however deep in a session they were. The remembered
    // value is a PATH, so restoring is the parser the shell already has rather
    // than a second switch over `ChatAddress` that would drift from it.
    const remembered = recallWorkspaceChatPath(workspaceId);
    const path = remembered ?? workspacePath(workspaceId);
    window.history.pushState({}, '', path);
    setRoute(remembered === null ? { workspaceId, page: 'webApp', chat: null } : parseAppRoute(path));
  }, []);

  // WHERE EACH WORKSPACE IS BEING LEFT. Recorded only for a path that carries a
  // real chat address: the bare `/workspaces/:id` is what the restore above
  // exists to improve on, so writing it would erase the memory on the way out.
  useEffect(() => {
    if (route.page !== 'webApp' || route.workspaceId === null || route.chat === null) return;
    rememberWorkspaceChatPath(route.workspaceId, window.location.pathname);
  }, [route]);

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
    setRoute({ workspaceId: null, page: 'home' });
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
        setRoute({ workspaceId: null, page: 'home' });
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

  const closeCreateWorkspace = useCallback(() => {
    setShowCreateWorkspace(false);
    setCloneFromWorkspaceId(null);
  }, []);
  // Clone submissions carry `cloneFromWorkspaceId` in the same input and use
  // this tail. Recipes have been removed.
  const adoptCreatedWorkspace = useWorkspaceOptimisticCreate({
    resolver,
    workspaceEndpoints,
    storeRef,
    activeWorkspaceIdRef,
    commitWorkspaceMutation,
    setActiveWorkspaceId,
    setRoute,
    setError,
    closeCreateDialog: closeCreateWorkspace,
    navigateToWorkspacePage,
  });
  const createWorkspace = useCallback(
    (input: CreateWorkspaceDialogInput, viewer: TenantMe) => adoptCreatedWorkspace(
      input,
      viewer,
      () => api.createWorkspace(input),
    ),
    [adoptCreatedWorkspace, api],
  );
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

  /**
   * Start the viewer's own machine in the active workspace, from the pane that
   * replaces the loading spinner while it is stopped (`WorkspaceStoppedState`).
   * The refresh is what moves the pane on: the record comes back `creating`,
   * the poll hurries for a transitioning workspace, and `running` follows.
   */
  const startMyMachine = useCallback(async () => {
    const workspace = storeRef.current.workspaces.find(({ id }) => id === activeWorkspaceId);
    const membershipId = storeRef.current.viewer?.membership.id ?? null;
    const machine = workspace?.members
      .find((member) => member.membershipId === membershipId)?.machine ?? null;
    if (machine === null) throw new Error('You have no machine in this workspace to start.');
    await client.startMachine(machine.id);
    await refreshWorkspaceRecords();
  }, [activeWorkspaceId, client, refreshWorkspaceRecords]);

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
  // Does this workspace's own MACHINE serve sessions? The build flag cannot
  // answer that — a box on a pre-Lody image has no `/lody/*` door at all — so
  // the browser asks it once, before anything commits to the session plane
  // (plans/LODY-RUNTIME-DESIGN.md §17).
  const lodySessions = useLodySessionsCapability(
    activeWorkspaceRunning ? activeIngressEntry?.lodyPlatformUrl ?? null : null,
  );
  // Can the browser reach this workspace's box at all? Every box poll in the
  // shell reports what it saw to this signal, so nothing new is asked of the
  // network to answer it (BUG-CV-01, BUG-CV-02).
  const boxGateway = useBoxGatewayHealth();
  // DOES THE SESSION STRIP DRAW THIS WORKSPACE'S TABS?
  //
  // It is `lodySurfaceMounts` — the region's own mount condition, asked here
  // rather than restated — plus the layout. Since the native strip was deleted
  // (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2") this decides three things at
  // once: whether the panes yield their tab bodies, whether the workspace ROOT
  // address is normalised into the chat plane (`useLodyRail`), and whether a
  // rail click selects a tab in the strip or hands the view to the panes.
  //
  // DESKTOP ONLY, which is §5.5's "mobile is not in v1" taken literally: the
  // vendored strip lives in `DesktopSessionDetailLayout` and `SessionDetail`
  // draws its own mobile layout below the breakpoint, whose tab sheet seam
  // patch 5 does not widen. A mobile workspace therefore keeps the panes, and
  // the rail — in the mobile drawer — is its tab list.
  //
  // IT IS NOT `available`. `available` is "the probe has not ruled it out",
  // which stays true throughout `probing` and for good on a workspace whose box
  // is not running. Every consequence above is wrong in that window: the panes
  // would give up their bodies to a host that never mounts, and the root address
  // would be sent to a landing that may turn out to be unreachable.
  const surfaceTabsEnabled = lodySurfaceMounts(
    activeWorkspaceRunning ? activeIngressEntry : null,
    lodySessions,
  ) && !mobileWebApp;
  // THE BOOT WINDOW, NAMED (`shell/PaneChrome.tsx`).
  //
  // The probe starts at `probing` on every cold load and can retry for 7.5 s.
  // The panes used to fill that window with the native strip and then swap it
  // for the session strip — the "old tabs come back when I refresh" report. The
  // window now draws a skeleton instead, and a SETTLED answer is never pending:
  // a box with no session plane is not loading, it has none, and the rail's
  // notice says so.
  const sessionPlanePending = LODY_SESSIONS_ENABLED && lodySessions === 'probing';
  const lodyRailSessions = useMemo<LodyRailSessions>(() => ({
    capability: lodySessions,
    surfaceHostsTabs: surfaceTabsEnabled,
  }), [lodySessions, surfaceTabsEnabled]);
  // Lody sessions (plans/LODY-SESSIONS.md §8). The hook owns the rail's portal
  // host, the chat address and the fresh-workspace default; with the flag off,
  // or against a box that serves no daemon, every field is inert and the rail
  // keeps its native list.
  const lodyRail = useLodyRail(
    route,
    setRoute,
    activeWorkspaceId,
    tabsLoaded,
    lodyRailSessions,
  );
  const [lodyApi, setLodyApi] = useState<LodySessionSurfaceApi | null>(null);
  // Which session the share dialog is open on. One piece of state, because the
  // dialog reads and writes its own access list (plans/LODY-SHARING.md §8).
  const [sharingSessionId, setSharingSessionId] = useState<string | null>(null);
  // Bumped when the share dialog closes, so access the viewer just gave
  // themselves — an admin acting on somebody's behalf — reaches the rail
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
  // "+ NEW SESSION" IS TWO THINGS, and the address is only one of them.
  //
  // Moving the address to the landing does nothing when the landing is already
  // the address — `useLodyRail.go` refuses to push the path it is on, which is
  // what keeps a rail row from stacking history entries — so from `/chat` the
  // button was a complete no-op. What a member means by it is a FRESH draft, and
  // the surface has upstream's own mechanism for that (`resetDraftKey`).
  const openLandingRail = lodyRail.openLanding;
  const openFreshLanding = useCallback(() => {
    openLandingRail();
    lodyApi?.openLanding({ resetDraft: true });
  }, [lodyApi, openLandingRail]);
  const ttydLabel = (session: WorkspaceTab) => session.type === 'panel'
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
  const ttydTabs = useMemo<WebAppTabModel[]>(() => ttydSessions.map((session) => {
    if (session.type === 'panel') {
      return {
        id: String(session.id),
        label: PANEL_LABELS[session.panel],
        agent: 'panel',
        panel: session.panel,
        pending: false,
      };
    }
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
  }), [ttydSessions]);
  const railSessions = useMemo<RailSession[]>(() => ttydTabs
    .filter((tab) => tab.agent !== 'panel' && tab.agent !== 'preview')
    .map((tab) => ({ id: tab.id, label: tab.label, agent: tab.agent })), [ttydTabs]);
  const railActiveSessionId = (() => {
    const railIds = new Set(railSessions.map(({ id }) => id));
    if (ttydActiveId !== null && railIds.has(ttydActiveId)) return ttydActiveId;
    // Previews and utility panels are not rail sessions. When one has
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
  // The address, read once. Everything below that has to agree with it — the
  // strip's selection, the pane that mounts the tab body, the rail's highlight
  // — reads these rather than `lodyRail` again, so the agreement is visible.
  const addressTerminalId = lodyRail.terminalId;
  const addressSessionId = lodyRail.sessionId;
  const { openTerminal, openSession, openLanding } = lodyRail;
  // WHERE A WORKSPACE TAB IS SELECTED (plans/LODY-TERMINAL-TABS.md §4.1-§4.2).
  //
  // Where the session strip draws the tabs, a terminal is a TAB of it:
  // selecting one moves the ADDRESS to that tab inside the surface. Everywhere
  // else — a box on a pre-Lody image, a member with no machine, mobile, or the
  // flag off — it is the panes' own selection and the chat surface steps aside.
  // `surfaceTabsEnabled` is decided beside the probe that answers it.
  const sidePanelDriven = surfaceTabsEnabled && lodyRail.visible && sidePanelState !== null;
  useEffect(() => {
    if (!surfaceTabsEnabled) setSidePanelState(null);
  }, [surfaceTabsEnabled]);
  const openTerminalTab = lodyRail.openTerminal;
  const selectWorkspaceTab = useCallback((id: string) => {
    if (surfaceTabsEnabled) openTerminalTab(id);
    else closeChat();
  }, [closeChat, openTerminalTab, surfaceTabsEnabled]);
  // THE ID A SPAWN CREATED, READ FROM THE WRITE THAT CREATED IT.
  //
  // `appendTab` takes `tabs.nextId`, so the id is a property of the document the
  // write starts from — and the previous version read it from the RENDER
  // instead. Two spawns in one tick then both selected the first one's tab, and
  // with the document not yet loaded the render-time id was `null`, which sent
  // the member to the panes without having spawned anything at all.
  //
  // The updater reports the id it took and the selection follows on the commit
  // that holds the new tab. Queued updaters run in order, so two spawns in one
  // tick leave the SECOND one's id here — the newest tab wins the selection,
  // which is what a member who pressed twice means.
  const spawnedTabId = useRef<number | null>(null);
  const addWorkspaceTab = useCallback((
    createTab: (id: number) => WorkspaceTab,
    region: WorkspaceRegion = 'main',
  ) => {
    setFocusedRegion(region);
    updateWorkspaceTabs((tabs) => {
      spawnedTabId.current = tabs.nextId;
      return appendTab(tabs, region, createTab);
    });
  }, [updateWorkspaceTabs]);
  const spawnTtydSession = (type: SpawnSessionType) => {
    addWorkspaceTab((id) => ({ id, type }));
  };
  /** Make one workspace tab the active tab of its own pane, so its body mounts.
   * `false` when the workspace does not hold it. */
  const focusPaneTab = useCallback((id: string): boolean => {
    const session = ttydSessions.find((tab) => String(tab.id) === id);
    if (session === undefined) return false;
    setFocusedRegion(surfaceRegion(session));
    updateWorkspaceTabs((tabs) => withRegionActiveId(tabs, tabRegion(session), session.id));
    return true;
  }, [surfaceRegion, ttydSessions, updateWorkspaceTabs]);
  const selectTtydSession = useCallback((id: string) => {
    if (!focusPaneTab(id)) return;
    selectWorkspaceTab(id);
  }, [focusPaneTab, selectWorkspaceTab]);
  // The tail of a spawn: the tab exists now, so it can be selected.
  useEffect(() => {
    const id = spawnedTabId.current;
    if (id === null) return;
    if (!ttydSessions.some((tab) => tab.id === id)) return;
    spawnedTabId.current = null;
    selectWorkspaceTab(String(id));
  }, [selectWorkspaceTab, ttydSessions]);

  // THE PANEL VERBS ARE GONE. `showPanel`/`togglePanel` wrote a pane tab for
  // one panel — Connections — and that panel is a tab of the workspace-details
  // dialog now. `workspace-panes.ts` keeps `panelTab`/`showPanelTab` for a
  // layout persisted before this change, whose tab still draws its body
  // through `SurfaceTabContent`; nothing in the shell creates a new one.
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === 'n') {
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
  }, [selectWorkspace, store.workspaces]);
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
  
  // Held across a render: a handler declared in the render body is a new
  // identity every render, and the side panel reports itself on every input
  // that changes (`useSidePanelHostState`).

  const resolveWorkspaceRequest = useCallback(async (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => {
    if (action === 'approve') await client.approveCredentialRequest(request.id);
    else await client.denyCredentialRequest(request.id);
    setPendingRequests((current) => current.filter(({ id }) => id !== request.id));
  }, [client]);
  const activePendingRequests = useMemo(
    () => pendingRequests.filter(({ workspace_id }) => workspace_id === activeWorkspaceId),
    [activeWorkspaceId, pendingRequests],
  );
  // THE ASK POPS WHERE THE PERSON IS. A pending credential request used to
  // wait in a list nobody opens; it opens `ConnectApprovalDialog` over the
  // workspace instead, one at a time, oldest first.
  //
  // "Not now" and the close button both land here: the request stays PENDING
  // on the server, so nothing is denied and the agent asks again. What is
  // waved off is this id, for this tab — the next ask is a new row with a new
  // id, and it pops.
  const [dismissedRequests, setDismissedRequests] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const askingRequest = activePendingRequests.find(({ id }) => !dismissedRequests.has(id)) ?? null;
  const closeTtydSession = (id: string) => {
    // The one place a terminal tab is CLOSED, from either strip. The tmux
    // session outlives its websocket by design — that is what a reload, a
    // workspace switch and a lost tunnel all re-attach to — so this is also
    // the one place that ends one, and nothing on an unmount may do it.
    const closingIndex = ttydSessions.findIndex((entry) => String(entry.id) === id);
    const closing = ttydSessions[closingIndex];
    const closingRegion = closing === undefined ? null : tabRegion(closing);
    const closingWasActive = closing !== undefined
      && activeWorkspaceTabs !== null
      && closingRegion !== null
      && regionActiveId(activeWorkspaceTabs, closingRegion) === closing.id;
    const closingWasRetained = retainedSessionIdsRef.current.ids.has(id);
    updateWorkspaceTabs((tabs) => {
      const tab = tabs.tabs.find((entry) => String(entry.id) === id);
      return tab === undefined ? tabs : closePaneTab(tabs, tab.id);
    });
    retainedSessionIdsRef.current.ids.delete(id);
    if (closing === undefined || !isManagedWorkspaceTab(closing) || activeFilesBase === null) return;
    void killTerminalSession(activeFilesBase, { type: closing.type, key: id }).then((killed) => {
      if (killed) return;
      updateWorkspaceTabs((tabs) => {
        if (tabs.tabs.some((entry) => entry.id === closing.id)) return tabs;
        const restored = [...tabs.tabs];
        restored.splice(Math.min(Math.max(closingIndex, 0), restored.length), 0, closing);
        const next = { ...tabs, tabs: restored };
        if (closingWasActive && closingRegion === 'main') next.activeId = closing.id;
        if (closingWasActive && closingRegion === 'side') next.sideActiveId = closing.id;
        return next;
      });
      if (
        closingWasRetained
        && retainedSessionIdsRef.current.workspaceId === activeWorkspaceId
      ) {
        retainedSessionIdsRef.current.ids.add(id);
      }
      setError('Could not close the terminal tab. Its session may still be running.');
    });
  };
  const renameTtydSession = (id: string, title: string | undefined) => {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) return;
    updateWorkspaceTabs((tabs) => renameTab(tabs, numericId, title));
  };
  // `useWorkspaceTabDrag` was here. Its only handle was a draggable tab button
  // in the native strip, so it went with the strip
  // (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2" — and see `workspace-panes.ts`).
  //
  // The machine's state AND whether the browser can reach its box (BUG-CV-02).
  // The reachability half costs no request: it is what the shell's own box
  // polls already learned. See `shell/workspace-status-line.ts`.
  const statusWorkspace = workspaceStatusLine(activeWorkspace?.lifecycleStatus, boxGateway);
  // The redesign cut the desktop statusline, which is where that sentence used
  // to be read. It keeps one desktop surface: a box the browser cannot reach is
  // the one thing the member must not keep clicking through.
  const boxUnreachable = boxGateway === 'unreachable';
  // The sign-in pair belongs to a terminal that is asking for it. One name for
  // that condition, so the bar's presence and its contents cannot disagree.
  const desktopTerminalSignInUrl = activeSessionUrl && ttydActiveTerminalType
    ? terminalSignInUrl
    : null;
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
      : 'waking · reattaching volume'
    : undefined;
  const workspaceErrored = activeWorkspace !== undefined && (
    activeWorkspace.lifecycleStatus === 'error'
    || (activeWorkspace.lifecycleStatus === 'parked' && activeWorkspace.errorDetail !== null)
  );
  // Terminals need a live box; previews and panels draw their own
  // unavailable states and stay mounted while the box wakes.
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
    const needsBox = session.type !== 'panel' && session.type !== 'preview';
    if (needsBox && !sessionsRenderable) return false;
    const sessionId = String(session.id);
    return sessionId === paneActiveId(surfaceRegion(session))
      || (
        retainedSessions.workspaceId === activeWorkspaceId
        && retainedSessions.ids.has(sessionId)
      );
  });
  // The terminal arm of the address, kept in step with the panes: a tab that is
  // gone, a tab the pane is not showing, and a layout with no strip to draw it
  // in. All three live in one hook; see `lody/use-terminal-address-sync.ts`.
  useTerminalAddressSync({
    enabled: surfaceTabsEnabled,
    mobile: mobileWebApp,
    tabsLoaded,
    tabs: ttydSessions,
    mainActiveId,
    sideActiveId,
    terminalId: addressTerminalId,
    sessionId: addressSessionId,
    focusPaneTab,
    openTerminal,
    openSession,
    openLanding,
    closeChat,
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
  /** What a column shows when its active tab cannot draw itself yet. Previews
   * and panels always draw themselves, so they never see this. */
  const paneFallback = (region: WorkspaceRegion): ReactNode => {
    const activeId = paneActiveId(region);
    const session = ttydSessions.find((entry) => String(entry.id) === activeId) ?? null;
    if (session !== null && (session.type === 'preview' || session.type === 'panel')) return null;
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
    // A STOPPED machine is not a loading one. The shell dials nothing while it
    // is stopped (`lifecycleStatusFor`), so a spinner here would never end;
    // the pane offers the one verb that ends it instead, in the main column.
    if (activeWorkspace.lifecycleStatus === 'stopped') {
      return region !== 'main' ? null : (
        <WorkspaceStoppedState workspaceName={activeWorkspace.title} onStart={startMyMachine} />
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
  const actionErrorNotice = error === null ? null : (
    <div className="webapp-notice" role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => setError(null)}>Dismiss</button>
    </div>
  );

  // ONE BODY PER TAB, IN EXACTLY ONE HOST
  // (plans/LODY-TERMINAL-TABS.md §4.6).
  //
  // A workspace tab's body is a `SurfaceTabContent`, and two of them for one
  // tab would be two ttyd sockets attaching the same tmux session. So the pane
  // grid and the session strip never draw it at the same time: while the
  // surface covers the panes it owns every body, and the moment the address
  // hands the view back to the panes (`/workspaces/:id`, from a bookmark) the
  // panes own them again. The switch costs one tmux re-attach, which is the
  // same event a page refresh already causes.
  //
  // IT IS ALSO WHAT THE PANE STRIPS FOLLOW (wave-3 finding F2). §4.6 named
  // `available` — the strip EXISTS — and that is a different question from
  // whether the strip is ON SCREEN. `/workspaces/:id` is `chat === null`, which
  // every bookmark, every workspace switch and every `navigateToWorkspacePage`
  // lands on, and there the surface is hidden: the panes had given their strip
  // away to a strip nobody could see, so a workspace full of terminals opened
  // with no tab control at all.
  const surfaceHostsTabs = surfaceTabsEnabled && lodyRail.visible;
  const paneSessions = surfaceHostsTabs ? NO_WORKSPACE_TABS : renderedSessions;
  const surfaceTabBody = (workspaceTabId: string): ReactNode => {
    // `renderedSessions` is the mount rule, unchanged: a tab that has never
    // been visited renders nothing, and a visited one stays mounted.
    const session = surfaceHostsTabs
      ? renderedSessions.find((tab) => String(tab.id) === workspaceTabId)
      : undefined;
    if (session === undefined) return null;
    return (
      <SurfaceTabContent
        session={session}
        active={lodyRail.terminalId === workspaceTabId}
        client={client}
        activeWorkspace={activeWorkspace}
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceRunning={activeWorkspaceRunning}
        activeSessionUrl={activeSessionUrl}
        activeFilesBase={activeFilesBase}
        pendingRequests={activePendingRequests}
        pendingRequestsError={pendingRequestsError}
        onResolveRequest={resolveWorkspaceRequest}
        onSignInUrl={setTerminalSignInUrl}
        onOpenPreview={openPreviewPort}
      />
    );
  };
  // Our Browser panel as a tab of Lody's side panel (seam patch 23), rebuilt
  // only when what it shows changes; the icon is the same glyph the strip's
  // button wears, in the size Lody's tab bar draws its own. Connections was
  // the second host tab and is a tab of the workspace-details dialog now.
  const hostTabs = useMemo<SessionHostSidePanelTab[]>(() => (
    activeWorkspaceId === ''
      ? []
      : [{
          id: BROWSER_SIDE_PANEL_ID,
          label: 'Browser',
          icon: sidePanelQuickActionIcon(BROWSER_SIDE_PANEL_ID, 'h-3.5 w-3.5 opacity-70'),
          content: (
            <div className="webapp-side-panel-host">
              <BrowserPanel
                target={browserTarget}
                filesBase={activeFilesBase}
                onNavigate={setBrowserTarget}
              />
            </div>
          ),
        }]
  ), [activeFilesBase, activeWorkspaceId, browserTarget]);
  const sidePanel = useMemo<SidePanelBinding | undefined>(() => (
    surfaceTabsEnabled
      ? {
          hostTabs,
          request: sidePanelRequest,
          onStateChange: setSidePanelState,
        }
      : undefined
  ), [hostTabs, setSidePanelState, sidePanelRequest, surfaceTabsEnabled]);
  // One press of the right icon strip. With a session on screen every button
  // is a request to Lody's side panel — a second press on the tab in front
  // closes it, and Side Chat launches rather than toggles.
  //
  // WITHOUT ONE, THE PRESS STILL LANDS. All four are session panels now, so
  // the press opens the most recent session first and is replayed into it by
  // the effect below. Only a member with NO session at all is left with
  // nothing to press — there is no session to show the files of — and the
  // strip says so.
  const runQuickAction = useCallback((action: SidePanelQuickAction) => {
    if (sidePanelDriven && sidePanelState !== null) {
      const showing = action !== 'side-session'
        && sidePanelState.open
        && sidePanelState.activeTabId === action;
      requestSidePanel(action, showing ? 'close' : 'open');
      return;
    }
    if (!surfaceTabsEnabled || mostRecentSessionId === null) return;
    // Held, not sent: `sidePanelRequest` is read by the session detail, and
    // there is none mounted yet. A press that replaced a held one is the
    // member changing their mind before the session arrived, so the last press
    // wins rather than queueing two panels.
    setPendingQuickAction(action);
    lodyRail.openSession(mostRecentSessionId);
  }, [
    lodyRail,
    mostRecentSessionId,
    requestSidePanel,
    sidePanelDriven,
    sidePanelState,
    surfaceTabsEnabled,
  ]);

  // The held press, once the session it was made for is on screen.
  //
  // The panel reports itself as soon as the detail mounts, which is exactly
  // when a request can be honoured — earlier is a request nothing reads, and
  // `handledSidePanelRequestSeqRef` would swallow the seq. A request for a
  // panel that session does not offer is ignored by the detail itself, so this
  // does not have to re-check `availableOptions`: it clears either way, because
  // a press is not a standing order.
  useEffect(() => {
    if (pendingQuickAction === null) return;
    if (!sidePanelDriven || sidePanelState === null) return;
    requestSidePanel(pendingQuickAction, 'open');
    setPendingQuickAction(null);
  }, [pendingQuickAction, requestSidePanel, sidePanelDriven, sidePanelState]);

  // A workspace switch drops it: the session it named is on the box being left.
  useEffect(() => {
    setPendingQuickAction(null);
    setMostRecentSessionId(null);
  }, [activeWorkspaceId]);
  const surfaceTabs: SurfaceTabsBinding | undefined = surfaceTabsEnabled
    ? {
        tabs: toSessionSurfaceTabs(ttydTabs, surfaceTabBody),
        activeTabId: addressTerminalId === null
          ? null
          : surfaceTabId(addressTerminalId),
        onSelect: (tabId) => {
          const workspaceTabId = workspaceTabIdFromSurfaceTabId(tabId);
          if (workspaceTabId !== null) selectTtydSession(workspaceTabId);
        },
        onClose: (tabId) => {
          const workspaceTabId = workspaceTabIdFromSurfaceTabId(tabId);
          if (workspaceTabId !== null) closeTtydSession(workspaceTabId);
        },
        // The strip left our tab for a conversation one. Nothing about the
        // workspace tab changes — it stays open, its tmux session stays
        // attached — only the ADDRESS gives the selection back to its host
        // page, which is what makes the conversation visible again.
        onDeselect: lodyRail.closeTerminal,
        // THE SESSION THIS STRIP WAS DRAWN IN DOES NOT EXIST (wave-3 F7).
        //
        // `SessionDetail` renders its not-found card and returns above the
        // strip, so every tab goes with it — the terminal the member was
        // looking at included, and its tmux session is still attached on the
        // box. The selection moves to the strip's OTHER host, the landing's,
        // which needs no session to be rooted in.
        //
        // WITH NO TERMINAL IN THE ADDRESS THE CARD STAYS. A dead session is
        // then the whole of what the member asked for, and the card is the
        // honest answer to it — the same one they get with the flag off.
        onSessionMissing: () => {
          if (addressTerminalId === null) return;
          if (!ttydSessions.some((tab) => String(tab.id) === addressTerminalId)) return;
          lodyRail.openTerminalOnLanding();
        },
      }
    : undefined;

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
      sessionsNeedNewerMachine={lodySessions === 'absent'}
      sessionsNeedMachine={lodySessions === 'noMachine'}
      sessionsStalled={lodySessions === 'stalled'}
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
      onOpenSettings={() => navigateToSettings('profile')}
      onSelectSession={selectTtydSession}
      onCloseSession={closeTtydSession}
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
  const dialogViewer = store.viewer;
  const railOverlays = (
    <>
    {accessProposals.active !== null && store.viewer !== null && (
      <AccessApprovalDialog
        key={accessProposals.active.id}
        client={client}
        proposal={accessProposals.active}
        viewer={{
          membershipId: store.viewer.membership.id,
          orgName: store.viewer.org.name || store.viewer.org.slug,
        }}
        workspaces={store.workspaces.map(({ id, title, members }) => ({ id, name: title, members }))}
        onClose={() => {
          if (accessProposals.active !== null) accessProposals.dismiss(accessProposals.active.id);
        }}
        onResolved={accessProposals.settled}
      />
    )}
    {/* One ask at a time: an access proposal and a connect request are the
      * same interruption, and two modals over each other is neither. */}
    {askingRequest !== null
      && accessProposals.active === null
      && activeWorkspace !== undefined
      && activeWorkspace !== null && (
      <ConnectApprovalDialog
        key={askingRequest.id}
        client={client}
        request={askingRequest}
        workspace={{
          id: activeWorkspace.id,
          name: activeWorkspace.title,
          members: activeWorkspace.members,
        }}
        onDismiss={() => setDismissedRequests(
          (current) => new Set([...current, askingRequest.id]),
        )}
        onConnected={(request) => {
          // The workspace may pull it now, so the request that asked is
          // answered and the records are re-read for the allow-list this
          // shell holds.
          void resolveWorkspaceRequest(request, 'approve');
          void refreshWorkspaceRecords();
        }}
      />
    )}
    {dialogViewer !== null && <ShellDialogs
      client={client}
      viewer={dialogViewer}
      workspaces={store.workspaces}
      showCreateOrg={showCreateOrg}
      createOrgName={createOrgName}
      onCreateOrgNameChange={setCreateOrgName}
      onCreateOrg={createOrganizationFromDialog}
      onCloseCreateOrg={closeCreateOrganization}
      showCreateWorkspace={showCreateWorkspace}
      listMachineTypes={listMachineTypes}
      commitWorkspaceMutation={commitWorkspaceMutation}
      cloneFromWorkspaceId={cloneFromWorkspaceId}
      onCancelCreateWorkspace={closeCreateWorkspace}
      onCreateWorkspace={(input) => { void createWorkspace(input, dialogViewer); }}
      details={details}
      onCloseDetails={() => setDetails(null)}
      machineWorkspaceId={machineWorkspaceId}
      onCloseMachine={() => setMachineWorkspaceId(null)}
      onCloneWorkspace={(workspaceId) => {
        // The create dialog carries the source, and the server copies its config.
        setDetails(null);
        setCloneFromWorkspaceId(workspaceId);
        setShowCreateWorkspace(true);
      }}
      onRequestDeleteWorkspace={requestDeleteWorkspace}
      confirmation={confirmation}
      onCancelConfirmation={cancelConfirmation}
      onConfirmDelete={confirmWebAppAction}
    />}
    </>
  );
  if (signedOut || signOutPending) {
    return (
      <>
        <LoginForm loginUrl={api.googleLoginUrl()} />
        {actionErrorNotice}
      </>
    );
  }

  if (organizationTransitionStage !== null) {
    return (
      <main
        ref={shellRef}
        className="webapp-shell webapp-shell--booting"
        aria-busy="true"
      >
        <WebAppLoadingShell
          stage={organizationTransitionStage}
          mobile={mobileWebApp}
          drawerOpen={drawerOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onCloseDrawer={() => setDrawerOpen(false)}
        />
        {actionErrorNotice}
        {updateNotice}
      </main>
    );
  }

  if (identityOnly !== null) {
    return (
      <>
        <CreateOrgPage
          name={createOrgName}
          onNameChange={setCreateOrgName}
          onCreate={createOrganizationFromIdentity}
        />
        {actionErrorNotice}
      </>
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
        onNavigateToSettings={navigateToSettings}
        onLeaveSettings={returnToWebApp}
        onSignOut={signOut}
        onLeftOrg={leaveOrganization}
        onSwitchOrg={switchOrganization}
        onCreateOrg={openCreateOrganization}
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
        {actionErrorNotice}
        {updateNotice}
      </main>
    );
  }

  return (
    <main
      ref={shellRef}
      className="app-shell app-shell--workspace"
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

      <div className="app-workspace-frame">
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
              sessions={lodySessions}
              viewerName={store.viewer?.identity.name ?? 'You'}
              viewerAvatarUrl={store.viewer?.identity.avatarUrl ?? null}
              workspaceTitle={activeWorkspace?.title ?? 'Workspace'}
              visible={lodyRail.visible}
              railHost={lodyRail.railHost}
              onOpenSession={lodyRail.openSession}
              onOpenLanding={openFreshLanding}
              onOpenArchive={lodyRail.openArchive}
              onMostRecentSessionChange={setMostRecentSessionId}
              newTabControl={(
                <NewTabControl
                  variant="footer"
                  livePorts={orderedLivePorts}
                  previewLinks={orderedPreviewLinks}
                  onSpawnSession={spawnTtydSession}
                  onOpenPreview={(port) => { openPreviewPort(port); }}
                  onOpenPreviewLink={(url, title) => { openPreviewLink(url, title); }}
                />
              )}
              onApiReady={setLodyApi}
              onActiveSessionChange={lodyRail.mirror}
              desiredSessionId={lodyRail.sessionId}
              desiredArchive={lodyRail.archive}
              {...(lodyRail.sessionId === null ? {} : { initialSessionId: lodyRail.sessionId })}
              onShareSession={setSharingSessionId}
              sharedSessions={sharedSessions.rows}
              sharedOpen={sharedSessions.open}
              onSelectSharedSession={(row) => {
                lodyRail.openSharedSession(row.ownerMembershipId, row.sessionId);
              }}
              {...(surfaceTabs === undefined ? {} : { surfaceTabs })}
              {...(sidePanel === undefined ? {} : { sidePanel })}
            />
            <WorkPanes
              client={client}
              panesRef={panesRef}
              visibleRegions={visibleRegions}
              renderedSessions={paneSessions}
              surfaceRegion={surfaceRegion}
              paneActiveId={paneActiveId}
              paneFallback={paneFallback}
              sidePaneWidth={activeFiles.width}
              paneResizing={paneResizing}
              sessionsPending={sessionPlanePending}
              mobile={mobileWebApp}
              drawerOpen={drawerOpen}
              canEditWorkspaceLayout={canEditWorkspaceLayout}
              activeWorkspace={activeWorkspace}
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceRunning={activeWorkspaceRunning}
              activeSessionUrl={activeSessionUrl}
              activeFilesBase={activeFilesBase}
              livePorts={orderedLivePorts}
              previewLinks={orderedPreviewLinks}
              pendingRequests={activePendingRequests}
              pendingRequestsError={pendingRequestsError}
              onOpenDrawer={() => setDrawerOpen(true)}
              onOpenPreview={openPreviewPort}
              onOpenPreviewLink={openPreviewLink}
              onResolveRequest={resolveWorkspaceRequest}
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
          </section>

          {/* The statusline is mobile chrome: the touch terminal's paste /
            * enter / keyboard controls and the drawer toggle, which mobile has
            * no rail strip to carry. Desktop dropped the bar (owner annotation
            * 2026-09-01: wasted space — the rail strip already owns the drawer
            * toggle and the pending badge, and the strip names the workspace).
            * The two desktop remnants are the transient sign-in pair, because
            * the terminal OAuth hop has no other affordance, and BUG-CV-02's
            * sentence, because an unreachable box has no other surface. */}
          {(mobileWebApp
            ? Boolean(activeWorkspace)
            : boxUnreachable || desktopTerminalSignInUrl !== null) && (
            <footer
              className="webapp-statusline"
              aria-label={mobileWebApp
                ? 'Workspace actions'
                : boxUnreachable ? 'Workspace status' : 'Terminal sign-in'}
            >
              {!mobileWebApp && boxUnreachable && (
                <span className="webapp-statusline__box" role="status" aria-live="polite">
                  {statusWorkspace}
                </span>
              )}
              {!mobileWebApp && desktopTerminalSignInUrl && (
                <>
                  <button
                    className="webapp-statusline__sign-in"
                    type="button"
                    onClick={() => window.open(desktopTerminalSignInUrl, '_blank', 'noopener')}
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
          sidePanel={sidePanelDriven ? sidePanelState : null}
          // What a press opens a session panel IN while none is on screen. Null
          // with the surface off, on a box that serves no daemon, and for a
          // member who has not started a session yet — the three cases where
          // there is genuinely nothing to open.
          landingSessionId={surfaceTabsEnabled ? mostRecentSessionId : null}
          onQuickAction={runQuickAction}
        />
      )}

      {actionErrorNotice}
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
    </main>
  );
}

/** One action-error host for every first-party screen. Lody keeps its own
 * provider tree and error surfaces inside the lazy-loaded session region. */
export default function CloudApp(props: CloudAppProps) {
  return (
    <ErrorReporterProvider>
      <CloudAppContent {...props} />
    </ErrorReporterProvider>
  );
}
