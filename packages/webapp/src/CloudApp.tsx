import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
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
  WebAppHeader,
  SPAWN_SESSION_LABELS,
  type WebAppTabModel,
  type SpawnSessionType,
} from './WebAppHeader';
import { FileIcon } from './WebAppIcons';
import { DriveHome } from './files/DriveHome';
import { CreateRecipeScreen } from './files/CreateRecipeScreen';
import { CreateTemplateScreen } from './files/CreateTemplateScreen';
import { DriveRail, type DriveRailNav } from './files/DriveRail';
import { RecipesHome } from './files/RecipesHome';
import { TemplatesHome } from './files/TemplatesHome';
import { ShareToDriveDialog } from './files/ShareToDriveDialog';
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
  recipeEditPath,
  recipeNewPath,
  recipesPath,
  settingsPath,
  workspacePath,
  type SettingsSection,
  templateEditPath,
  templateNewPath,
  templatesPath,
} from './sessions-page-state';
import {
  defaultWorkspaceFiles,
  maxDrawerWidth,
  removeDismissedChatAuthProviders,
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
  filesHostRegion,
  moveTab,
  paneRegions,
  panelTab,
  regionActiveId,
  showPanelTab,
  splitTab,
  togglePanelTab,
  withRegionActiveId,
} from './workspace-panes';
import { useWorkspaceTabDrag } from './use-workspace-tab-drag';
import { WorkspaceRailStrip } from './WorkspaceRailStrip';
import { TERMINAL_KEYBOARD_EVENT, TERMINAL_PASTE_EVENT } from './terminal-touch';
import { terminalPastePayload } from './terminal-paste';
import { useTerminalSignIn } from './use-terminal-sign-in';
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
  isPreviewPath,
  isPreviewPort,
  newestPorts,
  newestPreviewLinks,
  previewLinkLabel,
} from './preview';
import { decideUpdateAction, extractIndexAsset } from './update-check';
import { LoginForm } from './components/LoginForm';
import { CreateOrgDialog } from './components/CreateOrgDialog';
import { CreateOrgPage } from './components/CreateOrgPage';
import type { IdentityRecord } from './protocol';
import { FILES_DAV_ROOT, type EndpointResolver } from './resolver';
import {
  type ConnectionsPanelFocus, WorkspaceDrawer, WorkspacePanelContent } from './WorkspaceDrawer';
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

type WebAppConfirmation = {
  workspaceId: string;
  label: string;
};

type FileCloseConfirmation = {
  id: string;
  label: string;
};


const PANEL_LABELS = {
  files: 'Files',
  previews: 'teenyapps',
  connections: 'Connections',
} satisfies Record<WorkspaceDrawerSegment, string>;

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
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [shareWorkspaceId, setShareWorkspaceId] = useState<string | null>(null);
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
  const paneResizeOrigin = useRef<{ x: number; width: number } | null>(null);
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
  // Every template load also refreshes which template is the org default, so
  // the create dialog can preselect it (its own load runs through here).
  const [orgDefaultTemplateId, setOrgDefaultTemplateId] = useState<string | null>(null);
  const listTemplates = useCallback(
    () => client.listWorkspaceTemplates().then(({ templates }) => {
      setOrgDefaultTemplateId(
        templates.find(({ isOrgDefault }) => isOrgDefault)?.id ?? null,
      );
      return templates;
    }),
    [client],
  );
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
  const activeAcpUrl = activeWorkspaceRunning ? activeIngressEntry?.acpUrl ?? null : null;
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
  const drawerSegment: WorkspaceDrawerSegment = sidePanelTab?.type === 'panel'
    ? sidePanelTab.panel
    : 'files';
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
    setRoute({ workspaceId, page: 'webApp' });
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
  // The launch failure (for example the vm-limit 409) surfaces through the
  // same notice the create dialog uses, with the control plane's message.
  const launchRecipe = useCallback(
    (recipeId: string) => adoptCreatedWorkspace(() => api.launchRecipe(recipeId)),
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
  // The focused session drives the statusline, the rail and terminal keyboard
  // events. Mobile skips panel tabs: those live in the sheet, not the strip.
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
  const ttydLabel = (session: WorkspaceTab) => session.type === 'file'
    ? session.filePath
    : session.type === 'panel'
      ? PANEL_LABELS[session.panel]
      : session.type === 'preview'
        ? 'port' in session
          ? `:${session.port}`
          : previewLinkLabel(session.url, session.title)
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
  const addWorkspaceTab = useCallback((
    createTab: (id: number) => WorkspaceTab,
    region: WorkspaceRegion = 'main',
  ) => {
    updateWorkspaceTabs((tabs) => appendTab(tabs, region, createTab));
    setFocusedRegion(region);
  }, [updateWorkspaceTabs]);
  const spawnTtydSession = (type: SpawnSessionType) => {
    addWorkspaceTab((id) => type === 'chat'
      ? { id, type, chatProvider: 'claude' }
      : { id, type });
  };
  const selectTtydSession = useCallback((id: string) => {
    const session = ttydSessions.find((tab) => String(tab.id) === id);
    if (session === undefined) return;
    setFocusedRegion(surfaceRegion(session));
    updateWorkspaceTabs((tabs) => withRegionActiveId(tabs, tabRegion(session), session.id));
  }, [surfaceRegion, ttydSessions, updateWorkspaceTabs]);
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
  const signInToTerminal = useTerminalSignIn({
    workspaceId: activeWorkspaceId,
    tabs: activeWorkspaceTabs === null ? null : ttydSessions,
    nextId: activeWorkspaceTabs?.nextId ?? 0,
    accessRole: activeWorkspace?.accessRole,
    ttydActiveId,
    retainedSessions: retainedSessionIdsRef,
    selectSession: selectTtydSession,
    spawnSession: spawnTtydSession,
  });
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
      const numericId = tabs.tabs.find((tab) => String(tab.id) === id)?.id;
      return numericId === undefined ? tabs : closePaneTab(tabs, numericId);
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
    updateWorkspaceTabs((current) => {
      const numericId = current.tabs.find((tab) => String(tab.id) === id)?.id;
      if (numericId === undefined) return current;
      const tab = current.tabs.find((entry) => entry.id === numericId);
      if (
        tab?.type !== 'chat'
        || (tab.chatSessionId === chatSessionId && tab.chatProvider === chatProvider)
      ) return current;
      return {
        ...current,
        tabs: current.tabs.map((entry) => entry.id === numericId && entry.type === 'chat'
          ? {
              ...entry,
              ...(chatSessionId ? { chatSessionId } : { chatSessionId: undefined }),
              chatProvider,
            }
          : entry),
      };
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
  const workspaceErrored = activeWorkspace !== undefined && (
    activeWorkspace.lifecycleStatus === 'error'
    || (activeWorkspace.lifecycleStatus === 'parked' && activeWorkspace.errorDetail !== null)
  );
  // Terminals and chat need a live box; files, previews and panels draw their
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
    return session === null
      ? <p className="webapp-pane-empty">Empty pane</p>
      : null;
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

  const railFor = (nav: DriveRailNav | null, railActiveWorkspaceId: string | null) => (
    <DriveRail
      workspaces={store.workspaces}
      activeWorkspaceId={railActiveWorkspaceId}
      nav={nav}
      identity={store.viewer?.identity ?? null}
      org={store.viewer?.org ?? null}
      organizations={store.viewer?.organizations.map(({ org }) => org) ?? []}
      sessions={railActiveWorkspaceId !== null && railActiveWorkspaceId === activeWorkspaceId
        ? ttydTabs.filter((tab) => tab.agent !== 'panel')
        : []}
      activeSessionId={ttydActiveId ?? ''}
      onSelectSession={selectTtydSession}
      onOpenDrive={() => navigateTo(drivePath())}
      onOpenTemplates={() => navigateTo(templatesPath())}
      onOpenRecipes={() => navigateTo(recipesPath())}
      onSelectWorkspace={selectWorkspace}
      onCreateWorkspace={() => setShowCreateWorkspace(true)}
      onSwitchOrg={(orgId) => {
        void client.switchOrg(orgId).then(() => window.location.reload());
      }}
      onCreateOrg={() => setShowCreateOrg(true)}
      onOpenSettings={() => navigateToSettings('profile')}
      onOpenWorkspaceDetails={(workspaceId) => setShareWorkspaceId(workspaceId)}
      onDeleteWorkspace={requestDeleteWorkspace}
      drawerOpen={drawerOpen}
      onCloseDrawer={() => setDrawerOpen(false)}
    />
  );
  const createWorkspaceDialog = showCreateWorkspace && (
    <CreateWorkspaceDialog
      busy={createWorkspaceBusy}
      error={createWorkspaceError}
      orgName={store.viewer?.org.name ?? 'your org'}
      orgId={store.viewer?.org.id ?? ''}
      admin={store.viewer?.membership.role === 'admin'}
      saveComputeCredential={client.putComputeCredential}
      client={client}
      listMachineTypes={listMachineTypes}
      listVolumes={listVolumes}
      listTemplates={listTemplates}
      initialTemplateId={orgDefaultTemplateId}
      // The template page draws this dialog too, since #40. Close it on the
      // way out, or it covers the page it just opened.
      onNewTemplate={() => {
        setShowCreateWorkspace(false);
        navigateTo(templateNewPath());
      }}
      onCancel={() => {
        if (!createWorkspaceBusy) setShowCreateWorkspace(false);
      }}
      onSubmit={(input) => { void createWorkspace(input); }}
    />
  );
  const deleteWorkspaceDialog = confirmation && (
    <ConfirmationDialog
      title="Delete workspace?"
      description={`Are you sure you want to delete “${confirmation.label}”? This destroys the workspace and cannot be undone.`}
      confirmLabel="Yes, delete"
      cancelLabel="No"
      onCancel={cancelConfirmation}
      onConfirm={confirmWebAppAction}
    />
  );
  const shareWorkspaceDialog = shareWorkspaceId && (() => {
    const workspace = store.workspaces.find(({ id }) => id === shareWorkspaceId);
    return workspace ? (
      <ShareWorkspaceDialog
        client={client}
        workspaceId={workspace.id}
        workspaceName={workspace.title}
        orgName={store.viewer?.org.name ?? 'your org'}
        orgShareRole={workspace.orgShareRole}
        owner={workspace.owner ?? (workspace.accessRole === 'owner' && store.viewer
          ? { name: store.viewer.identity.name || store.viewer.identity.email, avatarUrl: store.viewer.identity.avatarUrl ?? null }
          : null)}
        viewerIsOwner={workspace.accessRole === 'owner'}
        onClose={() => setShareWorkspaceId(null)}
      />
    ) : null;
  })();
  const createOrgDialog = showCreateOrg && (
    <CreateOrgDialog
      onCreate={async (name) => {
        await api.createOrg(name);
        // POST /orgs rebinds the session to the org it just made, so the
        // reload lands inside it, exactly as switching does.
        window.location.reload();
      }}
      onCancel={() => setShowCreateOrg(false)}
    />
  );
  const railOverlays = (
    <>
      {createOrgDialog}
      {createWorkspaceDialog}
      {deleteWorkspaceDialog}
      {shareWorkspaceDialog}
    </>
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
        {railFor('drive', null)}
        {loaded && store.viewer ? (
          <DriveHome
            client={client}
            viewer={store.viewer}
            route={route}
            onNavigate={navigateTo}
            onOpenRail={() => setDrawerOpen(true)}
          />
        ) : (
          <div className="drive-content">
            <div className="drive-empty" role="status">Loading…</div>
          </div>
        )}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {updateNotice}
        {railOverlays}
      </main>
    );
  }

  if (route.page === 'templates') {
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {railFor('templates', null)}
        {loaded && store.viewer ? (
          <TemplatesHome
            client={client}
            creating={createWorkspaceBusy}
            onNewTemplate={() => navigateTo(templateNewPath())}
            onEditTemplate={(template) => navigateTo(templateEditPath(template.id))}
            onUseTemplate={(template) => {
              void createWorkspace({ templateId: template.id, orgShareRole: 'editor' });
            }}
            onOpenRail={() => setDrawerOpen(true)}
          />
        ) : (
          <div className="drive-content">
            <div className="drive-empty" role="status">Loading…</div>
          </div>
        )}
        {createWorkspaceError && <div className="webapp-notice" role="alert"><span>{createWorkspaceError}</span><button type="button" onClick={() => setCreateWorkspaceError(null)}>Dismiss</button></div>}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {updateNotice}
        {railOverlays}
      </main>
    );
  }

  if (route.page === 'recipes') {
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {railFor('recipes', null)}
        {loaded && store.viewer ? (
          <RecipesHome
            client={client}
            launching={createWorkspaceBusy}
            onNewRecipe={() => navigateTo(recipeNewPath())}
            onEditRecipe={(recipe) => navigateTo(recipeEditPath(recipe.id))}
            onRunRecipe={(recipe) => { void launchRecipe(recipe.id); }}
            onOpenRail={() => setDrawerOpen(true)}
          />
        ) : (
          <div className="drive-content">
            <div className="drive-empty" role="status">Loading…</div>
          </div>
        )}
        {createWorkspaceError && <div className="webapp-notice" role="alert"><span>{createWorkspaceError}</span><button type="button" onClick={() => setCreateWorkspaceError(null)}>Dismiss</button></div>}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {updateNotice}
        {railOverlays}
      </main>
    );
  }

  if (route.page === 'recipe-new' || route.page === 'recipe-edit') {
    const leaveToRecipes = () => navigateTo(recipesPath());
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {railFor('recipes', null)}
        {loaded && store.viewer ? (
          <CreateRecipeScreen
            client={client}
            editRecipeId={route.page === 'recipe-edit' ? route.recipeId : undefined}
            onSaved={leaveToRecipes}
            onCancel={leaveToRecipes}
          />
        ) : (
          <div className="drive-content">
            <div className="drive-empty" role="status">Loading…</div>
          </div>
        )}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {railOverlays}
      </main>
    );
  }

  if (route.page === 'template-new' || route.page === 'template-edit') {
    const leaveToTemplates = () => navigateTo(templatesPath());
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {railFor('templates', null)}
        {loaded && store.viewer ? (
          <CreateTemplateScreen
            client={client}
            orgId={store.viewer.org.id}
            orgName={store.viewer.org.name}
            admin={store.viewer.membership.role === 'admin'}
            editTemplateId={route.page === 'template-edit' ? route.templateId : undefined}
            isAdmin={store.viewer.membership.role === 'admin'}
            onCreated={leaveToTemplates}
            onCancel={leaveToTemplates}
          />
        ) : (
          <div className="drive-content">
            <div className="drive-empty" role="status">Loading…</div>
          </div>
        )}
        {error && <div className="webapp-notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
        {railOverlays}
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
            onNavigate={navigateToSettings}
            onOpenWorkspace={navigateToWorkspacePage}
            onSignOut={signOut}
            onLeftOrg={() => window.location.reload()}
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
      {railFor(null, activeWorkspaceId)}
      {shareWorkspaceDialog}

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
            <div
              className={`webapp-panes${visibleRegions.length > 1 ? ' webapp-panes--split' : ''}`}
              ref={panesRef}
              style={
                // SAFETY: React accepts CSS custom properties at runtime; CSSProperties omits arbitrary `--*` keys from its static surface.
                { '--side-pane-width': `${activeFiles.width}px` } as CSSProperties
              }
              onDragOver={(event) => {
                if (tabDrag === null) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                trackTabDrag(event);
              }}
              onDrop={dropTabDrag}
            >
              {visibleRegions.map((region) => (
                <div className="webapp-pane-strip" data-region={region} key={`strip-${region}`}>
                  <WebAppHeader
                    tabs={paneTabModels(region)}
                    activeSessionId={paneActiveId(region) ?? ''}
                    sessionBusy={false}
                    terminalDisabled={workspaceWaking || !tabsLoaded}
                    mobile={mobileWebApp}
                    paneStrips={false}
                    drawerOpen={drawerOpen}
                    stripLabel={region === 'main'
                      ? 'Workspace sessions'
                      : 'Workspace side pane sessions'}
                    spawnable={region === 'main'}
                    onOpenDrawer={() => {
                      setFilesDrawerOpen(false);
                      setDrawerOpen(true);
                    }}
                    onSelect={selectTtydSession}
                    onClose={closeTtydSession}
                    onSpawn={spawnTtydSession}
                    onTabDragStart={splitEnabled ? beginTabDrag : undefined}
                    onTabDragEnd={clearTabDrag}
                    draggingSessionId={tabDrag?.sessionId ?? null}
                    insertBeforeId={tabDrag !== null
                      && tabDrag.target.kind === 'tab'
                      && tabDrag.target.region === region
                      ? tabDrag.target.beforeId === null
                        ? null
                        : String(tabDrag.target.beforeId)
                      : undefined}
                    livePorts={orderedLivePorts}
                    previewLinks={orderedPreviewLinks}
                    onOpenPreview={openPreviewPort}
                    onOpenPreviewLink={openPreviewLink}
                  />
                </div>
              ))}
              {visibleRegions.map((region) => {
                const fallback = paneFallback(region);
                return fallback === null ? null : (
                  <div
                    className="webapp-workspace-session webapp-pane-fallback"
                    data-region={region}
                    key={`fallback-${region}`}
                  >{fallback}</div>
                );
              })}
              {renderedSessions.map((session) => {
                const sessionId = String(session.id);
                const region = surfaceRegion(session);
                const active = paneActiveId(region) === sessionId;
                if (session.type === 'panel') {
                  return (
                    <div
                      className="webapp-workspace-session webapp-pane-panel"
                      data-region={region}
                      hidden={!active}
                      key={sessionId}
                    >
                      <WorkspacePanelContent
                        panel={session.panel}
                        client={client}
                        workspaceId={activeWorkspaceId}
                        orgName={store.viewer?.org.name ?? 'Organization'}
                        visible={active}
                        files={filesSidebar}
                        pendingRequests={activePendingRequests}
                        pendingRequestsError={pendingRequestsError}
                        workspaceConnections={activeWorkspace?.connections ?? []}
                        connectionsFocus={connectionsFocus}
                        readOnly={activeWorkspace?.accessRole === 'viewer'}
                        onResolveRequest={resolveWorkspaceRequest}
                        livePorts={orderedLivePorts}
                        previewLinks={orderedPreviewLinks}
                        filesBase={activeFilesBase}
                        previewReady={activeWorkspaceRunning}
                        onOpenPreview={(port) => { openPreviewPort(port); }}
                        onOpenPreviewLink={(url, title) => { openPreviewLink(url, title); }}
                      />
                    </div>
                  );
                }
                if (session.type === 'preview') {
                  return (
                    <div
                      className="webapp-workspace-session webapp-pane-preview"
                      data-region={region}
                      hidden={!active}
                      key={sessionId}
                    >
                      <PreviewPanel
                        target={'port' in session
                          ? session.port
                          : { url: session.url, title: session.title }}
                        path={'port' in session ? session.path : undefined}
                        filesBase={activeFilesBase}
                        running={activeWorkspaceRunning}
                      />
                    </div>
                  );
                }
                if (session.type === 'file') {
                  return (
                    <div
                      className="webapp-workspace-session"
                      data-region={region}
                      hidden={!active || filesClient === null}
                      key={sessionId}
                    >
                      <FileEditor
                        active={active}
                        client={filesClient}
                        filePath={session.filePath}
                        unavailableStage={workspaceWakingStage}
                        onDirtyChange={(dirty) => updateFileDirty(sessionId, dirty)}
                        onSaved={() => setFilesRefreshVersion((version) => version + 1)}
                        onTreeRefresh={() => setFilesRefreshVersion((version) => version + 1)}
                        onUnauthorized={handleUnauthorized}
                      />
                    </div>
                  );
                }
                if (session.type === 'chat') {
                  return (
                    <div
                      className="webapp-workspace-session"
                      data-region={region}
                      hidden={!active}
                      key={sessionId}
                    >
                      <ChatPanel
                        url={activeAcpUrl ?? ''}
                        workspaceId={activeWorkspaceId}
                        initialSessionId={session.chatSessionId ?? null}
                        onSessionId={(_workspaceId, chatSessionId) => {
                          rememberChatSession(sessionId, chatSessionId, 'claude');
                        }}
                        onOpenPreview={openPreviewPort}
                        onSignIn={signInToTerminal}
                        readOnly={activeWorkspace?.accessRole === 'viewer'}
                      />
                    </div>
                  );
                }
                return (
                  <div
                    className="webapp-workspace-session"
                    data-region={region}
                    hidden={!active}
                    key={sessionId}
                  >
                    <TtydTerminal
                      url={activeSessionUrl ?? ''}
                      sessionType={session.type}
                      sessionKey={sessionId}
                      active={active}
                      readOnly={activeWorkspace?.accessRole === 'viewer'}
                      onSignInUrl={setTerminalSignInUrl}
                      onOpenPreview={openPreviewPort}
                    />
                  </div>
                );
              })}
              {visibleRegions.length > 1 && (
                <div
                  className="webapp-pane-resizer"
                  role="separator"
                  aria-label="Resize side pane"
                  aria-orientation="vertical"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    paneResizeOrigin.current = { x: event.clientX, width: activeFiles.width };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const origin = paneResizeOrigin.current;
                    if (origin === null) return;
                    setSidePaneWidth(Math.max(
                      200,
                      Math.min(
                        maxDrawerWidth(window.innerWidth),
                        origin.width + origin.x - event.clientX,
                      ),
                    ));
                  }}
                  onPointerUp={(event) => {
                    paneResizeOrigin.current = null;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onPointerCancel={() => { paneResizeOrigin.current = null; }}
                />
              )}
              {tabDrag !== null && (
                <div
                  className="webapp-pane-drop"
                  aria-hidden="true"
                  style={{
                    left: `${tabDrag.box.left}px`,
                    top: `${tabDrag.box.top}px`,
                    width: `${tabDrag.box.width}px`,
                    height: `${tabDrag.box.height}px`,
                  }}
                />
              )}
            </div>
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
          onSegmentChange={(panel: WorkspaceDrawerSegment) => {
            updateWorkspaceTabs((tabs) => showPanelTab(tabs, panel));
          }}
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
      {createWorkspaceDialog}
      {deleteWorkspaceDialog}
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
