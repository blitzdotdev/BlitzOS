import type {
  CSSProperties,
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
import { PaneChrome } from './PaneChrome';
import type { LivePort, PreviewLink } from '../preview';
import type { WorkspaceRegion, WorkspaceTab } from '../storage';
import type { CloudWorkspaceModel } from '../workspace-store';

export type WorkPanesProps = {
  client: ControlPlaneClient;
  panesRef: RefObject<HTMLDivElement | null>;
  visibleRegions: WorkspaceRegion[];
  renderedSessions: WorkspaceTab[];
  surfaceRegion: (session: WorkspaceTab) => WorkspaceRegion;
  paneActiveId: (region: WorkspaceRegion) => string | null;
  paneFallback: (region: WorkspaceRegion) => ReactNode;
  sidePaneWidth: number;
  paneResizing: boolean;
  /** See `PaneChromeProps.pending`: the capability probe is unsettled, so the
   * strip that owns the tabs cannot be drawn yet. */
  sessionsPending: boolean;
  mobile: boolean;
  drawerOpen: boolean;
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
  onOpenDrawer: () => void;
  onOpenPreview: (port: number, path?: string) => boolean;
  onOpenPreviewLink: (url: string, title: string) => boolean;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
  onSignInUrl: (url: string | null) => void;
  onBeginPaneResize: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

/**
 * Column three: the surfaces a workspace tab draws itself into.
 *
 * IT DRAWS NO TAB STRIP. It used to draw one `WebAppHeader` per visible region
 * and that native strip is deleted (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2 —
 * the deletion"): a terminal is a tab of the session strip and of nothing else,
 * so the only chrome above the panes is `PaneChrome`, which draws the mobile
 * drawer button and the boot-window skeleton and never a tab.
 *
 * The DRAG-AND-DROP that moved a tab between the two columns went with it. Its
 * only handle was a draggable tab button in the deleted strip, so the hook, the
 * drop overlay and `moveTab`/`splitTab` had no reachable caller left; the split
 * itself survives as a PLACEMENT — a stored `region: 'side'` still lands its tab
 * in the second column — which is what §5.3 promised a rollback.
 *
 * Every surface is a sibling in one grid, so a tab's column is a placement and
 * never a parent.
 */
export function WorkPanes({
  client,
  panesRef,
  visibleRegions,
  renderedSessions,
  surfaceRegion,
  paneActiveId,
  paneFallback,
  sidePaneWidth,
  paneResizing,
  sessionsPending,
  mobile,
  drawerOpen,
  activeWorkspace,
  activeWorkspaceId,
  activeWorkspaceRunning,
  activeSessionUrl,
  activeFilesBase,
  livePorts,
  previewLinks,
  pendingRequests,
  pendingRequestsError,
  onOpenDrawer,
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
    >
      <PaneChrome
        mobile={mobile}
        drawerOpen={drawerOpen}
        pending={sessionsPending}
        onOpenDrawer={onOpenDrawer}
      />
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
    </div>
  );
}
