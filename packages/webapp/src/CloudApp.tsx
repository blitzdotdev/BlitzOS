import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createClient, type WebDAVClient } from 'webdav';
import {
  ApiAdapter,
  ApiError,
} from './api-adapter';
import type { ControlPlaneClient } from './api';
import type { CredentialRequestView } from '@blitzos/schema';
import {
  WebAppHeader,
  SPAWN_SESSION_LABELS,
  type WebAppTabModel,
  type SpawnSessionType,
} from './WebAppHeader';
import { FileIcon } from './WebAppIcons';
import { DriveHome } from './files/DriveHome';
import { DriveRail } from './files/DriveRail';
import { WorkspaceSharedFolders } from './files/WorkspaceSharedFolders';
import { DriveAvatar } from './files/DriveAvatar';
import { KebabGlyph, ShareGlyph, TrashGlyph } from './files/DriveIcons';
import type { DriveCommand } from './files/FilesDrive';
import {
  CreateWorkspaceDialog,
  type CreateWorkspaceDialogInput,
} from './CreateWorkspaceDialog';
import { ConfirmationDialog } from './ConfirmationDialog';
import { caughtErrorMessage } from './error-message';
import {
  WebAppLoadingPane,
  WebAppLoadingShell,
} from './LoadingSkeleton';
import { machineTypeLabel } from './MachineCatalogGrid';
import { SettingsHeader, SettingsPage } from './SettingsPage';
import { ShareWorkspaceDialog } from './ShareWorkspaceDialog';
import {
  bindVisualViewportGeometry,
  useMobileWebApp,
} from './mobile-webapp';
import {
  drivePath,
  folderPagePath,
  parseAppRoute,
  settingsPath,
  workspacePath,
  type SettingsSection,
} from './sessions-page-state';
import {
  defaultWorkspaceFiles,
  removeDismissedChatAuthProviders,
  type StorageNamespace,
  type WorkspaceDrawerSegment,
  type WorkspaceTab,
} from './storage';
import { TERMINAL_KEYBOARD_EVENT, TERMINAL_PASTE_EVENT } from './terminal-touch';
import { terminalPastePayload } from './terminal-paste';
import { ChatPanel } from './chat/ChatPanel';
import { TERMINAL_SUBMIT_EVENT, TtydTerminal } from './TtydTerminal';
import { WorkspaceErrorState } from './WorkspaceErrorState';
import { FileEditor } from './FileEditor';
import { FilesSidebar } from './FilesSidebar';
import { fullDavPath } from './files';
import { dropPasteText, uploadDroppedFiles } from './file-drop';
import {
  initialWorkspaceStore,
  selectControllableWorkspaceId,
  workspaceReducer,
} from './workspace-store';
import { PreviewPanel } from './PreviewPanel';
import {
  fetchWorkspacePorts,
  initialPortsState,
  isPreviewPort,
  newestPorts,
  PORTS_POLL_INTERVAL_MS,
  portsReducer,
} from './preview';
import { decideUpdateAction, extractIndexAsset } from './update-check';
import { LoginForm } from './components/LoginForm';
import { CreateOrgPage } from './components/CreateOrgPage';
import type { IdentityRecord } from './protocol';
import type { EndpointResolver } from './resolver';
import { WorkspaceDrawer } from './WorkspaceDrawer';
import {
  rememberWorkspaceEndpoints,
  type WorkspaceEndpoints,
} from './workspace-endpoints';
import { useWorkspacePersistence } from './use-workspace-persistence';
import {
  useWorkspaceBootstrap,
  useWorkspacePolling,
} from './use-workspace-lifecycle';

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

type WebAppConfirmation = {
  workspaceId: string;
  label: string;
};

type FileCloseConfirmation = {
  id: string;
  label: string;
};

function PasteCodeModal({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (payload: { data: string; enters: number }) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const canSend = text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    // Paste-code submits the raw text; the terminal layer then sends Enter
    // twice, each gated on the pty responding (echo, then the next screen) —
    // bundling \r with the text makes Claude's input treat it as pasted
    // content and swallow the submit.
    onSend({ data: terminalPastePayload(text.trim(), false), enters: 2 });
  };

  return (
    <div className="terminal-prompt-scrim" role="presentation" onClick={onCancel}>
      <div
        className="terminal-prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Paste code"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="terminal-prompt-modal__title">Paste code</p>
        <input
          ref={inputRef}
          className="terminal-prompt-modal__input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Paste the code here"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send();
          }}
        />
        <div className="terminal-prompt-modal__actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" disabled={!canSend} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}

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
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [shareWorkspaceId, setShareWorkspaceId] = useState<string | null>(null);
  const [driveCommand, setDriveCommand] = useState<DriveCommand | null>(null);
  const [driveUploadTarget, setDriveUploadTarget] = useState<string | null>(null);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<WebAppConfirmation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [terminalSignInUrl, setTerminalSignInUrl] = useState<string | null>(null);
  const [showPasteCodeModal, setShowPasteCodeModal] = useState(false);
  const [dirtyFileIds, setDirtyFileIds] = useState<Set<string>>(new Set());
  const [fileCloseConfirmation, setFileCloseConfirmation] = useState<FileCloseConfirmation | null>(null);
  const [filesRefreshVersion, setFilesRefreshVersion] = useState(0);
  const [portsState, dispatchPorts] = useReducer(portsReducer, initialPortsState);
  const [portsMenuOpen, setPortsMenuOpen] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<CredentialRequestView[]>([]);
  const [pendingRequestsError, setPendingRequestsError] = useState<string | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const storeRef = useRef(store);
  const workspaceEndpoints = useRef(new Map<string, WorkspaceEndpoints>());
  const firstWorkspacePrompted = useRef(false);
  // Visit once, then retain: tab switches preserve live state without eagerly
  // opening every saved terminal, WebGL surface, and chat SDK connection.
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
  const listVolumes = useCallback(() => api.listVolumes(), [api]);
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
  const activeAcpUrl = activeWorkspaceRunning ? activeIngressEntry?.acpUrl ?? null : null;
  const activeFilesBase = activeWorkspaceRunning ? activeIngressEntry?.filesBase ?? null : null;
  const activeFiles = workspaceFiles.workspaceId === activeWorkspaceId
    ? workspaceFiles.value
    : defaultWorkspaceFiles();
  const filesOpen = mobileWebApp ? filesDrawerOpen : activeFiles.open;

  useEffect(() => {
    dispatchPorts({ type: 'reset', workspaceId: activeWorkspaceId });
    setPortsMenuOpen(false);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (
      route.page !== 'webApp'
      || !portsMenuOpen
      || !activeWorkspaceRunning
      || !activeFilesBase
      || !activeWorkspaceId
    ) return;
    let disposed = false;
    let request: AbortController | null = null;
    const poll = async () => {
      if (request || document.visibilityState !== 'visible') return;
      request = new AbortController();
      const current = request;
      const ports = await fetchWorkspacePorts(activeFilesBase, fetch, current.signal);
      if (!disposed && request === current && !current.signal.aborted) {
        dispatchPorts({
          type: 'received',
          workspaceId: activeWorkspaceId,
          ports,
          now: Date.now(),
        });
      }
      if (request === current) request = null;
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, PORTS_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
    };
  }, [activeFilesBase, activeWorkspaceId, activeWorkspaceRunning, portsMenuOpen, route.page]);

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
    return createClient(activeFilesBase, { withCredentials: true });
  }, [activeFilesBase]);
  const getFilesClient = useCallback((): WebDAVClient | null => {
    const workspaceId = activeWorkspaceIdRef.current;
    const workspace = storeRef.current.workspaces.find(({ id }) => id === workspaceId);
    const filesBase = workspaceEndpoints.current.get(workspaceId)?.filesBase;
    if (workspace?.lifecycleStatus !== 'running' || !filesBase) return null;
    return createClient(filesBase, { withCredentials: true });
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
    setRoute({ workspaceId, page: 'webApp' });
  }, []);

  const navigateTo = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(parseAppRoute(path));
  }, []);

  const navigateToSettings = useCallback((
    section: SettingsSection,
    requestedIntegrationName?: string,
  ) => {
    const path = settingsPath(section);
    const target = requestedIntegrationName
      ? `${path}?add=${encodeURIComponent(requestedIntegrationName)}`
      : path;
    window.history.pushState({}, '', target);
    setRoute({ workspaceId: null, page: 'settings', settingsSection: section });
  }, []);

  const returnToWebApp = useCallback(() => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (workspaceId && storeRef.current.workspaces.some(({ id, canControl }) => id === workspaceId && canControl)) {
      navigateToWorkspacePage(workspaceId);
      return;
    }
    window.history.pushState({}, '', '/');
    setRoute({ workspaceId: null, page: 'drive', scope: 'mine' });
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
        setRoute({ workspaceId: null, page: 'drive', scope: 'mine' });
      }
    }
    void api.deleteWorkspace(workspaceId)
      .then(() => {
        if (storageNamespace) {
          removeDismissedChatAuthProviders(storageNamespace, workspaceId);
        }
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
  }, [api, navigateToWorkspacePage, storageNamespace]);

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

  const createWorkspace = useCallback(async (input: CreateWorkspaceDialogInput) => {
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const record = await api.createWorkspace(input);
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
  }, [api, navigateToWorkspacePage, resolver]);

  const toggleFiles = useCallback(() => {
    if (!activeWorkspaceId) return;
    if (mobileWebApp) {
      setDrawerOpen(false);
      setFilesDrawerOpen((open) => !open);
      return;
    }
    setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
      ? { ...current, value: { ...current.value, open: !current.value.open } }
      : current);
  }, [activeWorkspaceId, mobileWebApp]);

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
    deleteWorkspace(request.workspaceId);
  }, [confirmation, deleteWorkspace]);

  const isSettingsRoute = route.page === 'settings';

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
  const activeWorkspaceTabs = workspaceTabs.workspaceId === activeWorkspaceId
    && workspaceTabs.loaded
    ? workspaceTabs.value
    : null;
  const ttydSessions = activeWorkspaceTabs?.tabs ?? [];
  const ttydActiveId = activeWorkspaceTabs?.activeId === null
    || activeWorkspaceTabs?.activeId === undefined
    ? null
    : String(activeWorkspaceTabs.activeId);
  useEffect(() => {
    if (retainedSessionIdsRef.current.workspaceId !== activeWorkspaceId) {
      retainedSessionIdsRef.current = { workspaceId: activeWorkspaceId, ids: new Set() };
    }
    if (ttydActiveId !== null) retainedSessionIdsRef.current.ids.add(ttydActiveId);
  }, [activeWorkspaceId, ttydActiveId]);
  const tabsLoaded = activeWorkspaceTabs !== null;
  const ttydLabel = (session: WorkspaceTab) => session.type === 'file'
    ? session.filePath
    : session.type === 'preview'
      ? `:${session.port}`
      : (
        session.type === 'chat'
        || session.type === 'claude'
        || session.type === 'codex'
        || session.type === 'terminal'
          ? SPAWN_SESSION_LABELS[session.type]
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
      if (session.type !== 'file') {
        if (session.type === 'preview') {
          return {
            id: String(session.id),
            label: ttydLabel(session),
            agent: session.type,
            pending: false,
          };
        }
        return {
          id: String(session.id),
          label: ttydLabel(session),
          agent: session.type,
          pending: false,
        };
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
  const addWorkspaceTab = (createTab: (id: number) => WorkspaceTab) => {
    setWorkspaceTabs((current) => {
      if (current.workspaceId !== activeWorkspaceId || !current.loaded) return current;
      const id = current.value.nextId;
      return {
        ...current,
        value: {
          ...current.value,
          tabs: [...current.value.tabs, createTab(id)],
          activeId: id,
          nextId: id + 1,
        },
      };
    });
  };
  const spawnTtydSession = (type: SpawnSessionType) => {
    addWorkspaceTab((id) => type === 'chat'
      ? { id, type, chatProvider: 'claude' }
      : { id, type });
  };
  const openFile = (filePath: string) => {
    const existing = ttydSessions.find(
      (session) => session.type === 'file' && session.filePath === filePath,
    );
    if (existing) {
      selectTtydSession(String(existing.id));
    } else {
      addWorkspaceTab((id) => ({ id, type: 'file', filePath }));
    }
    if (mobileWebApp) setFilesDrawerOpen(false);
  };
  const selectTtydSession = (id: string) => {
    setWorkspaceTabs((current) => {
      if (
        current.workspaceId !== activeWorkspaceId
        || !current.loaded
      ) return current;
      const activeId = current.value.tabs.find((tab) => String(tab.id) === id)?.id;
      return activeId === undefined ? current : {
        ...current,
        value: { ...current.value, activeId },
      };
    });
  };
  const livePorts = portsState.workspaceId === activeWorkspaceId ? portsState.ports : [];
  const orderedLivePorts = useMemo(() => newestPorts(livePorts), [livePorts]);
  const openPreviewPort = (port: number) => {
    if (!isPreviewPort(port)) return false;
    const existing = ttydSessions.find((tab) => tab.type === 'preview' && tab.port === port);
    if (existing) {
      selectTtydSession(String(existing.id));
    } else {
      addWorkspaceTab((id) => ({ id, type: 'preview', port }));
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
    setWorkspaceTabs((current) => {
      if (current.workspaceId !== activeWorkspaceId || !current.loaded) return current;
      const numericId = current.value.tabs.find((tab) => String(tab.id) === id)?.id;
      if (numericId === undefined) return current;
      const index = current.value.tabs.findIndex((tab) => tab.id === numericId);
      const remaining = current.value.tabs.filter((tab) => tab.id !== numericId);
      if (index < 0) return current;
      return {
        ...current,
        value: {
          ...current.value,
          tabs: remaining,
          activeId: numericId === current.value.activeId
            ? remaining[Math.min(index, remaining.length - 1)]?.id ?? null
            : current.value.activeId,
        },
      };
    });
    setDirtyFileIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
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
  const rememberChatSession = (
    id: string,
    chatSessionId: string | undefined,
    chatProvider: 'claude' | 'codex',
  ) => {
    setWorkspaceTabs((current) => {
      if (current.workspaceId !== activeWorkspaceId || !current.loaded) return current;
      const numericId = current.value.tabs.find((tab) => String(tab.id) === id)?.id;
      if (numericId === undefined) return current;
      const tab = current.value.tabs.find((entry) => entry.id === numericId);
      if (
        tab?.type !== 'chat'
        || (tab.chatSessionId === chatSessionId && tab.chatProvider === chatProvider)
      ) return current;
      return {
        ...current,
        value: {
          ...current.value,
          tabs: current.value.tabs.map((entry) => entry.id === numericId && entry.type === 'chat'
            ? {
                ...entry,
                ...(chatSessionId ? { chatSessionId } : { chatSessionId: undefined }),
                chatProvider,
              }
            : entry),
        },
      };
    });
  };
  const statusWorkspace = activeWorkspace
    ? `workspace ${activeWorkspace.lifecycleStatus}`
    : 'workspace pending';
  const hasControllableWorkspace = store.workspaces.some(({ canControl }) => canControl);
  const isDriveRoute = route.page === 'drive' || route.page === 'folder';
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
  const activeFilePane = ttydActiveType === 'file' && filesClient !== null;
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

  const railFor = (scope: 'mine' | 'shared' | null, railActiveWorkspaceId: string | null) => (
    <DriveRail
      workspaces={store.workspaces}
      activeWorkspaceId={railActiveWorkspaceId}
      driveScope={scope}
      identity={store.viewer?.identity ?? null}
      org={store.viewer?.org ?? null}
      organizations={store.viewer?.organizations.map(({ org }) => org) ?? []}
      uploadTargetName={driveUploadTarget}
      onOpenDrive={(nextScope) => navigateTo(drivePath(nextScope))}
      onSelectWorkspace={selectWorkspace}
      onCreateWorkspace={() => setShowCreateWorkspace(true)}
      onNewFolder={() => {
        if (isDriveRoute) setDriveCommand({ kind: 'new-folder', nonce: Date.now() });
        else navigateTo(drivePath('mine'));
      }}
      onUploadFile={() => setDriveCommand({ kind: 'upload', nonce: Date.now() })}
      onSwitchOrg={(orgId) => {
        void client.switchOrg(orgId).then(() => window.location.reload());
      }}
      onOpenSettings={() => navigateToSettings('profile')}
      onSignOut={() => { void signOut(); }}
      drawerOpen={drawerOpen}
      onCloseDrawer={() => setDrawerOpen(false)}
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

  if (isDriveRoute && (route.page === 'drive' || route.page === 'folder')) {
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {railFor(route.page === 'drive' ? route.scope : null, null)}
        {loaded && store.viewer ? (
          <DriveHome
            client={client}
            viewer={store.viewer}
            route={route}
            command={driveCommand}
            onNavigate={navigateTo}
            onUploadTarget={setDriveUploadTarget}
            onOpenRail={() => setDrawerOpen(true)}
          />
        ) : (
          <div className="drive-content">
            <div className="drive-empty" role="status">Loading…</div>
          </div>
        )}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {updateNotice}
        {showCreateWorkspace && (
          <CreateWorkspaceDialog
            busy={createWorkspaceBusy}
            error={createWorkspaceError}
            listMachineTypes={listMachineTypes}
            listVolumes={listVolumes}
            onCancel={() => {
              if (!createWorkspaceBusy) setShowCreateWorkspace(false);
            }}
            onSubmit={(input) => { void createWorkspace(input); }}
          />
        )}
        {confirmation && (
          <ConfirmationDialog
            title="Delete workspace?"
            description={`Are you sure you want to delete “${confirmation.label}”? This destroys the workspace and cannot be undone.`}
            confirmLabel="Yes, delete"
            cancelLabel="No"
            onCancel={cancelConfirmation}
            onConfirm={confirmWebAppAction}
          />
        )}
      </main>
    );
  }

  if (isSettingsRoute) {
    return (
      <main className="settings-shell" aria-busy={!loaded}>
        <SettingsHeader
          workspaceLabel={activeWorkspace?.title}
          onBack={returnToWebApp}
        />
        {loaded && store.viewer ? (
          <SettingsPage
            client={client}
            viewer={store.viewer}
            section={route.settingsSection}
            requestedIntegrationName={new URLSearchParams(window.location.search).get('add') ?? undefined}
            onNavigate={navigateToSettings}
            onConfigureIntegration={(name) => navigateToSettings('integrations', name)}
            onSignOut={signOut}
          />
        ) : (
          <div className="settings-page-state settings-page-state--loading" role="status">
            Loading settings…
          </div>
        )}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {updateNotice}
      </main>
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
        if (!event.dataTransfer.types.includes('Files')) return;
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
        if (!event.dataTransfer.types.includes('Files')) return;
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
      {railFor(null, activeWorkspaceId)}
      {shareWorkspaceId && (() => {
        const workspace = store.workspaces.find(({ id }) => id === shareWorkspaceId);
        return workspace ? <ShareWorkspaceDialog client={client} workspaceId={workspace.id} workspaceName={workspace.title} onClose={() => setShareWorkspaceId(null)} /> : null;
      })()}

      <div className="drive-ws-frame">
          {activeWorkspace && (
            <div className="drive-ws-head">
              <button
                className="drive-icon-button drive-topbar-menu"
                type="button"
                aria-label="Open navigation"
                onClick={() => setDrawerOpen(true)}
              >
                <span className="mi-menu" aria-hidden="true" />
              </button>
              <h1>{activeWorkspace.title}</h1>
              <span
                className={`drive-ws-dot${activeWorkspace.lifecycleStatus === 'running' ? ' drive-ws-dot--online' : ''}`}
              />
              <span className="drive-ws-meta">
                {activeWorkspace.lifecycleStatus}
                {activeWorkspace.machineType ? ` · ${machineTypeLabel(activeWorkspace.machineType)}` : ''}
              </span>
              {activeWorkspace.accessRole !== 'owner' && activeWorkspace.owner && (
                <span className="drive-ws-owner">
                  <DriveAvatar name={activeWorkspace.owner.name} avatarUrl={activeWorkspace.owner.avatarUrl} />
                  shared by {activeWorkspace.owner.name}
                </span>
              )}
              {(activeWorkspace.accessRole === 'owner' || activeWorkspace.accessRole === 'admin') && (
                <button
                  className="drive-icon-button"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={wsMenuOpen}
                  aria-label={`Actions for ${activeWorkspace.title}`}
                  style={activeWorkspace.accessRole === 'owner' && !activeWorkspace.owner ? { marginLeft: 'auto' } : undefined}
                  onClick={() => setWsMenuOpen((open) => !open)}
                >
                  <KebabGlyph />
                </button>
              )}
              {wsMenuOpen && activeWorkspace && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    style={{ position: 'fixed', inset: 0, zIndex: 190, border: 0, background: 'transparent', cursor: 'default' }}
                    onClick={() => setWsMenuOpen(false)}
                  />
                  <div className="drive-menu" role="menu" style={{ right: 24, top: 52 }}>
                    <button
                      className="drive-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => { setWsMenuOpen(false); setShareWorkspaceId(activeWorkspace.id); }}
                    >
                      <ShareGlyph /><span>Share workspace</span>
                    </button>
                    <div className="drive-menu-divider" />
                    <button
                      className="drive-menu-item drive-menu-item--danger"
                      type="button"
                      role="menuitem"
                      onClick={() => { setWsMenuOpen(false); requestDeleteWorkspace(activeWorkspace.id); }}
                    >
                      <TrashGlyph /><span>Delete workspace</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <WebAppHeader
            tabs={ttydTabs}
            activeSessionId={ttydActiveId ?? ''}
            sessionBusy={false}
            terminalDisabled={workspaceWaking || !tabsLoaded}
            mobile={mobileWebApp}
            paneStrips={false}
            drawerOpen={drawerOpen}
            onOpenDrawer={() => {
              setFilesDrawerOpen(false);
              setDrawerOpen(true);
            }}
            onSelect={selectTtydSession}
            onClose={closeTtydSession}
            onSpawn={spawnTtydSession}
            livePorts={orderedLivePorts}
            onOpenPreview={openPreviewPort}
            onMenuOpenChange={setPortsMenuOpen}
          />

          <section className="webapp-workspace-view">
            <div className="webapp-workspace-main">
              {ttydSessions.map((session) => session.type === 'preview' && (
                <div
                  key={session.id}
                  hidden={ttydActiveId !== String(session.id)}
                  style={ttydActiveId === String(session.id) ? { display: 'contents' } : undefined}
                >
                  <PreviewPanel
                    port={session.port}
                    filesBase={activeFilesBase}
                    running={activeWorkspaceRunning}
                  />
                </div>
              ))}
              <div
                className="webapp-workspace-pane"
                hidden={activeFilePane || ttydActiveType === 'preview'}
              >
                {activeWorkspace?.lifecycleStatus === 'error'
                  || (
                    activeWorkspace?.lifecycleStatus === 'parked'
                    && activeWorkspace.errorDetail
                  ) ? (
                  <WorkspaceErrorState
                    workspaceName={activeWorkspace.title}
                    errorDetail={activeWorkspace.errorDetail}
                    retryAction={activeWorkspace.retryAction}
                    onRetry={() => retryWorkspace(activeWorkspace.id)}
                  />
                ) : activeSessionUrl ? (
                  workspaceProvisioning && activeWorkspace ? (
                    <WebAppLoadingPane
                      ariaLabel={activeWorkspace.lifecycleStatus === 'creating'
                        ? 'Creating workspace'
                        : 'Provisioning workspace'}
                      stage={activeWorkspace.lifecycleStatus === 'creating'
                        ? `allocating · ${activeWorkspace.machineType
                          ? machineTypeLabel(activeWorkspace.machineType)
                          : 'workspace VM'}`
                        : `starting · ${activeWorkspace.machineType
                          ? machineTypeLabel(activeWorkspace.machineType)
                          : 'workspace VM'}`}
                    />
                  ) : !tabsLoaded ? (
                    <WebAppLoadingPane
                      ariaLabel="Loading workspace"
                      stage="loading · local tabs"
                    />
                  ) : (
                    ttydSessions
                      .filter((session) => (
                        String(session.id) === ttydActiveId
                        || (
                          retainedSessionIdsRef.current.workspaceId === activeWorkspaceId
                          && retainedSessionIdsRef.current.ids.has(String(session.id))
                        )
                      ))
                      .sort((left, right) => Number(String(right.id) === ttydActiveId)
                        - Number(String(left.id) === ttydActiveId))
                      .map((session) => {
                        const sessionId = String(session.id);
                        const active = ttydActiveId === sessionId;
                        if (session.type === 'chat') {
                          return (
                            <div key={sessionId} hidden={!active} className="webapp-workspace-session">
                              <ChatPanel
                                url={activeAcpUrl ?? ''}
                                workspaceId={activeWorkspaceId}
                                initialSessionId={session.chatSessionId ?? null}
                                onSessionId={(_workspaceId, chatSessionId) => {
                                  rememberChatSession(sessionId, chatSessionId, 'claude');
                                }}
                                onOpenPreview={openPreviewPort}
                                readOnly={activeWorkspace?.accessRole === 'viewer'}
                              />
                            </div>
                          );
                        }
                        if (session.type === 'file' || session.type === 'preview') return null;
                        return (
                          <div key={sessionId} hidden={!active} className="webapp-workspace-session">
                            <TtydTerminal
                              url={activeSessionUrl}
                              sessionType={session.type}
                              sessionKey={sessionId}
                              active={active}
                              readOnly={activeWorkspace?.accessRole === 'viewer'}
                              onSignInUrl={setTerminalSignInUrl}
                              onOpenPreview={openPreviewPort}
                            />
                          </div>
                        );
                      })
                  )
                ) : activeWorkspace ? (
                  <WebAppLoadingPane
                    ariaLabel={workspaceProvisioning
                      ? activeWorkspace.lifecycleStatus === 'creating'
                        ? 'Creating workspace'
                        : 'Provisioning workspace'
                      : workspaceWaking ? 'Waking workspace'
                      : 'Loading workspace'}
                    stage={workspaceProvisioning
                      ? activeWorkspace.lifecycleStatus === 'creating'
                        ? `allocating · ${activeWorkspace.machineType
                          ? machineTypeLabel(activeWorkspace.machineType)
                          : 'workspace VM'}`
                        : `starting · ${activeWorkspace.machineType
                          ? machineTypeLabel(activeWorkspace.machineType)
                          : 'workspace VM'}`
                      : workspaceWakingStage ?? 'starting · workspace terminal'}
                  />
                ) : (
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
                )}
              </div>
              {ttydSessions
                .filter((session) => session.type === 'file')
                .map((session) => (
                  <div
                    className="webapp-workspace-pane"
                    hidden={ttydActiveId !== String(session.id) || filesClient === null}
                    key={session.id}
                  >
                    <FileEditor
                      active={ttydActiveId === String(session.id)}
                      client={filesClient}
                      filePath={session.filePath}
                      unavailableStage={workspaceWakingStage}
                      onDirtyChange={(dirty) => updateFileDirty(String(session.id), dirty)}
                      onSaved={() => setFilesRefreshVersion((version) => version + 1)}
                      onTreeRefresh={() => setFilesRefreshVersion((version) => version + 1)}
                      onUnauthorized={handleUnauthorized}
                    />
                  </div>
                ))}
            </div>
            {activeWorkspace && (mobileWebApp || activeFiles.open) && (
              <WorkspaceDrawer
                client={client}
                workspaceId={activeWorkspace.id}
                mobile={mobileWebApp}
                open={filesOpen}
                width={activeFiles.width}
                segment={activeFiles.segment}
                pendingRequests={activePendingRequests}
                pendingRequestsError={pendingRequestsError}
                canManageCredentials={activeWorkspace.accessRole === 'owner' || activeWorkspace.accessRole === 'admin'}
                onWidthChange={(width) => {
                  setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
                    ? { ...current, value: { ...current.value, width } }
                    : current);
                }}
                onSegmentChange={(segment: WorkspaceDrawerSegment) => {
                  setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
                    ? { ...current, value: { ...current.value, segment } }
                    : current);
                }}
                onResolveRequest={resolveWorkspaceRequest}
                files={(
                  <>
                  <FilesSidebar
                    key={activeWorkspace.id}
                    client={filesClient}
                    expanded={activeFiles.expanded}
                    getClient={getFilesClient}
                    mobile={mobileWebApp}
                    open={filesOpen}
                    ready={activeWorkspaceRunning}
                    refreshVersion={filesRefreshVersion}
                    visible={filesOpen && activeFiles.segment === 'files'}
                    wakingStage={workspaceWakingStage}
                    width={activeFiles.width}
                    onClose={() => {
                      if (mobileWebApp) setFilesDrawerOpen(false);
                      else {
                        setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
                          ? { ...current, value: { ...current.value, open: false } }
                          : current);
                      }
                    }}
                    onExpandedChange={(expanded) => {
                      setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
                        ? { ...current, value: { ...current.value, expanded } }
                        : current);
                    }}
                    onOpenFile={openFile}
                    onUnauthorized={handleUnauthorized}
                    onWidthChange={(width) => {
                      setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
                        ? { ...current, value: { ...current.value, width } }
                        : current);
                    }}
                  />
                    <WorkspaceSharedFolders
                      client={client}
                      workspaceId={activeWorkspace.id}
                      filesClient={filesClient}
                      canControl={activeWorkspace.accessRole === 'owner' || activeWorkspace.accessRole === 'admin'}
                      visible={filesOpen && activeFiles.segment === 'files'}
                      onOpenFolder={(folderId) => navigateTo(folderPagePath(folderId))}
                    />
                  </>
                )}
              />
            )}
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
                  aria-controls="webapp-workspace-drawer"
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

      {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      {updateNotice}
      {showCreateWorkspace && (
        <CreateWorkspaceDialog
          busy={createWorkspaceBusy}
          error={createWorkspaceError}
          listMachineTypes={listMachineTypes}
          listVolumes={listVolumes}
          onCancel={() => {
            if (!createWorkspaceBusy) {
              setShowCreateWorkspace(false);
            }
          }}
          onSubmit={(input) => { void createWorkspace(input); }}
        />
      )}
      {confirmation && (
        <ConfirmationDialog
          title="Delete workspace?"
          description={`Are you sure you want to delete “${confirmation.label}”? This destroys the workspace and cannot be undone.`}
          confirmLabel="Yes, delete"
          cancelLabel="No"
          onCancel={cancelConfirmation}
          onConfirm={confirmWebAppAction}
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
