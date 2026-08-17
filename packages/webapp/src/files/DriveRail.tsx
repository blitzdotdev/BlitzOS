import { useEffect, useRef, useState } from 'react';
import type { IdentityRecord, OrgRecord } from '../protocol';
import type { DriveScope } from '../sessions-page-state';
import type { CloudWorkspaceModel } from '../workspace-store';
import { SessionTypeIcon, type WebAppTabModel } from '../WebAppHeader';
import { MoreIcon, NewWorkspaceIcon, OrganizationIcon } from '../WebAppIcons';
import {
  CloseGlyph,
  DriveGlyph,
  FolderPlusGlyph,
  PlusGlyph,
  SharedGlyph,
  UploadGlyph,
} from './DriveIcons';

/** Brandon's cockpit rail (monorepov2 PR #252) with one insertion: the Drive
 * block — the New pill plus My Drive / Shared with me — keeps its own look
 * between the organization header and the workspace tree. */

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
  driveScope,
  identity,
  org,
  organizations,
  uploadTargetName,
  sessions,
  activeSessionId,
  onSelectSession,
  onOpenDrive,
  onSelectWorkspace,
  onCreateWorkspace,
  onNewFolder,
  onUploadFile,
  onSwitchOrg,
  onOpenSettings,
  onSignOut,
  onOpenWorkspaceDetails,
  onDeleteWorkspace,
  drawerOpen,
  onCloseDrawer,
}: {
  workspaces: CloudWorkspaceModel[];
  activeWorkspaceId: string | null;
  driveScope: DriveScope | null;
  identity: IdentityRecord | null;
  org: OrgRecord | null;
  organizations: OrgRecord[];
  uploadTargetName: string | null;
  sessions: WebAppTabModel[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onOpenDrive: (scope: DriveScope) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onNewFolder: () => void;
  onUploadFile: () => void;
  onSwitchOrg: (orgId: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  onOpenWorkspaceDetails: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
  const orgSelector = useRef<HTMLDivElement>(null);
  const orgLabel = org?.name || org?.slug || 'Organization';
  const userLabel = identity?.name || identity?.email || 'BlitzOS';

  useEffect(() => {
    if (!orgMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      if (!orgSelector.current?.contains(event.target as Node)) setOrgMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOrgMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
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
        <div className="webapp-org-wrap" ref={orgSelector}>
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
          <div className="webapp-org-menu" id="webapp-org-menu" role="menu" hidden={!orgMenuOpen}>
            <div className="webapp-org-menu-label">organization</div>
            <div className="webapp-org-menu-current" role="menuitemradio" aria-checked="true">
              <span>{orgLabel}</span>
              <span aria-hidden="true">✓</span>
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
          </div>
        </div>

        <div className="drive-rail-section">
          Drive
          <button
            className="webapp-workspace-add"
            type="button"
            title="New in Drive"
            aria-label="New in Drive"
            aria-haspopup="menu"
            aria-expanded={newOpen}
            onClick={() => setNewOpen((open) => !open)}
          ><PlusGlyph /></button>
        </div>
        <nav className="drive-rail-nav" aria-label="Locations">
          <button
            className={`drive-rail-row${driveScope === 'mine' ? ' drive-rail-row--active' : ''}`}
            type="button"
            aria-current={driveScope === 'mine' ? 'page' : undefined}
            onClick={() => onOpenDrive('mine')}
          >
            <DriveGlyph /><span>My Drive</span>
          </button>
          <button
            className={`drive-rail-row${driveScope === 'shared' ? ' drive-rail-row--active' : ''}`}
            type="button"
            aria-current={driveScope === 'shared' ? 'page' : undefined}
            onClick={() => onOpenDrive('shared')}
          >
            <SharedGlyph /><span>Shared with me</span>
          </button>
        </nav>

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
                  {workspace.canControl && !sessionsCollapsed && (
                    <button
                      className="webapp-workspace-details-button"
                      type="button"
                      aria-label={`View details for ${workspace.title}`}
                      title={`View details for ${workspace.title}`}
                      onClick={() => onOpenWorkspaceDetails(workspace.id)}
                    ><MoreIcon /></button>
                  )}
                  {workspace.canControl && (
                    <button
                      className="webapp-workspace-delete"
                      type="button"
                      aria-label={`Delete ${workspace.title}`}
                      title={`Delete ${workspace.title}`}
                      onClick={() => onDeleteWorkspace(workspace.id)}
                    >
                      <span className="mi-trash" aria-hidden="true" />
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
                          {session.pending && (
                            <span className="webapp-session-spinner" aria-label="working" />
                          )}
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
          title="Account"
          aria-haspopup="menu"
          aria-expanded={accountOpen}
          aria-label={`Open account menu for ${userLabel}`}
          onClick={() => setAccountOpen((open) => !open)}
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
      {newOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            style={{ position: 'fixed', inset: 0, zIndex: 190, border: 0, background: 'transparent', cursor: 'default' }}
            onClick={() => setNewOpen(false)}
          />
          <div className="drive-menu" role="menu" style={{ left: 16, top: 88, zIndex: 410 }}>
            <button
              className="drive-menu-item"
              type="button"
              role="menuitem"
              onClick={() => { setNewOpen(false); onNewFolder(); }}
            >
              <FolderPlusGlyph /><span>New folder</span>
            </button>
            <button
              className="drive-menu-item"
              type="button"
              role="menuitem"
              disabled={uploadTargetName === null}
              title={uploadTargetName === null ? 'Open a folder you can edit first' : `Upload into ${uploadTargetName}`}
              onClick={() => { setNewOpen(false); onUploadFile(); }}
            >
              <UploadGlyph /><span>Upload file</span>
            </button>
          </div>
        </>
      )}
      {accountOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            style={{ position: 'fixed', inset: 0, zIndex: 190, border: 0, background: 'transparent', cursor: 'default' }}
            onClick={() => setAccountOpen(false)}
          />
          <div
            className="drive-menu"
            role="menu"
            style={{ left: 16, bottom: 64, zIndex: 410 }}
          >
            <button
              className="drive-menu-item"
              type="button"
              role="menuitem"
              onClick={() => { setAccountOpen(false); onOpenSettings(); }}
            >
              <DriveGlyph /><span>Settings</span>
            </button>
            <div className="drive-menu-divider" />
            <button
              className="drive-menu-item"
              type="button"
              role="menuitem"
              onClick={() => { setAccountOpen(false); onSignOut(); }}
            >
              <CloseGlyph /><span>Sign out</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
