import { useState } from 'react';
import type { IdentityRecord, OrgRecord } from '../protocol';
import type { DriveScope } from '../sessions-page-state';
import type { CloudWorkspaceModel } from '../workspace-store';
import { DriveAvatar } from './DriveAvatar';
import {
  BoxGlyph,
  CloseGlyph,
  DriveGlyph,
  FolderPlusGlyph,
  PlusGlyph,
  SharedGlyph,
  UploadGlyph,
} from './DriveIcons';

export function DriveRail({
  workspaces,
  activeWorkspaceId,
  driveScope,
  identity,
  org,
  organizations,
  uploadTargetName,
  onOpenDrive,
  onSelectWorkspace,
  onCreateWorkspace,
  onNewFolder,
  onUploadFile,
  onSwitchOrg,
  onOpenSettings,
  onSignOut,
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
  onOpenDrive: (scope: DriveScope) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onNewFolder: () => void;
  onUploadFile: () => void;
  onSwitchOrg: (orgId: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const label = identity?.name || identity?.email || 'BlitzOS';
  const stateLabel = (workspace: CloudWorkspaceModel): string => {
    if (workspace.lifecycleStatus === 'running') return 'online';
    if (workspace.lifecycleStatus === 'error') return 'failed';
    return workspace.lifecycleStatus;
  };

  return (
    <>
      <aside
        className={`drive-rail${drawerOpen ? ' drive-rail--open' : ''}`}
        aria-label="Navigation"
      >
        <div className="drive-rail-brand">
          <span className="drive-rail-mark"><BoxGlyph /></span>
          <strong>{org?.name || org?.slug || 'BlitzOS'}</strong>
          <button
            className="drive-icon-button drive-rail-close"
            type="button"
            aria-label="Close navigation"
            onClick={onCloseDrawer}
          >
            <CloseGlyph />
          </button>
        </div>
        {driveScope === 'shared'
          ? <div className="drive-rail-new-placeholder" aria-hidden="true" />
          : (
            <button
              className="drive-rail-new"
              type="button"
              aria-haspopup="menu"
              aria-expanded={newOpen}
              onClick={() => setNewOpen((open) => !open)}
            >
              <PlusGlyph />New
            </button>
          )}
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
        <div className="drive-rail-scroll">
          <div className="drive-rail-section">
            Workspaces
            <button
              type="button"
              aria-label="New workspace"
              title="New workspace"
              onClick={onCreateWorkspace}
            >
              <PlusGlyph />
            </button>
          </div>
          {workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspaceId;
            return (
              <button
                className={`drive-rail-ws${active ? ' drive-rail-row--active' : ''}`}
                type="button"
                aria-current={active ? 'page' : undefined}
                data-workspace-id={workspace.id}
                key={workspace.id}
                onClick={() => onSelectWorkspace(workspace.id)}
              >
                <BoxGlyph />
                <span>{workspace.title}</span>
                {workspace.accessRole === 'owner' || !workspace.owner
                  ? (
                    <span
                      className={`webapp-workspace-status-badge webapp-workspace-status-badge--${stateLabel(workspace)}`}
                    >{stateLabel(workspace)}</span>
                  )
                  : (
                    <DriveAvatar
                      name={workspace.owner.name}
                      avatarUrl={workspace.owner.avatarUrl}
                    />
                  )}
              </button>
            );
          })}
        </div>
        <button
          className="drive-rail-account"
          type="button"
          aria-haspopup="menu"
          aria-expanded={accountOpen}
          onClick={() => setAccountOpen((open) => !open)}
        >
          <DriveAvatar name={label} avatarUrl={identity?.avatarUrl} me size="md" />
          <span className="drive-rail-account-copy">
            <strong>{label}</strong>
            <span>{org?.name || org?.slug || ''}</span>
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
          <div className="drive-menu" role="menu" style={{ left: 16, top: 122, zIndex: 410 }}>
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
            {organizations.filter((candidate) => candidate.id !== org?.id).map((candidate) => (
              <button
                className="drive-menu-item"
                type="button"
                role="menuitem"
                key={candidate.id}
                onClick={() => { setAccountOpen(false); onSwitchOrg(candidate.id); }}
              >
                <BoxGlyph /><span>Switch to {candidate.name || candidate.slug}</span>
              </button>
            ))}
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
