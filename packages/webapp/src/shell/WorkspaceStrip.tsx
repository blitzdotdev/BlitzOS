import { useEffect, useState } from 'react';
import type { TenantMe } from '../api-adapter';
import type { CloudWorkspaceModel } from '../workspace-store';
import { DriveGlyph, PlusGlyph } from './StripIcons';

/** The tile legend: initials when the name has several words, otherwise its
 * first two letters. `design-team` reads DT and `engineering` reads EN, as the
 * mockup draws them. */
export function workspaceCode(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return '··';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words.slice(0, 3).map((word) => word[0]!).join('').toUpperCase();
}

function stateLabel(workspace: CloudWorkspaceModel): string {
  if (workspace.lifecycleStatus === 'creating') return 'creating';
  if (workspace.lifecycleStatus === 'error') return 'failed';
  if (workspace.lifecycleStatus === 'running') return 'online';
  return workspace.lifecycleStatus;
}

export type WorkspaceStripProps = {
  workspaces: CloudWorkspaceModel[];
  viewer: TenantMe | null;
  activeWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  onOpenDrive: () => void;
  onOpenSettings: () => void;
  onCloseDrawer: () => void;
};

/** Column one of the shell (plans/mockups/session-rail.html `#strip`): the org
 * mark, one tile per workspace, the create tile, Drive, and the account menu
 * on the bottom edge. The workspace panels are the right icon strip's job. */
export function WorkspaceStrip({
  workspaces,
  viewer,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  onSwitchOrg,
  onCreateOrg,
  onOpenDrive,
  onOpenSettings,
  onCloseDrawer,
}: WorkspaceStripProps) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const orgLabel = viewer?.org.name || viewer?.org.slug || 'Organization';
  const userLabel = viewer?.identity.name || viewer?.identity.email || 'BlitzOS';

  useEffect(() => {
    if (!orgMenuOpen && !accountMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOrgMenuOpen(false);
      setAccountMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [accountMenuOpen, orgMenuOpen]);

  return (
    <aside className="shell-strip" aria-label="Cloud workspaces">
      <button
        className="shell-strip__close"
        type="button"
        aria-label="Close workspace navigation"
        onClick={onCloseDrawer}
      >×</button>

      <div className="webapp-org-wrap shell-strip__orgwrap">
        <button
          className="shell-orgmark"
          type="button"
          aria-label={`Organization: ${orgLabel}`}
          title={orgLabel}
          aria-haspopup="menu"
          aria-expanded={orgMenuOpen}
          aria-controls="webapp-org-menu"
          onClick={() => {
            setAccountMenuOpen(false);
            setOrgMenuOpen((open) => !open);
          }}
        >{orgLabel.trim().charAt(0).toUpperCase() || 'B'}</button>
        {orgMenuOpen && (
          <button
            className="webapp-org-backdrop"
            type="button"
            aria-label="Close organization menu"
            tabIndex={-1}
            onMouseDown={() => setOrgMenuOpen(false)}
          />
        )}
        <div
          className="webapp-org-menu shell-strip__menu"
          id="webapp-org-menu"
          role="menu"
          aria-label="Organizations"
          hidden={!orgMenuOpen}
        >
          <div className="webapp-org-menu-label">organization</div>
          <div className="webapp-org-menu-current" role="menuitemradio" aria-checked="true">
            <span>{orgLabel}</span>
            <span className="webapp-org-menu-check" aria-hidden="true">✓</span>
          </div>
          {(viewer?.organizations ?? [])
            .map(({ org }) => org)
            .filter((candidate) => candidate.id !== viewer?.org.id)
            .map((candidate) => (
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

      <div className="shell-strip__sep" role="presentation" />

      <nav className="shell-strip__tiles" aria-label="Workspaces">
        {workspaces.map((workspace) => {
          const active = workspace.canControl && workspace.id === activeWorkspaceId;
          const offline = workspace.lifecycleStatus !== 'running';
          const owner = workspace.canControl ? null : workspace.owner?.name ?? 'a teammate';
          return (
            <button
              className={`shell-wtile${active ? ' shell-wtile--on' : ''}${
                offline ? ' shell-wtile--off' : ''}`}
              type="button"
              key={workspace.id}
              aria-label={workspace.title}
              aria-current={active ? 'page' : undefined}
              disabled={!workspace.canControl}
              title={owner === null
                ? `${workspace.title} — ${stateLabel(workspace)}`
                : `${workspace.title} — shared by ${owner}`}
              onClick={() => onSelectWorkspace(workspace.id)}
            >{workspaceCode(workspace.title)}</button>
          );
        })}
        <button
          className="shell-wtile shell-wtile--off shell-wtile--new"
          type="button"
          aria-label="Create workspace"
          title="New workspace"
          onClick={onCreateWorkspace}
        ><PlusGlyph className="shell-wtile__plus" /></button>
      </nav>

      <div className="shell-strip__spacer" role="presentation" />

      <nav className="shell-strip__surfaces" aria-label="Drive">
        <button
          className="shell-ic"
          type="button"
          aria-label="Drive"
          title="Drive"
          onClick={onOpenDrive}
        ><DriveGlyph className="shell-ic__glyph" /></button>
      </nav>

      <div className="shell-strip__sep" role="presentation" />

      <div className="shell-strip__account">
        <button
          className="shell-av"
          type="button"
          aria-label={`Account: ${userLabel}`}
          title={userLabel}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          onClick={() => {
            setOrgMenuOpen(false);
            setAccountMenuOpen((open) => !open);
          }}
        >
          {viewer?.identity.avatarUrl
            ? <img className="shell-av__photo" src={viewer.identity.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : userLabel.trim().charAt(0).toUpperCase() || 'B'}
        </button>
        {accountMenuOpen && (
          <button
            className="webapp-org-backdrop"
            type="button"
            aria-label="Close account menu"
            tabIndex={-1}
            onMouseDown={() => setAccountMenuOpen(false)}
          />
        )}
        <div
          className="webapp-org-menu shell-strip__menu shell-strip__menu--account"
          role="menu"
          aria-label="Account"
          hidden={!accountMenuOpen}
        >
          <div className="webapp-org-menu-label">{userLabel}</div>
          <button
            className="webapp-org-menu-create"
            type="button"
            role="menuitem"
            onClick={() => {
              setAccountMenuOpen(false);
              onOpenDrive();
            }}
          ><span>Drive</span></button>
          <button
            className="webapp-org-menu-create"
            type="button"
            role="menuitem"
            onClick={() => {
              setAccountMenuOpen(false);
              onOpenSettings();
            }}
          ><span>Settings</span></button>
          <a
            className="webapp-org-menu-create"
            role="menuitem"
            href="https://discord.gg/VsywH6GNhB"
            target="_blank"
            rel="noreferrer"
            onClick={() => setAccountMenuOpen(false)}
          ><span>Ask us on Discord</span></a>
        </div>
      </div>
    </aside>
  );
}
