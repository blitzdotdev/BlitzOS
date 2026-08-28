import type { TenantMe } from '../api-adapter';
import {
  DriveRail,
  type DriveRailNav,
  type DriveRailSession,
} from '../files/DriveRail';
import type { CloudWorkspaceModel } from '../workspace-store';

export type ShellRailProps = {
  workspaces: CloudWorkspaceModel[];
  viewer: TenantMe | null;
  /** The workspace whose sessions the rail lists, or `null` on a page that has
   * no workspace of its own (Drive, templates, recipes). */
  activeWorkspaceId: string | null;
  nav: DriveRailNav | null;
  sessions: DriveRailSession[];
  activeSessionId: string;
  drawerOpen: boolean;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onOpenDrive: () => void;
  onOpenTemplates: () => void;
  onOpenRecipes: () => void;
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  onOpenSettings: () => void;
  onOpenWorkspaceShare: (workspaceId: string) => void;
  onOpenWorkspaceDetails: (workspaceId: string) => void;
  onCloseDrawer: () => void;
};

/** Column one of the shell. Every route branch draws exactly this, so the rail
 * is identical on Drive, on a workspace, and inside the mobile drawer. */
export function ShellRail({
  workspaces,
  viewer,
  activeWorkspaceId,
  nav,
  sessions,
  activeSessionId,
  drawerOpen,
  onSelectSession,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenDrive,
  onOpenTemplates,
  onOpenRecipes,
  onSwitchOrg,
  onCreateOrg,
  onOpenSettings,
  onOpenWorkspaceShare,
  onOpenWorkspaceDetails,
  onCloseDrawer,
}: ShellRailProps) {
  return (
    <DriveRail
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
      nav={nav}
      identity={viewer?.identity ?? null}
      org={viewer?.org ?? null}
      organizations={viewer?.organizations.map(({ org }) => org) ?? []}
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={onSelectSession}
      onOpenDrive={onOpenDrive}
      onOpenTemplates={onOpenTemplates}
      onOpenRecipes={onOpenRecipes}
      onSelectWorkspace={onSelectWorkspace}
      onCreateWorkspace={onCreateWorkspace}
      onSwitchOrg={onSwitchOrg}
      onCreateOrg={onCreateOrg}
      onOpenSettings={onOpenSettings}
      onOpenWorkspaceShare={onOpenWorkspaceShare}
      onOpenWorkspaceDetails={onOpenWorkspaceDetails}
      drawerOpen={drawerOpen}
      onCloseDrawer={onCloseDrawer}
    />
  );
}
