import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import type { WorkspaceView } from '@blitzos/schema';
import type { FolderObjectView, FolderView } from '../file-library-api';
import { drivePath, folderPagePath, type DriveScope } from '../sessions-page-state';
import { AttachFolderDialog } from './AttachFolderDialog';
import { DriveAvatar } from './DriveAvatar';
import {
  CloseGlyph,
  CheckGlyph,
  DownloadGlyph,
  FileGlyph,
  FolderGlyph,
  KebabGlyph,
  LinkGlyph,
  PencilGlyph,
  ShareGlyph,
  TrashGlyph,
} from './DriveIcons';
import {
  canManageFolder,
  canWriteFolder,
  entriesAt,
  formatBytes,
  formatWhen,
  normalizeFolderName,
  splitFolders,
} from './drive-model';
import { ShareFolderDialog } from './ShareFolderDialog';

export type DrivePageRoute =
  | { page: 'drive'; scope: DriveScope }
  | { page: 'folder'; folderId: string; folderPath: string[] };

export type DriveCommand = { kind: 'new-folder' | 'upload'; nonce: number };

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  run: () => void;
}

type DriveDialog =
  | { kind: 'share'; folderId: string }
  | { kind: 'attach'; folderId: string }
  | { kind: 'new-folder' }
  | { kind: 'rename'; folderId: string }
  | { kind: 'delete-folder'; folderId: string }
  | { kind: 'delete-object'; key: string; name: string };

interface UploadState {
  name: string;
  sent: number;
  total: number;
  done: boolean;
  folderName: string;
}

const SNACK_MS = 7_000;

export function FilesDrive({
  client,
  viewer,
  route,
  query,
  command,
  onNavigate,
  onUploadTarget,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
  route: DrivePageRoute;
  query: string;
  command: DriveCommand | null;
  onNavigate: (path: string) => void;
  onUploadTarget: (folderName: string | null) => void;
}) {
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [objects, setObjects] = useState<FolderObjectView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DriveDialog | null>(null);
  const [nameField, setNameField] = useState('');
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [snack, setSnack] = useState<React.ReactNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const snackTimer = useRef<number | null>(null);

  const folderId = route.page === 'folder' ? route.folderId : null;
  const path = route.page === 'folder' ? route.folderPath : [];
  const folder = folders.find(({ id }) => id === folderId) ?? null;
  const scope: DriveScope = route.page === 'drive'
    ? route.scope
    : folder === null || folder.role === 'owner' ? 'mine' : 'shared';

  const showSnack = useCallback((message: React.ReactNode) => {
    setSnack(message);
    if (snackTimer.current !== null) window.clearTimeout(snackTimer.current);
    snackTimer.current = window.setTimeout(() => setSnack(null), SNACK_MS);
  }, []);

  const loadFolders = useCallback(async () => {
    try {
      const response = await client.listFolders();
      setFolders(response.folders);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load folders.');
    }
  }, [client]);

  const loadObjects = useCallback(async (target: string) => {
    try {
      setObjects((await client.listFolderObjects(target)).objects);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load folder files.');
    }
  }, [client]);

  useEffect(() => { void loadFolders(); }, [loadFolders]);
  useEffect(() => {
    void client.poll()
      .then(({ workspaces: loaded }) => setWorkspaces(loaded))
      .catch((caught: Error) => setError(caught.message));
  }, [client]);
  useEffect(() => {
    if (folderId === null) {
      setObjects([]);
      return;
    }
    void loadObjects(folderId);
  }, [folderId, loadObjects]);

  const uploadTargetName = folder !== null && canWriteFolder(folder.role) ? folder.name : null;
  useEffect(() => {
    onUploadTarget(uploadTargetName);
    return () => onUploadTarget(null);
  }, [onUploadTarget, uploadTargetName]);

  useEffect(() => {
    if (command === null) return;
    if (command.kind === 'new-folder') {
      setNameField('');
      setDialog({ kind: 'new-folder' });
      return;
    }
    fileInput.current?.click();
  }, [command]);

  const { mine, shared } = useMemo(() => splitFolders(folders), [folders]);
  const scoped = scope === 'mine' ? mine : shared;
  const trimmedQuery = query.trim().toLowerCase();
  const visible = scoped.filter((candidate) =>
    trimmedQuery === '' || candidate.name.toLowerCase().includes(trimmedQuery));
  const controllable = workspaces.filter(({ role }) => role === 'owner' || role === 'admin');
  const workspaceName = useCallback(
    (id: string) => workspaces.find((workspace) => workspace.id === id)?.name ?? id,
    [workspaces],
  );

  const goDrive = useCallback(
    (nextScope: DriveScope) => onNavigate(drivePath(nextScope)),
    [onNavigate],
  );
  const openFolder = (target: FolderView) => onNavigate(folderPagePath(target.id));
  const openPath = (target: string, nextPath: string[]) => {
    setSelectedKey(null);
    onNavigate(folderPagePath(target, nextPath));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menu !== null) { setMenu(null); return; }
      if (dialog !== null) { setDialog(null); return; }
      if (selectedKey !== null) { setSelectedKey(null); return; }
      if (route.page === 'folder' && route.folderPath.length > 0) {
        onNavigate(folderPagePath(route.folderId, route.folderPath.slice(0, -1)));
        return;
      }
      if (route.page === 'folder') goDrive(scope);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, goDrive, menu, onNavigate, route, scope, selectedKey]);

  const openMenuFrom = (event: React.MouseEvent<HTMLElement>, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right - 216, y: rect.bottom + 6, items });
  };

  const openMenuAtPointer = (event: React.MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY + 4, items });
  };

  const uploadFiles = async (target: FolderView, files: File[]) => {
    for (const file of files) {
      const key = path.length === 0 ? file.name : `${path.join('/')}/${file.name}`;
      setUpload({ name: file.name, sent: 0, total: file.size, done: false, folderName: target.name });
      try {
        await client.uploadFolderObject(target.id, key, file, (sent, total) => {
          setUpload({ name: file.name, sent, total, done: false, folderName: target.name });
        });
        setUpload({ name: file.name, sent: file.size, total: file.size, done: true, folderName: target.name });
        showSnack(<span><b>{file.name}</b> uploaded to {target.name}</span>);
      } catch (caught) {
        setUpload(null);
        setError(caught instanceof Error ? caught.message : 'Upload failed.');
        return;
      }
    }
    window.setTimeout(() => {
      setUpload((current) => (current?.done ? null : current));
    }, 3_200);
    await loadObjects(target.id);
    await loadFolders();
  };

  const folderMenuItems = (target: FolderView): MenuItem[] => {
    const items: MenuItem[] = [{
      label: 'Attach to workspace',
      icon: <LinkGlyph />,
      run: () => setDialog({ kind: 'attach', folderId: target.id }),
    }];
    if (canManageFolder(target.role)) {
      items.push({
        label: 'Rename',
        icon: <PencilGlyph />,
        run: () => {
          setNameField(target.name);
          setDialog({ kind: 'rename', folderId: target.id });
        },
      });
      items.push({
        label: 'Delete',
        icon: <TrashGlyph />,
        danger: true,
        run: () => setDialog({ kind: 'delete-folder', folderId: target.id }),
      });
    }
    return items;
  };

  const tileContextItems = (target: FolderView): MenuItem[] => [
    {
      label: 'Share…',
      icon: <ShareGlyph />,
      run: () => setDialog({ kind: 'share', folderId: target.id }),
    },
    ...folderMenuItems(target),
  ];

  const download = (name: string, key: string) => {
    if (folder === null) return;
    void client.downloadFolderObject(folder.id, key).then((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    }).catch((caught: Error) => setError(caught.message));
  };

  const fileMenuItems = (name: string, key: string): MenuItem[] => [
    { label: 'Download', icon: <DownloadGlyph />, run: () => download(name, key) },
    ...(folder !== null && canWriteFolder(folder.role) ? [{
      label: 'Delete',
      icon: <TrashGlyph />,
      danger: true,
      run: () => setDialog({ kind: 'delete-object', key, name }),
    }] : []),
  ];

  const scopeTitle = scope === 'mine' ? 'My Drive' : 'Shared with me';
  const entries = folder === null ? null : entriesAt(
    trimmedQuery === ''
      ? objects
      : objects.filter((object) => object.key.toLowerCase().includes(trimmedQuery)),
    path,
  );

  const renderTile = (target: FolderView) => (
    <div
      className="drive-tile"
      key={target.id}
      onContextMenu={(event) => openMenuAtPointer(event, tileContextItems(target))}
    >
      <button
        className="drive-tile-open"
        type="button"
        aria-label={`Open ${target.name}`}
        onClick={() => openFolder(target)}
      />
      <FolderGlyph />
      <span className="drive-tile-name">
        <span>{target.name}</span>
        {target.attachedWorkspaceIds.length > 0 && (
          <span
            className="drive-attached-glyph"
            title={`/workspace/shared/${target.name} on ${target.attachedWorkspaceIds.map(workspaceName).join(', ')}`}
          >
            <LinkGlyph />
          </span>
        )}
      </span>
      <span className="drive-tile-trail">
        <DriveAvatar
          name={target.owner.name}
          avatarUrl={target.owner.avatarUrl}
          me={target.role === 'owner'}
        />
      </span>
      <span className="drive-row-actions">
        <button
          type="button"
          title="Share"
          aria-label={`Share ${target.name}`}
          onClick={() => setDialog({ kind: 'share', folderId: target.id })}
        >
          <ShareGlyph />
        </button>
        <button
          type="button"
          title="More actions"
          aria-label={`More actions for ${target.name}`}
          onClick={(event) => openMenuFrom(event, folderMenuItems(target))}
        >
          <KebabGlyph />
        </button>
      </span>
    </div>
  );

  return (
    <div className="drive-page drive">
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      {folder === null ? (
        <div>
          <h1 className="drive-title">{scopeTitle}</h1>
          {visible.length === 0 ? (
            <div className="drive-empty">
              {trimmedQuery !== ''
                ? `No folders in ${scopeTitle} match “${query.trim()}”`
                : scope === 'shared'
                  ? 'Nothing is shared with you yet'
                  : 'Nothing here yet — make a folder with New'}
            </div>
          ) : (
            <section className="drive-section">
              <h2 className="drive-section-title">Folders</h2>
              <div className="drive-tiles">{visible.map(renderTile)}</div>
            </section>
          )}
        </div>
      ) : (
        <div>
          <nav className="drive-crumbs" aria-label="Breadcrumb">
            <button type="button" onClick={() => goDrive(scope)}>{scopeTitle}</button>
            <i>›</i>
            {path.length === 0
              ? <b>{folder.name}</b>
              : <button type="button" onClick={() => openPath(folder.id, [])}>{folder.name}</button>}
            {path.map((segment, index) => (
              <span key={`${segment}-${String(index)}`} style={{ display: 'contents' }}>
                <i>›</i>
                {index === path.length - 1
                  ? <b>{segment}</b>
                  : (
                    <button type="button" onClick={() => openPath(folder.id, path.slice(0, index + 1))}>
                      {segment}
                    </button>
                  )}
              </span>
            ))}
            {folder.attachedWorkspaceIds.length > 0 && (
              <span
                className="drive-crumb-attached"
                title={`Attached to ${folder.attachedWorkspaceIds.map(workspaceName).join(', ')} at /workspace/shared/${folder.name}`}
              >
                <LinkGlyph />
              </span>
            )}
          </nav>

          {entries !== null && entries.dirs.length > 0 && (
            <section className="drive-section">
              <h2 className="drive-section-title">Folders</h2>
              <div className="drive-tiles">
                {entries.dirs.map((dir) => (
                  <div className="drive-tile" key={dir.name}>
                    <button
                      className="drive-tile-open"
                      type="button"
                      aria-label={`Open ${dir.name}`}
                      onClick={() => openPath(folder.id, [...path, dir.name])}
                    />
                    <FolderGlyph />
                    <span className="drive-tile-name"><span>{dir.name}</span></span>
                    <span className="drive-tile-trail">
                      <span className="drive-row-trail">{dir.fileCount} {dir.fileCount === 1 ? 'file' : 'files'}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="drive-section">
            {entries !== null && entries.dirs.length > 0 && <h2 className="drive-section-title">Files</h2>}
            <div className="drive-list-head"><span>Name</span><span>Owner</span><span>Last modified</span><span /></div>
            {entries === null || entries.files.length === 0 ? (
              <div className="drive-empty">{trimmedQuery !== '' ? 'No files match' : 'No files here yet'}</div>
            ) : entries.files.map((entry) => (
              <div
                className={`drive-file-row${selectedKey === entry.key ? ' drive-file-row--selected' : ''}`}
                key={entry.key}
                onContextMenu={(event) => openMenuAtPointer(event, fileMenuItems(entry.name, entry.key))}
              >
                <button
                  className="drive-row-open"
                  type="button"
                  aria-label={entry.name}
                  onClick={() => setSelectedKey(selectedKey === entry.key ? null : entry.key)}
                />
                <span className="drive-row-name"><FileGlyph /><span>{entry.name}</span></span>
                <span className="drive-owner-cell">
                  <DriveAvatar name={folder.owner.name} avatarUrl={folder.owner.avatarUrl} me={folder.role === 'owner'} />
                  <span>{folder.role === 'owner' ? 'me' : folder.owner.name}</span>
                </span>
                <span className="drive-row-trail">{formatWhen(entry.mtime)} · {entry.editedBy} · {formatBytes(entry.size)}</span>
                <span className="drive-row-actions">
                  <button
                    type="button"
                    title="Download"
                    aria-label={`Download ${entry.name}`}
                    onClick={() => download(entry.name, entry.key)}
                  >
                    <DownloadGlyph />
                  </button>
                  <button
                    type="button"
                    title="More actions"
                    aria-label={`More actions for ${entry.name}`}
                    onClick={(event) => openMenuFrom(event, fileMenuItems(entry.name, entry.key))}
                  >
                    <KebabGlyph />
                  </button>
                </span>
              </div>
            ))}
          </section>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files && files.length > 0 && folder !== null) void uploadFiles(folder, Array.from(files));
          event.currentTarget.value = '';
        }}
      />

      {menu !== null && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            style={{ position: 'fixed', inset: 0, zIndex: 190, border: 0, background: 'transparent', cursor: 'default' }}
            onClick={() => setMenu(null)}
          />
          <div
            className="drive-menu"
            role="menu"
            style={{
              left: Math.max(8, Math.min(menu.x, window.innerWidth - 224)),
              top: Math.min(menu.y, window.innerHeight - 8 - menu.items.length * 40),
            }}
          >
            {menu.items.map((item) => (
              <button
                className={`drive-menu-item${item.danger ? ' drive-menu-item--danger' : ''}`}
                type="button"
                role="menuitem"
                key={item.label}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setMenu(null);
                  item.run();
                }}
              >
                {item.icon}<span>{item.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {dialog?.kind === 'share' && (() => {
        const target = folders.find(({ id }) => id === dialog.folderId);
        return target === undefined ? null : (
          <ShareFolderDialog
            client={client}
            folder={target}
            viewerEmail={viewer.identity.email}
            onClose={() => setDialog(null)}
            onChanged={loadFolders}
            onSnack={showSnack}
          />
        );
      })()}

      {dialog?.kind === 'attach' && (() => {
        const target = folders.find(({ id }) => id === dialog.folderId);
        return target === undefined ? null : (
          <AttachFolderDialog
            client={client}
            folder={target}
            workspaces={controllable}
            onClose={() => setDialog(null)}
            onChanged={loadFolders}
            onSnack={showSnack}
          />
        );
      })()}

      {(dialog?.kind === 'new-folder' || dialog?.kind === 'rename') && (
        <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setDialog(null); }}>
          <section className="drive-dialog" role="dialog" aria-modal="true">
            <h2>{dialog.kind === 'new-folder' ? 'New folder' : 'Rename'}</h2>
            <form onSubmit={(event) => {
              event.preventDefault();
              const name = normalizeFolderName(nameField);
              if (name === '') return;
              const action = dialog.kind === 'new-folder'
                ? client.createFolder(name).then(({ folder: created }) => {
                  showSnack(<span><b>{created.name}</b> created</span>);
                })
                : client.renameFolder(dialog.folderId, name).then(() => {
                  showSnack(<span>Renamed to <b>{name}</b></span>);
                });
              void action.then(() => loadFolders())
                .then(() => setDialog(null))
                .catch((caught: Error) => setError(caught.message));
            }}>
              <div className="drive-dialog-body">
                <input
                  className="drive-field"
                  type="text"
                  aria-label="Folder name"
                  placeholder="Folder name"
                  value={nameField}
                  maxLength={128}
                  onChange={(event) => setNameField(event.currentTarget.value)}
                />
                <p className="drive-dialog-note">
                  {dialog.kind === 'new-folder'
                    ? 'You own it. Share it to add editors and viewers.'
                    : 'Attached workspaces sync under the new name from the next tick; the old directory stays in the guest until removed there.'}
                </p>
              </div>
              <div className="drive-dialog-foot">
                <button className="drive-button" type="button" onClick={() => setDialog(null)}>Cancel</button>
                <button className="drive-button drive-button--primary" type="submit" disabled={normalizeFolderName(nameField) === ''}>
                  {dialog.kind === 'new-folder' ? 'Create' : 'Rename'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {(dialog?.kind === 'delete-folder' || dialog?.kind === 'delete-object') && (() => {
        const target = dialog.kind === 'delete-folder'
          ? folders.find(({ id }) => id === dialog.folderId)
          : folder;
        if (target === undefined || target === null) return null;
        const objectDelete = dialog.kind === 'delete-object';
        return (
          <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setDialog(null); }}>
            <section className="drive-dialog" role="dialog" aria-modal="true">
              <h2>Delete <em>“{objectDelete ? dialog.name : target.name}”</em></h2>
              <div className="drive-dialog-body">
                <p className="drive-dialog-note">
                  {objectDelete
                    ? target.attachedWorkspaceIds.length > 0
                      ? 'Deletes from the library now. Copies in attached workspaces return it on the next sync unless deleted there too.'
                      : 'Deletes the file from the library. There is no undo.'
                    : 'Deletes the folder, its grants, and every file in it. There is no undo.'}
                </p>
              </div>
              <div className="drive-dialog-foot">
                <button className="drive-button" type="button" onClick={() => setDialog(null)}>Cancel</button>
                <button
                  className="drive-button drive-button--primary"
                  type="button"
                  onClick={() => {
                    const action = objectDelete
                      ? client.deleteFolderObject(target.id, dialog.key).then(() => loadObjects(target.id))
                      : client.deleteFolder(target.id).then(() => goDrive(scope));
                    void action
                      .then(() => loadFolders())
                      .then(() => {
                        setDialog(null);
                        showSnack(<span><b>{objectDelete ? dialog.name : target.name}</b> deleted</span>);
                      })
                      .catch((caught: Error) => setError(caught.message));
                  }}
                >
                  Delete
                </button>
              </div>
            </section>
          </div>
        );
      })()}

      {upload !== null && (
        <section className="drive-uploader" aria-label="Upload status">
          <header className="drive-uploader-head">
            <span>{upload.done ? 'Upload complete' : 'Uploading 1 item'}</span>
            <button type="button" aria-label="Close upload status" onClick={() => setUpload(null)}><CloseGlyph /></button>
          </header>
          <div className="drive-uploader-item">
            <FileGlyph />
            <span className="drive-uploader-copy">
              <strong>{upload.name}</strong>
              {upload.done
                ? <span className="drive-uploader-state">{formatBytes(upload.total)} · in {upload.folderName}</span>
                : (
                  <span className="drive-progress">
                    <span
                      className="drive-progress-fill"
                      style={{ width: `${upload.total === 0 ? 100 : Math.round((upload.sent / upload.total) * 100)}%` }}
                    />
                  </span>
                )}
            </span>
            {upload.done
              ? <span className="drive-uploader-check"><CheckGlyph /></span>
              : (
                <span className="drive-uploader-state">
                  {upload.total === 0 ? 100 : Math.round((upload.sent / upload.total) * 100)}%
                </span>
              )}
          </div>
        </section>
      )}

      {snack !== null && (
        <div className="drive-snackbar" role="status">
          <span>{snack}</span>
          <button type="button" onClick={() => setSnack(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
