import { useEffect, useRef, useState } from 'react';
import { SessionTypeIcon, type CockpitSessionType } from './CockpitHeader';
import { machineTypeLabel } from './MachineCatalogGrid';
import type { IdentityRecord, OrgRecord } from './protocol';
import type { CloudWorkspaceModel } from './workspace-store';

export type RailSession = {
  id: string;
  label: string;
  agent: CockpitSessionType;
};

type CockpitRailProps = {
  workspaces: CloudWorkspaceModel[];
  activeWorkspaceId: string;
  activeSessionId: string;
  activeSessions: RailSession[];
  identity: IdentityRecord | null;
  org: OrgRecord | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onCreateWorkspace: () => void;
  onOpenSettings: () => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  mobile?: boolean;
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
};

function identityLabel(identity: IdentityRecord | null): string {
  return identity?.name || identity?.githubLogin || 'Cloud control plane';
}

export function workspaceStateLabel(workspace: CloudWorkspaceModel): string {
  if (workspace.lifecycleStatus === 'creating') return 'creating';
  if (workspace.lifecycleStatus === 'provisioning') return 'provisioning';
  if (workspace.lifecycleStatus === 'parking') return 'parking';
  if (workspace.lifecycleStatus === 'parked') return 'parked';
  if (workspace.lifecycleStatus === 'resuming') return 'waking';
  if (workspace.lifecycleStatus === 'error') return 'failed';
  if (workspace.lifecycleStatus === 'stopped') return 'stopped';
  return 'online';
}

function IdentityAvatar({ label }: { label: string }) {
  const initial = label.trim().charAt(0).toUpperCase() || 'B';
  return (
    <svg className="cockpit-avatar" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="14" />
      <text x="14" y="14" dy="0.36em" textAnchor="middle">{initial}</text>
    </svg>
  );
}

function WorkspaceMemberAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl: string | null;
  className?: string;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || 'M';
  return avatarUrl
    ? <img className={className} src={avatarUrl} alt="" referrerPolicy="no-referrer" />
    : <span className={className} aria-hidden="true">{initial}</span>;
}

function OwnerTag({ workspace }: { workspace: CloudWorkspaceModel }) {
  if (!workspace.owner) return null;
  return (
    <span className="cockpit-workspace-owner">
      <WorkspaceMemberAvatar
        name={workspace.owner.name}
        avatarUrl={workspace.owner.avatarUrl}
        className={workspace.owner.avatarUrl ? undefined : 'cockpit-workspace-owner-fallback'}
      />
      <span>{workspace.owner.name}</span>
    </span>
  );
}

export function CockpitRail({
  workspaces,
  activeWorkspaceId,
  activeSessionId,
  activeSessions,
  identity,
  org,
  onSelectWorkspace,
  onSelectSession,
  onCreateWorkspace,
  onOpenSettings,
  onDeleteWorkspace = () => undefined,
  mobile = false,
  drawerOpen = false,
  onCloseDrawer = () => undefined,
}: CockpitRailProps) {
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
  const drawerClose = useRef<HTMLButtonElement>(null);
  const orgLabel = org?.name || org?.slug || 'Organization';
  const userLabel = identityLabel(identity);

  useEffect(() => {
    if (!mobile || !drawerOpen) return;
    const frame = window.requestAnimationFrame(() => drawerClose.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [drawerOpen, mobile]);

  const closeAfter = (action: () => void) => {
    action();
    if (mobile) onCloseDrawer();
  };

  const toggleWorkspaceSessions = (workspaceId: string) => {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  return (
    <aside
      id="cockpit-navigation-drawer"
      className={`cockpit-rail${drawerOpen ? ' cockpit-rail--drawer-open' : ''}`}
      aria-label="Cloud workspaces"
      aria-hidden={mobile && !drawerOpen ? true : undefined}
      inert={mobile && !drawerOpen}
    >
      <div className="cockpit-org-wrap">
        <div className="cockpit-org-button">
          <strong>{orgLabel}</strong>
        </div>
        <button
          className="cockpit-workspace-add"
          type="button"
          title="Create workspace"
          aria-label="Create workspace"
          onClick={() => closeAfter(onCreateWorkspace)}
        >+</button>
        <button
          ref={drawerClose}
          className="cockpit-drawer-close"
          type="button"
          aria-label="Close workspace navigation"
          onClick={onCloseDrawer}
        >×</button>
      </div>

      <nav className="cockpit-tree" aria-label="Workspace windows">
        {workspaces.length === 0 && <div className="cockpit-tree-empty">No workspaces yet</div>}
        {workspaces.map((workspace) => {
          const workspaceActive = workspace.canControl
            && workspace.id === activeWorkspaceId;
          const stateLabel = workspaceStateLabel(workspace);
          // v2 sessions are the live ttyd tabs, which exist only for the active
          // workspace; other workspaces have no loaded session state.
          const sessions: RailSession[] = workspaceActive ? activeSessions : [];
          const sessionsId = `workspace-sessions-${workspace.id}`;
          const canDiscloseSessions = workspace.canControl && sessions.length > 0;
          const sessionsCollapsed = canDiscloseSessions && collapsedWorkspaceIds.has(workspace.id);
          // Keyed on canControl, not canDiscloseSessions. The delete button is
          // revealed by `--expanded`, so gating that class on having sessions made
          // deletion unreachable for a workspace with none — exactly the workspace a
          // user most wants to remove. A workspace with nothing to disclose is
          // expanded by definition; the disclosure control itself still requires
          // sessions.
          const sessionsVisibilityClass = workspace.canControl
            ? sessionsCollapsed ? ' cockpit-workspace--collapsed' : ' cockpit-workspace--expanded'
            : '';
          const sessionCountLabel = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
          const workspaceRow = (
            <>
              <span
                className={`cockpit-tree-icon mi-box${
                  workspace.lifecycleStatus === 'parked'
                    ? ' cockpit-tree-icon--asleep'
                    : workspace.lifecycleStatus === 'running'
                      ? ' cockpit-tree-icon--online'
                      : ''
                }`}
                aria-hidden="true"
              />
              <span className="cockpit-workspace-copy">
                <span className="cockpit-workspace-name">{workspace.title}</span>
                {workspace.lifecycleStatus === 'error' && workspace.errorDetail && (
                  <span className="cockpit-workspace-error-detail" role="alert">
                    {workspace.errorDetail}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <section
              className={`cockpit-workspace${
                workspace.canControl ? ' cockpit-workspace--controllable' : ''
              }${workspaceActive ? ' cockpit-workspace--active' : ''}${
                workspace.lifecycleStatus === 'parked' ? ' cockpit-workspace--parked' : ''
              }${sessionsVisibilityClass}`}
              data-workspace-id={workspace.id}
              key={workspace.id}
            >
              <div className={`cockpit-workspace-item${
                workspace.lifecycleStatus === 'error'
                  ? ' cockpit-workspace-item--error'
                  : ''
              }`}>
                {workspace.canControl ? (
                  <button
                    className={`cockpit-workspace-button${
                      canDiscloseSessions ? ' cockpit-workspace-button--disclosable' : ''
                    }`}
                    type="button"
                    aria-current={workspaceActive ? 'page' : undefined}
                    onClick={() => closeAfter(() => {
                      onSelectWorkspace(workspace.id);
                      if (workspaceActive && canDiscloseSessions) {
                        toggleWorkspaceSessions(workspace.id);
                      }
                    })}
                  >{workspaceRow}</button>
                ) : workspace.shared && org ? (
                  <a
                    className="cockpit-workspace-button cockpit-workspace-button--readonly cockpit-workspace-button--shared"
                    href={`/observe/${encodeURIComponent(org.id)}?${new URLSearchParams({ workspace: workspace.id })}`}
                  >{workspaceRow}</a>
                ) : (
                  <div className="cockpit-workspace-button cockpit-workspace-button--readonly">{workspaceRow}</div>
                )}
                {canDiscloseSessions && (
                  <button
                    className="cockpit-workspace-disclosure"
                    type="button"
                    aria-expanded={!sessionsCollapsed}
                    aria-controls={sessionsId}
                    aria-label={`${sessionsCollapsed ? 'Expand' : 'Collapse'} sessions for ${workspace.title}`}
                    onClick={() => toggleWorkspaceSessions(workspace.id)}
                  >
                    <span aria-hidden="true">▾</span>
                  </button>
                )}
                <div className="cockpit-workspace-meta">
                  {sessionsCollapsed && (
                    <span className="cockpit-workspace-session-count">{sessionCountLabel}</span>
                  )}
                  <span className="cockpit-workspace-details">
                    <span
                      className={`cockpit-workspace-status-badge cockpit-workspace-status-badge--${stateLabel}`}
                    >{stateLabel}</span>
                    {workspace.machineType && (
                      <span className="cockpit-workspace-machine">
                        {machineTypeLabel(workspace.machineType)}
                      </span>
                    )}
                    {!workspace.canControl && <OwnerTag workspace={workspace} />}
                  </span>
                </div>
                {workspace.canControl && (
                  <button
                    className="cockpit-workspace-delete"
                    type="button"
                    aria-label={`Delete ${workspace.title}`}
                    title={`Delete ${workspace.title}`}
                    tabIndex={sessionsCollapsed ? -1 : undefined}
                    onClick={() => onDeleteWorkspace(workspace.id)}
                  >
                    <span className="mi-trash" aria-hidden="true" />
                  </button>
                )}
              </div>
              {canDiscloseSessions && (
                <div
                  className="cockpit-workspace-sessions"
                  id={sessionsId}
                  role="group"
                  aria-label={`Sessions in ${workspace.title}`}
                  hidden={sessionsCollapsed}
                >
                  {sessions.map((session, index) => {
                    const sessionActive = workspaceActive
                      && (session.id === activeSessionId || (!activeSessionId && index === 0));
                    return (
                      <button
                        className={`cockpit-session${sessionActive ? ' cockpit-session--active' : ''}`}
                        type="button"
                        key={session.id}
                        aria-current={sessionActive ? 'page' : undefined}
                        onClick={() => closeAfter(() => onSelectSession(workspace.id, session.id))}
                      >
                        <SessionTypeIcon type={session.agent} className="cockpit-tree-icon" />
                        <span>{session.label}</span>
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
        className="cockpit-support"
        href="https://discord.gg/VsywH6GNhB"
        target="_blank"
        rel="noreferrer"
      >
        Having issues? Ask us on Discord
      </a>

      <button
        className="cockpit-user"
        type="button"
        title="Settings"
        aria-label={`Open settings for ${userLabel}`}
        onClick={() => closeAfter(onOpenSettings)}
      >
        <IdentityAvatar label={userLabel} />
        <span className="cockpit-user-copy">
          <span>{userLabel}</span>
          <span className="cockpit-user-org">{orgLabel}</span>
        </span>
      </button>
    </aside>
  );
}
