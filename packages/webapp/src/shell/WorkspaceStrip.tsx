import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { TenantMe } from '../api-adapter';
import type { CloudWorkspaceModel } from '../workspace-store';
import { DriveGlyph, PlusGlyph } from './StripIcons';
import { workspaceTileStyle } from './workspace-tile';
import { squareAvatarUrl } from '../avatar-url';

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

/** The context menu's own geometry, in viewport coordinates, and the
 * workspace it belongs to. Clamped when it opens, exactly as the tab strip's
 * menu is. */
type TileMenu = { workspaceId: string; left: number; top: number };

const TILE_MENU_WIDTH = 190;
const TILE_MENU_HEIGHT = 140;

export type WorkspaceStripProps = {
  workspaces: CloudWorkspaceModel[];
  viewer: TenantMe | null;
  activeWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  /** The three verbs the tile's context menu offers. Rename writes the name
   * through the same PATCH the settings tab uses; the other two open the
   * details dialog on the tab that answers them. */
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  onInviteToWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  onOpenDrive: () => void;
  onOpenSettings: () => void;
  onCloseDrawer: () => void;
};

/** Column one of the shell (plans/mockups/session-rail.html `#strip`): the org
 * mark, one tile per workspace, the create tile, Drive, and the avatar on the
 * bottom edge, which goes straight to settings. The workspace panels are the
 * right icon strip's job. */
export function WorkspaceStrip({
  workspaces,
  viewer,
  activeWorkspaceId,
  onSelectWorkspace,
  onRenameWorkspace,
  onOpenWorkspaceSettings,
  onInviteToWorkspace,
  onCreateWorkspace,
  onSwitchOrg,
  onCreateOrg,
  onOpenDrive,
  onOpenSettings,
  onCloseDrawer,
}: WorkspaceStripProps) {
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [tileMenu, setTileMenu] = useState<TileMenu | null>(null);
  const [renaming, setRenaming] = useState<
    { workspaceId: string; value: string; left: number; top: number } | null
  >(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const orgLabel = viewer?.org.name || viewer?.org.slug || 'Organization';
  const userLabel = viewer?.identity.name || viewer?.identity.email || 'BlitzOS';

  useEffect(() => {
    if (!orgMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOrgMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [orgMenuOpen]);

  useEffect(() => {
    if (tileMenu === null && renaming === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTileMenu(null);
      setRenaming(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [renaming, tileMenu]);

  useEffect(() => {
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming?.workspaceId]);

  // Workspace admin, or an org admin reaching in implicitly (§3): the wire
  // reports the second as a null stored role on a workspace they can open.
  const menuWorkspace = tileMenu === null
    ? undefined
    : workspaces.find(({ id }) => id === tileMenu.workspaceId);
  const canManage = menuWorkspace?.myRole === 'admin' || menuWorkspace?.myRole === null;

  const openTileMenu = (event: ReactMouseEvent, workspace: CloudWorkspaceModel) => {
    event.preventDefault();
    setRenaming(null);
    setOrgMenuOpen(false);
    setTileMenu({
      workspaceId: workspace.id,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - TILE_MENU_WIDTH)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - TILE_MENU_HEIGHT)),
    });
  };

  const finishRename = () => {
    if (renaming === null) return;
    const name = renaming.value.trim();
    const current = workspaces.find(({ id }) => id === renaming.workspaceId);
    setRenaming(null);
    if (name !== '' && current !== undefined && name !== current.title) {
      onRenameWorkspace(renaming.workspaceId, name);
    }
  };

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
          onClick={() => setOrgMenuOpen((open) => !open)}
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
              style={workspaceTileStyle(workspace.id)}
              title={owner === null
                ? `${workspace.title} — ${stateLabel(workspace)}`
                : `${workspace.title} — shared by ${owner}`}
              onClick={() => onSelectWorkspace(workspace.id)}
              onContextMenu={(event) => openTileMenu(event, workspace)}
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

      {tileMenu !== null && menuWorkspace !== undefined && (
        <>
          {/* A div, not a button: with no global button reset, a fullscreen
            * button paints the UA's opaque button face over the whole app.
            * Same shape as WebAppHeader's tab-menu backdrop. */}
          <div
            className="webapp-session-backdrop"
            onMouseDown={() => setTileMenu(null)}
          />
          <div
            className="webapp-session-menu shell-wmenu"
            role="menu"
            aria-label={`Workspace ${menuWorkspace.title}`}
            style={{ left: tileMenu.left, top: tileMenu.top }}
          >
            {/* A member reads the settings and cannot administer the
              * workspace, so Rename and Invite are not offered to them (§3). */}
            {canManage && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRenaming({
                    workspaceId: menuWorkspace.id,
                    value: menuWorkspace.title,
                    left: tileMenu.left,
                    top: tileMenu.top,
                  });
                  setTileMenu(null);
                }}
              >
                <span className="codicon codicon-edit" aria-hidden="true" />
                <span>Rename</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setTileMenu(null);
                onOpenWorkspaceSettings(menuWorkspace.id);
              }}
            >
              <span className="codicon codicon-settings-gear" aria-hidden="true" />
              <span>Settings</span>
            </button>
            {canManage && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setTileMenu(null);
                  onInviteToWorkspace(menuWorkspace.id);
                }}
              >
                <span className="codicon codicon-person-add" aria-hidden="true" />
                <span>Invite</span>
              </button>
            )}
          </div>
        </>
      )}

      {renaming !== null && (
        <>
          <div
            className="webapp-session-backdrop"
            onMouseDown={finishRename}
          />
          <div
            className="webapp-session-menu shell-wmenu shell-wmenu--rename"
            style={{ left: renaming.left, top: renaming.top }}
          >
            <input
              ref={renameInput}
              aria-label="Workspace name"
              maxLength={64}
              value={renaming.value}
              onChange={(event) => setRenaming({
                ...renaming,
                value: event.currentTarget.value,
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  finishRename();
                }
              }}
            />
          </div>
        </>
      )}

      <div className="shell-strip__account">
        <button
          className="shell-av"
          type="button"
          aria-label="Settings"
          title={userLabel}
          onClick={onOpenSettings}
        >
          {viewer?.identity.avatarUrl
            ? <img className="shell-av__photo" src={squareAvatarUrl(viewer.identity.avatarUrl)} alt="" referrerPolicy="no-referrer" />
            : userLabel.trim().charAt(0).toUpperCase() || 'B'}
        </button>
      </div>
    </aside>
  );
}
