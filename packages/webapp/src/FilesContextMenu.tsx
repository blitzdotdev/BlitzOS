import type { FormEvent, RefObject } from 'react';
import type { FolderAttachmentView } from '@blitzos/schema';
import { fullDavPath } from './files';

export type FilesContextMenuState = {
  x: number;
  y: number;
  directory: string;
  target?: { path: string; name: string; kind: 'file' | 'directory' };
  createKind?: 'file' | 'folder';
  renaming?: boolean;
};

/** The files view right-click popup: create actions plus the Drive bridges
 * (open a synced attachment in Drive, publish a top-level directory). */
export function FilesContextMenu({
  menu,
  popupRef,
  firstActionRef,
  inputRef,
  createName,
  createError,
  creating,
  driveFolder,
  shareablePath,
  onNameChange,
  onPickCreateKind,
  onPickRename,
  onSubmit,
  onClose,
  onOpenDriveFolder,
  onShareToDrive,
}: {
  menu: FilesContextMenuState;
  popupRef: RefObject<HTMLDivElement | null>;
  firstActionRef: RefObject<HTMLButtonElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  createName: string;
  createError: string | null;
  creating: boolean;
  driveFolder: FolderAttachmentView | undefined;
  shareablePath: string;
  onNameChange: (name: string) => void;
  onPickCreateKind: (kind: 'file' | 'folder') => void;
  onPickRename: () => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onOpenDriveFolder: (folderId: string) => void;
  onShareToDrive: (path: string) => void;
}) {
  return (
    <div
      className="files-context-menu"
      ref={popupRef}
      role={menu.createKind || menu.renaming ? 'dialog' : 'menu'}
      aria-label={menu.renaming
        ? `Rename ${menu.target?.name ?? 'item'}`
        : menu.createKind
          ? `Create ${menu.createKind}`
        : `Create in ${fullDavPath(menu.directory)}`}
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.createKind || menu.renaming ? (
        <form onSubmit={onSubmit}>
          <div className="files-context-menu-label">
            {menu.renaming
              ? `Rename ${menu.target?.name ?? 'item'}`
              : `New ${menu.createKind} in ${fullDavPath(menu.directory)}`}
          </div>
          <input
            ref={inputRef}
            aria-label={menu.renaming
              ? 'New name'
              : `${menu.createKind === 'file' ? 'File' : 'Folder'} name`}
            value={createName}
            disabled={creating}
            onChange={(event) => onNameChange(event.target.value)}
          />
          {createError && <div className="files-context-menu-error" role="alert">{createError}</div>}
          <div className="files-context-menu-actions">
            <button type="button" disabled={creating} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={creating || createName.trim().length === 0}>
              {creating ? (menu.renaming ? 'Renaming…' : 'Creating…') : (menu.renaming ? 'Rename' : 'Create')}
            </button>
          </div>
        </form>
      ) : (
        <>
          <button
            ref={firstActionRef}
            type="button"
            role="menuitem"
            onClick={() => onPickCreateKind('file')}
          >
            <span className="codicon codicon-new-file" aria-hidden="true" />
            New file…
          </button>
          <button type="button" role="menuitem" onClick={() => onPickCreateKind('folder')}>
            <span className="codicon codicon-new-folder" aria-hidden="true" />
            New folder…
          </button>
          {menu.target !== undefined && (
            <button type="button" role="menuitem" onClick={onPickRename}>
              <span className="codicon codicon-edit" aria-hidden="true" />
              Rename…
            </button>
          )}
          {driveFolder !== undefined && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onOpenDriveFolder(driveFolder.id);
              }}
            >
              <span className="codicon codicon-link-external" aria-hidden="true" />
              Open in Drive
            </button>
          )}
          {shareablePath !== '' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onShareToDrive(shareablePath);
              }}
            >
              <span className="codicon codicon-live-share" aria-hidden="true" />
              Share to Drive…
            </button>
          )}
        </>
      )}
    </div>
  );
}
