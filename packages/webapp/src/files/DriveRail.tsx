import { useEffect, useState } from 'react';
import type { IdentityRecord, OrgRecord } from '../protocol';
import type { CloudWorkspaceModel } from '../workspace-store';
import { SessionTypeIcon, type WebAppSessionType } from '../WebAppHeader';
import { NewWorkspaceIcon, OrganizationIcon } from '../WebAppIcons';
// RecipeGlyph is unused while the Recipes rail entry stays commented out.
import { DriveGlyph, ShareGlyph, TemplateGlyph } from './DriveIcons';

/** Brandon's cockpit rail (monorepov2 PR #252) with one insertion: the flat
 * Templates, Recipes, and Drive locations sit between the organization header
 * and a divider, and the workspace tree keeps the section header below it. */

export type DriveRailNav = 'templates' | 'recipes' | 'drive';
export type DriveRailSession = {
  id: string;
  label: string;
  agent: WebAppSessionType;
  filePath?: string;
};

function workspaceStateLabel(workspace: CloudWorkspaceModel): string {
  if (workspace.lifecycleStatus === 'creating') return 'creating';
  if (workspace.lifecycleStatus === 'error') return 'failed';
  if (workspace.lifecycleStatus === 'running') return 'online';
  return workspace.lifecycleStatus;
}

function IdentityAvatar({ label }: { label: string }) {
  const initial = label.trim().charAt(0).toUpperCase() || 'B';
  return (
    <svg className="webapp-avatar" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="14" />
      <text x="14" y="14" dy="0.36em" textAnchor="middle">{initial}</text>
    </svg>
  );
}

function OwnerTag({ workspace }: { workspace: CloudWorkspaceModel }) {
  if (!workspace.owner) return null;
  const initial = workspace.owner.name.trim().charAt(0).toUpperCase() || 'M';
  return (
    <span className="webapp-workspace-owner">
      {workspace.owner.avatarUrl
        ? <img src={workspace.owner.avatarUrl} alt="" referrerPolicy="no-referrer" />
        : <span className="webapp-workspace-owner-fallback" aria-hidden="true">{initial}</span>}
      <span>{workspace.owner.name}</span>
    </span>
  );
}

export function DriveRail({
  workspaces,
  activeWorkspaceId,
  nav,
  identity,
  org,
  organizations,
  sessions,
  activeSessionId,
  onSelectSession,
  onOpenDrive,
  onOpenTemplates,
  onOpenRecipes,
  onSelectWorkspace,
  onCreateWorkspace,
  onSwitchOrg,
  onCreateOrg,
  onOpenSettings,
  onOpenWorkspaceShare,
  onOpenWorkspaceDetails,
  drawerOpen,
  onCloseDrawer,
}: {
  workspaces: CloudWorkspaceModel[];
  activeWorkspaceId: string | null;
  nav: DriveRailNav | null;
  identity: IdentityRecord | null;
  org: OrgRecord | null;
  organizations: OrgRecord[];
  sessions: DriveRailSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onOpenDrive: () => void;
  onOpenTemplates: () => void;
  onOpenRecipes: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  onOpenSettings: () => void;
  onOpenWorkspaceShare: (workspaceId: string) => void;
  onOpenWorkspaceDetails: (workspaceId: string) => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
  const orgLabel = org?.name || org?.slug || 'Organization';
  const userLabel = identity?.name || identity?.email || 'BlitzOS';

  useEffect(() => {
    if (!orgMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOrgMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [orgMenuOpen]);

  const toggleWorkspaceSessions = (workspaceId: string) => {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  return (
    <>
      <aside
        className={`drive-rail webapp-rail${drawerOpen ? ' drive-rail--open webapp-rail--drawer-open' : ''}`}
        aria-label="Cloud workspaces"
      >
        <div className="webapp-org-wrap">
          <button
            className="webapp-org-button"
            type="button"
            aria-haspopup="menu"
            aria-expanded={orgMenuOpen}
            aria-controls="webapp-org-menu"
            onClick={() => setOrgMenuOpen((open) => !open)}
          >
            <OrganizationIcon className="webapp-org-icon" />
            <strong>{orgLabel}</strong>
            <span className="webapp-org-chevron" aria-hidden="true">▾</span>
          </button>
          <button
            className="webapp-drawer-close"
            type="button"
            aria-label="Close workspace navigation"
            onClick={onCloseDrawer}
          >×</button>
          {orgMenuOpen && (
            <div className="webapp-org-backdrop" onMouseDown={() => setOrgMenuOpen(false)} />
          )}
          <div className="webapp-org-menu" id="webapp-org-menu" role="menu" hidden={!orgMenuOpen}>
            <div className="webapp-org-menu-label">organization</div>
            <div className="webapp-org-menu-current" role="menuitemradio" aria-checked="true">
              <span>{orgLabel}</span>
              <span className="webapp-org-menu-check" aria-hidden="true">✓</span>
            </div>
            {organizations.filter((candidate) => candidate.id !== org?.id).map((candidate) => (
              <button
                className="webapp-org-menu-current webapp-org-menu-switch"
                type="button"
                role="menuitemradio"
                aria-checked="false"
                key={candidate.id}
                onClick={() => {
                  setOrgMenuOpen(false);
                  onSwitchOrg(candidate.id);
                }}
              >
                <span>{candidate.name || candidate.slug}</span>
              </button>
            ))}
            <button
              className="webapp-org-menu-create"
              type="button"
              role="menuitem"
              onClick={() => {
                setOrgMenuOpen(false);
                onCreateOrg();
              }}
            >
              <span aria-hidden="true">+</span>
              <span>Create organization</span>
            </button>
          </div>
        </div>

        <nav className="drive-rail-nav drive-rail-nav--top" aria-label="Locations">
          <button
            className={`drive-rail-row${nav === 'templates' ? ' drive-rail-row--active' : ''}`}
            type="button"
            aria-current={nav === 'templates' ? 'page' : undefined}
            onClick={onOpenTemplates}
          >
            <TemplateGlyph /><span>Templates</span>
          </button>
          {/* Recipes is incomplete: the rail entry stays hidden until the
            * surface ships. Restore this button to bring it back. */}
          {/* <button
            className={`drive-rail-row${nav === 'recipes' ? ' drive-rail-row--active' : ''}`}
            type="button"
            aria-current={nav === 'recipes' ? 'page' : undefined}
            onClick={onOpenRecipes}
          >
            <RecipeGlyph /><span>Recipes</span>
          </button> */}
          <button
            className={`drive-rail-row${nav === 'drive' ? ' drive-rail-row--active' : ''}`}
            type="button"
            aria-current={nav === 'drive' ? 'page' : undefined}
            onClick={onOpenDrive}
          >
            <DriveGlyph /><span>Drive</span>
          </button>
        </nav>

        <div className="drive-rail-divider" role="presentation" />

        <div className="drive-rail-section">
          Workspaces
          <button
            className="webapp-workspace-add"
            type="button"
            title="Create workspace"
            aria-label="Create workspace"
            onClick={onCreateWorkspace}
          ><NewWorkspaceIcon /></button>
        </div>
        <nav className="webapp-tree" aria-label="Workspace windows">
          {workspaces.length === 0 && <div className="webapp-tree-empty">No workspaces yet</div>}
          {workspaces.map((workspace) => {
            const workspaceActive = workspace.canControl && workspace.id === activeWorkspaceId;
            const canManageWorkspace = workspace.accessRole === 'owner' || workspace.accessRole === 'admin';
            const stateLabel = workspaceStateLabel(workspace);
            const railSessions = workspaceActive ? sessions : [];
            const sessionsId = `workspace-sessions-${workspace.id}`;
            const canDiscloseSessions = workspace.canControl && railSessions.length > 0;
            const sessionsCollapsed = canDiscloseSessions && collapsedWorkspaceIds.has(workspace.id);
            const sessionsVisibilityClass = workspace.canControl
              ? sessionsCollapsed ? ' webapp-workspace--collapsed' : ' webapp-workspace--expanded'
              : '';
            const sessionCountLabel = `${railSessions.length} session${railSessions.length === 1 ? '' : 's'}`;
            const workspaceRow = (
              <>
                <span
                  className={`webapp-tree-icon mi-box${
                    workspace.lifecycleStatus === 'running' ? ' webapp-tree-icon--online' : ''
                  }`}
                  aria-hidden="true"
                />
                <span className="webapp-workspace-copy">
                  <span className="webapp-workspace-name">{workspace.title}</span>
                  {workspace.lifecycleStatus === 'error' && workspace.errorDetail && (
                    <span className="webapp-workspace-error-detail" role="alert">
                      {workspace.errorDetail}
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <section
                className={`webapp-workspace${
                  workspace.canControl ? ' webapp-workspace--controllable' : ''
                }${workspaceActive ? ' webapp-workspace--active' : ''}${sessionsVisibilityClass}`}
                data-workspace-id={workspace.id}
                key={workspace.id}
              >
                <div className={`webapp-workspace-item${
                  workspace.lifecycleStatus === 'error' ? ' webapp-workspace-item--error' : ''
                }`}>
                  {workspace.canControl ? (
                    <button
                      className={`webapp-workspace-button${
                        canDiscloseSessions ? ' webapp-workspace-button--disclosable' : ''
                      }`}
                      type="button"
                      aria-current={workspaceActive ? 'page' : undefined}
                      onClick={() => {
                        onSelectWorkspace(workspace.id);
                        if (workspaceActive && canDiscloseSessions) {
                          toggleWorkspaceSessions(workspace.id);
                        }
                      }}
                    >{workspaceRow}</button>
                  ) : (
                    <div className="webapp-workspace-button webapp-workspace-button--readonly webapp-workspace-button--shared">
                      {workspaceRow}
                    </div>
                  )}
                  {canManageWorkspace && (
                    <button
                      className="webapp-workspace-details-button"
                      type="button"
                      aria-label={`Share ${workspace.title}`}
                      title={`Share ${workspace.title}`}
                      onClick={() => onOpenWorkspaceShare(workspace.id)}
                    ><ShareGlyph /></button>
                  )}
                  {canDiscloseSessions && (
                    <button
                      className="webapp-workspace-disclosure"
                      type="button"
                      aria-expanded={!sessionsCollapsed}
                      aria-controls={sessionsId}
                      aria-label={`${sessionsCollapsed ? 'Expand' : 'Collapse'} sessions for ${workspace.title}`}
                      onClick={() => toggleWorkspaceSessions(workspace.id)}
                    >
                      <span aria-hidden="true">▾</span>
                    </button>
                  )}
                  <div className="webapp-workspace-meta">
                    {sessionsCollapsed && (
                      <span className="webapp-workspace-session-count">{sessionCountLabel}</span>
                    )}
                    <span className="webapp-workspace-details">
                      <span
                        className={`webapp-workspace-status-badge webapp-workspace-status-badge--${stateLabel}`}
                      >{stateLabel}</span>
                      {workspace.machineType && (
                        <span className="webapp-workspace-machine">
                          {workspace.machineType}
                        </span>
                      )}
                      {!workspace.canControl && <OwnerTag workspace={workspace} />}
                    </span>
                  </div>
                  {workspace.canControl && (
                    <button
                      className="webapp-workspace-menu"
                      type="button"
                      aria-label={`Workspace details for ${workspace.title}`}
                      title={`Workspace details for ${workspace.title}`}
                      onClick={() => onOpenWorkspaceDetails(workspace.id)}
                    >
                      <span className="codicon codicon-ellipsis" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {canDiscloseSessions && (
                  <div
                    className="webapp-workspace-sessions"
                    id={sessionsId}
                    role="group"
                    aria-label={`Sessions in ${workspace.title}`}
                    hidden={sessionsCollapsed}
                  >
                    {railSessions.map((session, index) => {
                      const sessionActive = workspaceActive
                        && (session.id === activeSessionId || (!activeSessionId && index === 0));
                      return (
                        <button
                          className={`webapp-session${sessionActive ? ' webapp-session--active' : ''}`}
                          type="button"
                          key={session.id}
                          data-rail-session-id={session.id}
                          aria-current={sessionActive ? 'page' : undefined}
                          onClick={() => onSelectSession(session.id)}
                        >
                          <SessionTypeIcon
                            type={session.agent}
                            className={`webapp-tree-icon webapp-tree-icon--${session.agent}`}
                            filePath={session.filePath}
                          />
                          <span className="webapp-session-label">{session.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </nav>

        <a
          className="webapp-support"
          href="https://discord.gg/VsywH6GNhB"
          target="_blank"
          rel="noreferrer"
        >Having issues? Ask us on Discord</a>

        <button
          className="webapp-user"
          type="button"
          title="Settings"
          aria-label={`Open settings for ${userLabel}`}
          onClick={onOpenSettings}
        >
          {identity?.avatarUrl
            ? <img className="webapp-avatar" src={identity.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : <IdentityAvatar label={userLabel} />}
          <span className="webapp-user-copy">
            <span>{userLabel}</span>
          </span>
        </button>
      </aside>
      <button
        className={`drive-rail-scrim${drawerOpen ? ' drive-rail-scrim--open' : ''}`}
        type="button"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={onCloseDrawer}
      />
    </>
  );
}
