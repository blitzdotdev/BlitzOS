import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { TenantMe } from '../api-adapter';
import type { CloudWorkspaceModel } from '../workspace-store';
import { DriveGlyph, PlusGlyph } from './StripIcons';
import { workspaceSigil } from './workspace-tile';
import { squareAvatarUrl } from '../avatar-url';

export function WorkspaceSigilIcon({ workspaceId }: { workspaceId: string }) {
  const sigil = workspaceSigil(workspaceId);
  return (
    <svg
      className="shell-wtile__sigil"
      viewBox="0 0 5 5"
      preserveAspectRatio="none"
      focusable="false"
    >
      <rect width="5" height="5" fill={sigil.background} />
      {sigil.cells.map(([x, y]) => (
        <rect key={y * 5 + x} x={x} y={y} width="1" height="1" fill={sigil.foreground} />
      ))}
    </svg>
  );
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
  onOpenDrive: () => void;
  onOpenSettings: () => void;
  onCloseDrawer: () => void;
};

/** Column one of the shell (plans/mockups/session-rail.html `#strip`): one
 * tile per workspace, the create tile, Drive, and the avatar on the bottom
 * edge, which goes straight to settings. Only workspace tiles live up top —
 * the org mark read as one of them, so org switching moved to Settings →
 * Profile (owner annotation 2026-09-01). The workspace panels are the right
 * icon strip's job. */
export function WorkspaceStrip({
  workspaces,
  viewer,
  activeWorkspaceId,
  onSelectWorkspace,
  onRenameWorkspace,
  onOpenWorkspaceSettings,
  onInviteToWorkspace,
  onCreateWorkspace,
  onOpenDrive,
  onOpenSettings,
  onCloseDrawer,
}: WorkspaceStripProps) {
  const [tileMenu, setTileMenu] = useState<TileMenu | null>(null);
  const [renaming, setRenaming] = useState<
    { workspaceId: string; value: string; left: number; top: number } | null
  >(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const userLabel = viewer?.identity.name || viewer?.identity.email || 'BlitzOS';

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

      <nav className="shell-strip__tiles" aria-label="Workspaces">
        <div className="shell-strip__tree" role="tree" aria-label="Workspaces">
          {workspaces.map((workspace) => {
            const active = workspace.canControl && workspace.id === activeWorkspaceId;
            const offline = workspace.lifecycleStatus !== 'running';
            const owner = workspace.canControl ? null : workspace.owner?.name ?? 'a teammate';
            return (
              <button
                className="shell-wtile"
                type="button"
                key={workspace.id}
                role="treeitem"
                aria-label={workspace.title}
                aria-selected={active}
                aria-current={active ? 'page' : undefined}
                disabled={!workspace.canControl}
                title={owner === null
                  ? `${workspace.title} — ${stateLabel(workspace)}`
                  : `${workspace.title} — shared by ${owner}`}
                onClick={() => onSelectWorkspace(workspace.id)}
                onContextMenu={workspace.pendingCreate
                  ? undefined
                  : (event) => openTileMenu(event, workspace)}
              >
                <span className="shell-wtile__indicator" aria-hidden="true" />
                <span
                  className="shell-wtile__icon"
                  data-workspace-status={offline ? 'offline' : 'online'}
                  aria-hidden="true"
                >
                  <WorkspaceSigilIcon workspaceId={workspace.id} />
                </span>
              </button>
            );
          })}
        </div>
        <button
          className="shell-wtile shell-wtile--new"
          type="button"
          aria-label="Create workspace"
          title="New workspace"
          onClick={onCreateWorkspace}
        >
          <span className="shell-wtile__icon shell-wtile__icon--new" aria-hidden="true">
            <PlusGlyph className="shell-wtile__plus" />
          </span>
        </button>
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
