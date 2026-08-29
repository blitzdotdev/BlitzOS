import type { TenantMe } from '../api-adapter';
import type { SpawnSessionType } from '../WebAppHeader';
import type { WorkspaceDrawerSegment } from '../storage';
import type { CloudWorkspaceModel } from '../workspace-store';
import type { DriveRailSession } from './rail-sessions';
import { WorkspaceSessionRail } from './WorkspaceSessionRail';
import { WorkspaceStrip } from './WorkspaceStrip';

export type ShellNavProps = {
  workspaces: CloudWorkspaceModel[];
  viewer: TenantMe | null;
  activeWorkspaceId: string | null;
  activeWorkspace: CloudWorkspaceModel | undefined;
  /** The rail is column two on a workspace page, and rides in the mobile
   * drawer wherever a workspace is open. Drive and settings show the strip
   * alone and let the page have the width. */
  showRail: boolean;
  sessions: DriveRailSession[];
  activeSessionId: string;
  openPanels: ReadonlySet<WorkspaceDrawerSegment>;
  pendingRequestCount: number;
  drawerOpen: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onOpenPanel: (panel: WorkspaceDrawerSegment) => void;
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  onOpenDrive: () => void;
  onOpenSettings: () => void;
  onSelectSession: (sessionId: string) => void;
  onSpawnSession: (type: SpawnSessionType) => void;
  onOpenWorkspaceMembers: (workspaceId: string) => void;
  onOpenWorkspaceDetails: (workspaceId: string) => void;
  onCloseDrawer: () => void;
};

/** Columns one and two of the shell. Above the mobile breakpoint this is
 * `display: contents`, so the strip and the rail are real grid children of the
 * shell; below it the wrapper becomes the off-canvas drawer and carries both. */
export function ShellNav({
  workspaces,
  viewer,
  activeWorkspaceId,
  activeWorkspace,
  showRail,
  sessions,
  activeSessionId,
  openPanels,
  pendingRequestCount,
  drawerOpen,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenPanel,
  onSwitchOrg,
  onCreateOrg,
  onOpenDrive,
  onOpenSettings,
  onSelectSession,
  onSpawnSession,
  onOpenWorkspaceMembers,
  onOpenWorkspaceDetails,
  onCloseDrawer,
}: ShellNavProps) {
  return (
    <>
      <div className={`shell-nav${drawerOpen ? ' shell-nav--open' : ''}`}>
        <WorkspaceStrip
          workspaces={workspaces}
          viewer={viewer}
          activeWorkspaceId={activeWorkspaceId}
          openPanels={openPanels}
          pendingRequestCount={pendingRequestCount}
          surfacesEnabled={activeWorkspace !== undefined}
          onSelectWorkspace={onSelectWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          onOpenPanel={onOpenPanel}
          onSwitchOrg={onSwitchOrg}
          onCreateOrg={onCreateOrg}
          onOpenDrive={onOpenDrive}
          onOpenSettings={onOpenSettings}
          onCloseDrawer={onCloseDrawer}
        />
        {showRail && (
          <WorkspaceSessionRail
            workspace={activeWorkspace}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onSpawnSession={onSpawnSession}
            onOpenMembers={onOpenWorkspaceMembers}
            onOpenDetails={onOpenWorkspaceDetails}
          />
        )}
      </div>
      <button
        className={`shell-nav-scrim${drawerOpen ? ' shell-nav-scrim--open' : ''}`}
        type="button"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={onCloseDrawer}
      />
    </>
  );
}
