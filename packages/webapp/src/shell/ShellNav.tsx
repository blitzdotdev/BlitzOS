import type { TenantMe } from '../api-adapter';
import type { SpawnSessionType } from '../NewTabMenu';
import type { LivePort, PreviewLink } from '../preview';
import type { CloudWorkspaceModel } from '../workspace-store';
import type { DriveRailSession } from './rail-sessions';
import { SessionRail } from './SessionRail';
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
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  drawerOpen: boolean;
  /** The rail's vendored zone, when Lody sessions are on. See
   * `SessionRailProps.onVendorHost`. */
  onVendorHost?: (node: HTMLDivElement | null) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  onInviteToWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  onOpenDrive: () => void;
  onOpenSettings: () => void;
  onSelectSession: (sessionId: string) => void;
  onSpawnSession: (type: SpawnSessionType) => void;
  onOpenPreview: (port: number) => void;
  onOpenPreviewLink: (url: string, title: string) => void;
  onOpenWorkspaceMembers: (workspaceId: string) => void;
  onOpenWorkspaceDetails: (workspaceId: string) => void;
  onOpenWorkspaceMachine: (workspaceId: string) => void;
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
  livePorts,
  previewLinks,
  drawerOpen,
  onVendorHost,
  onSelectWorkspace,
  onRenameWorkspace,
  onOpenWorkspaceSettings,
  onInviteToWorkspace,
  onCreateWorkspace,
  onSwitchOrg,
  onCreateOrg,
  onOpenDrive,
  onOpenSettings,
  onSelectSession,
  onSpawnSession,
  onOpenPreview,
  onOpenPreviewLink,
  onOpenWorkspaceMembers,
  onOpenWorkspaceDetails,
  onOpenWorkspaceMachine,
  onCloseDrawer,
}: ShellNavProps) {
  return (
    <>
      <div className={`shell-nav${drawerOpen ? ' shell-nav--open' : ''}`}>
        <WorkspaceStrip
          workspaces={workspaces}
          viewer={viewer}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onRenameWorkspace={onRenameWorkspace}
          onOpenWorkspaceSettings={onOpenWorkspaceSettings}
          onInviteToWorkspace={onInviteToWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          onSwitchOrg={onSwitchOrg}
          onCreateOrg={onCreateOrg}
          onOpenDrive={onOpenDrive}
          onOpenSettings={onOpenSettings}
          onCloseDrawer={onCloseDrawer}
        />
        {showRail && (
          <SessionRail
            workspace={activeWorkspace}
            sessions={sessions}
            activeSessionId={activeSessionId}
            livePorts={livePorts}
            previewLinks={previewLinks}
            {...(onVendorHost === undefined ? {} : { onVendorHost })}
            onSelectSession={onSelectSession}
            onSpawnSession={onSpawnSession}
            onOpenPreview={onOpenPreview}
            onOpenPreviewLink={onOpenPreviewLink}
            onOpenMembers={onOpenWorkspaceMembers}
            onOpenDetails={onOpenWorkspaceDetails}
            onOpenMachine={onOpenWorkspaceMachine}
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
