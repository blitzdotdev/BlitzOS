import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import type { CredentialRequestView } from '@blitzos/schema';
import type { WebDAVClient } from 'webdav';
import type { ControlPlaneClient } from '../api';
import { FileEditor } from '../FileEditor';
import { PreviewPanel } from '../PreviewPanel';
import { TtydTerminal } from '../TtydTerminal';
import {
  WebAppHeader,
  type SpawnSessionType,
  type WebAppTabModel,
} from '../WebAppHeader';
import type { LivePort, PreviewLink } from '../preview';
import type { WorkspaceRegion, WorkspaceTab } from '../storage';
import type { CloudWorkspaceModel } from '../workspace-store';
import {
  WorkspacePanelContent,
  type ConnectionsPanelFocus,
} from '../WorkspaceDrawer';
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
  filesClient: WebDAVClient | null;
  filesSidebar: ReactNode;
  orgName: string;
  workspaceWakingStage: string | undefined;
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
  onFileDirtyChange: (sessionId: string, dirty: boolean) => void;
  onFilesRefresh: () => void;
  onUnauthorized: () => void;
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
  filesClient,
  filesSidebar,
  orgName,
  workspaceWakingStage,
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
  onFileDirtyChange,
  onFilesRefresh,
  onUnauthorized,
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
      {visibleRegions.map((region) => (
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
                orgName={orgName}
                visible={active}
                files={filesSidebar}
                pendingRequests={pendingRequests}
                pendingRequestsError={pendingRequestsError}
                workspaceConnections={activeWorkspace?.connections ?? []}
                connectionsFocus={connectionsFocus}
                readOnly={activeWorkspace?.accessRole === 'viewer'}
                onResolveRequest={onResolveRequest}
                livePorts={livePorts}
                previewLinks={previewLinks}
                filesBase={activeFilesBase}
                previewReady={activeWorkspaceRunning}
                onOpenPreview={(port) => { onOpenPreview(port); }}
                onOpenPreviewLink={(url, title) => { onOpenPreviewLink(url, title); }}
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
                onDirtyChange={(dirty) => onFileDirtyChange(sessionId, dirty)}
                onSaved={onFilesRefresh}
                onTreeRefresh={onFilesRefresh}
                onUnauthorized={onUnauthorized}
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
