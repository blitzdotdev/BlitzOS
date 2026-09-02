import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import type { CredentialRequestView } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import {
  SurfaceTabContent,
  surfaceTabPaneClassName,
} from '../lody/SurfaceTabContent';
import {
  WebAppHeader,
  type SpawnSessionType,
  type WebAppTabModel,
} from '../WebAppHeader';
import type { LivePort, PreviewLink } from '../preview';
import type { WorkspaceRegion, WorkspaceTab } from '../storage';
import type { CloudWorkspaceModel } from '../workspace-store';
import type { ConnectionsPanelFocus } from '../WorkspaceDrawer';
import type { TabDrag } from '../use-workspace-tab-drag';

export type WorkPanesProps = {
  client: ControlPlaneClient;
  panesRef: RefObject<HTMLDivElement | null>;
  visibleRegions: WorkspaceRegion[];
  renderedSessions: WorkspaceTab[];
  surfaceRegion: (session: WorkspaceTab) => WorkspaceRegion;
  paneActiveId: (region: WorkspaceRegion) => string | null;
  paneTabModels: (region: WorkspaceRegion) => WebAppTabModel[];
  paneFallback: (region: WorkspaceRegion) => ReactNode;
  sidePaneWidth: number;
  paneResizing: boolean;
  tabDrag: TabDrag | null;
  splitEnabled: boolean;
  /**
   * Whether this column draws its own tab strips
   * (plans/LODY-TERMINAL-TABS.md §4.6).
   *
   * `false` only when the Lody session strip is drawing the same tabs — the
   * build flag is on, the box answers `present`, and this is a desktop layout.
   * With the flag off, on a box that serves no daemon, or on mobile (where the
   * vendored strip does not exist), it is `true` and the panes are exactly what
   * they were. Nothing else changes here: `WebAppHeader`, `NewTabMenu` and the
   * context menu all stay in the tree.
   */
  tabStrips: boolean;
  mobile: boolean;
  drawerOpen: boolean;
  tabsLoaded: boolean;
  workspaceWaking: boolean;
  canEditWorkspaceLayout: boolean;
  activeWorkspace: CloudWorkspaceModel | undefined;
  activeWorkspaceId: string;
  activeWorkspaceRunning: boolean;
  activeSessionUrl: string | null;
  activeFilesBase: string | null;
  /** The `+ New tab` menu in each strip lists these. */
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  pendingRequests: CredentialRequestView[];
  pendingRequestsError: string | null;
  connectionsFocus: ConnectionsPanelFocus | null;
  onOpenDrawer: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string | undefined) => void;
  onSpawnSession: (type: SpawnSessionType) => void;
  onTabDragStart: (sessionId: string, event: ReactDragEvent<HTMLElement>) => void;
  onTabDragEnd: () => void;
  onTabDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onTabDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onOpenPreview: (port: number, path?: string) => boolean;
  onOpenPreviewLink: (url: string, title: string) => boolean;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
  onSignInUrl: (url: string | null) => void;
  onBeginPaneResize: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

/** Column three: the tab strips, the surfaces they draw, and the split
 * plumbing between them. Every surface is a sibling in one grid, so moving a
 * tab between panes changes a placement and never a parent. */
export function WorkPanes({
  client,
  panesRef,
  visibleRegions,
  renderedSessions,
  surfaceRegion,
  paneActiveId,
  paneTabModels,
  paneFallback,
  sidePaneWidth,
  paneResizing,
  tabDrag,
  splitEnabled,
  tabStrips,
  mobile,
  drawerOpen,
  tabsLoaded,
  workspaceWaking,
  canEditWorkspaceLayout,
  activeWorkspace,
  activeWorkspaceId,
  activeWorkspaceRunning,
  activeSessionUrl,
  activeFilesBase,
  livePorts,
  previewLinks,
  pendingRequests,
  pendingRequestsError,
  connectionsFocus,
  onOpenDrawer,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onSpawnSession,
  onTabDragStart,
  onTabDragEnd,
  onTabDragOver,
  onTabDrop,
  onOpenPreview,
  onOpenPreviewLink,
  onResolveRequest,
  onSignInUrl,
  onBeginPaneResize,
}: WorkPanesProps) {
  return (
    <div
      className={`webapp-panes${visibleRegions.length > 1 ? ' webapp-panes--split' : ''}`}
      ref={panesRef}
      data-resizing={paneResizing || undefined}
      style={
        // SAFETY: React accepts CSS custom properties at runtime; CSSProperties omits arbitrary `--*` keys from its static surface.
        { '--side-pane-width': `${sidePaneWidth}px` } as CSSProperties
      }
      onDragOver={onTabDragOver}
      onDrop={onTabDrop}
    >
      {tabStrips && visibleRegions.map((region) => (
        <div className="webapp-pane-strip" data-region={region} key={`strip-${region}`}>
          <WebAppHeader
            tabs={paneTabModels(region)}
            activeSessionId={paneActiveId(region) ?? ''}
            sessionBusy={false}
            terminalDisabled={workspaceWaking || !tabsLoaded}
            mobile={mobile}
            paneStrips={false}
            drawerOpen={drawerOpen}
            stripLabel={region === 'main'
              ? 'Workspace sessions'
              : 'Workspace side pane sessions'}
            spawnable={region === 'main'}
            onOpenDrawer={onOpenDrawer}
            onSelect={onSelectSession}
            onClose={onCloseSession}
            onRename={canEditWorkspaceLayout ? onRenameSession : undefined}
            onSpawn={onSpawnSession}
            onTabDragStart={splitEnabled ? onTabDragStart : undefined}
            onTabDragEnd={onTabDragEnd}
            draggingSessionId={tabDrag?.sessionId ?? null}
            insertBeforeId={tabDrag !== null
              && tabDrag.target.kind === 'tab'
              && tabDrag.target.region === region
              ? tabDrag.target.beforeId === null
                ? null
                : String(tabDrag.target.beforeId)
              : undefined}
            livePorts={livePorts}
            previewLinks={previewLinks}
            onOpenPreview={onOpenPreview}
            onOpenPreviewLink={onOpenPreviewLink}
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
        return (
          <div
            className={surfaceTabPaneClassName(session)}
            data-region={region}
            hidden={!active}
            key={sessionId}
          >
            <SurfaceTabContent
              session={session}
              active={active}
              client={client}
              activeWorkspace={activeWorkspace}
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceRunning={activeWorkspaceRunning}
              activeSessionUrl={activeSessionUrl}
              activeFilesBase={activeFilesBase}
              pendingRequests={pendingRequests}
              pendingRequestsError={pendingRequestsError}
              connectionsFocus={connectionsFocus}
              onResolveRequest={onResolveRequest}
              onSignInUrl={onSignInUrl}
              onOpenPreview={onOpenPreview}
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
          onMouseDown={onBeginPaneResize}
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
  );
}
