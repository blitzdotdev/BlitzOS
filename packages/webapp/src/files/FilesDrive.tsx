import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import type { WorkspaceView } from '@blitzos/schema';
import type { FolderObjectView, FolderView } from '../file-library-api';
import { drivePath, folderPagePath, type DriveScope } from '../sessions-page-state';
import { AttachFolderDialog } from './AttachFolderDialog';
import { DriveAvatar } from './DriveAvatar';
import {
  DownloadGlyph,
  KebabGlyph,
  LinkGlyph,
  PencilGlyph,
  ShareGlyph,
  TrashGlyph,
  UploadGlyph,
} from './DriveIcons';
import { DriveRootView } from './DriveRootView';
import { useDriveUploads, type UploadEntry } from './use-drive-uploads';
import { FolderDuoIcon } from '../files-icons';
import {
  canManageFolder,
  canWriteFolder,
  entriesAt,
  formatBytes,
  formatWhen,
  normalizeFolderName,
  splitFolders,
} from './drive-model';
import {
  collectDropped,
  DropLimitError,
  payloadFromPickedFiles,
  type DroppedPayload,
} from './drop-upload';
import {
  DriveCrumbs,
  DriveDeleteDialog,
  DriveFileRow,
  DriveMenu,
  DriveSnackbar,
  DriveUploaderCard,
  FolderNameDialog,
  type MenuItem,
} from './drive-chrome';
import { ShareFolderDialog } from './ShareFolderDialog';

export type DrivePageRoute =
  | { page: 'drive'; scope: DriveScope }
  | { page: 'folder'; folderId: string; folderPath: string[] };

type DriveDialog =
  | { kind: 'share'; folderId: string }
  | { kind: 'attach'; folderId: string }
  | { kind: 'new-folder' }
  | { kind: 'rename'; folderId: string }
  | { kind: 'delete-folder'; folderId: string }
  | { kind: 'delete-object'; key: string; name: string };

const SNACK_MS = 7_000;

export function FilesDrive({
  client,
  viewer,
  route,
  query,
  onNavigate,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
  route: DrivePageRoute;
  query: string;
  onNavigate: (path: string) => void;
}) {
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [objects, setObjects] = useState<FolderObjectView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DriveDialog | null>(null);
  const [nameField, setNameField] = useState('');
  const [snack, setSnack] = useState<React.ReactNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const snackTimer = useRef<number | null>(null);
  const dragDepth = useRef(0);

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

  const { upload, uploadEntries, cancelUpload } = useDriveUploads({
    client,
    currentFolderId: folderId,
    loadObjects,
    loadFolders,
    showSnack,
    onError: setError,
  });

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

  const { mine, shared } = useMemo(() => splitFolders(folders), [folders]);
  const scoped = scope === 'mine' ? mine : shared;
  const trimmedQuery = query.trim().toLowerCase();
  const visible = scoped.filter((candidate) =>
    trimmedQuery === '' || candidate.name.toLowerCase().includes(trimmedQuery));
  // The Drive root is the single destination: shared folders list below the
  // owned ones instead of behind a separate rail row.
  const sharedVisible = shared.filter((candidate) =>
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

  const keyedAtPath = (name: string) =>
    path.length === 0 ? name : `${path.join('/')}/${name}`;

  const handleDropPayload = async (payload: DroppedPayload) => {
    if (folder !== null) {
      if (!canWriteFolder(folder.role)) {
        showSnack(<span>You have view-only access to <b>{folder.name}</b> — ask for editor access to upload</span>);
        return;
      }
      const entries: UploadEntry[] = [
        ...payload.files.map(({ file, relativePath }) => ({ file, key: keyedAtPath(relativePath) })),
        ...payload.folders.flatMap(({ name, files }) =>
          files.map(({ file, relativePath }) => ({ file, key: keyedAtPath(`${name}/${relativePath}`) }))),
      ];
      if (entries.length === 0) {
        showSnack('Nothing to upload — the drop had no files in it');
        return;
      }
      await uploadEntries(folder, entries);
      return;
    }
    if (scope === 'shared') {
      showSnack('Shared with me is read-only — drop into Drive, or open a folder you can edit');
      return;
    }
    if (payload.folders.length === 0) {
      showSnack('Drop a folder to add it to Drive — open a folder to drop single files');
      return;
    }
    for (const dropped of payload.folders) {
      const name = normalizeFolderName(dropped.name);
      if (name === '') {
        showSnack(<span><b>{dropped.name}</b> does not normalize to a usable folder name</span>);
        continue;
      }
      let created: FolderView;
      try {
        created = (await client.createFolder(name)).folder;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not create the folder.');
        return;
      }
      if (dropped.files.length === 0) {
        showSnack(<span><b>{created.name}</b> created — the dropped folder was empty</span>);
        continue;
      }
      const uploaded = await uploadEntries(
        created,
        dropped.files.map(({ file, relativePath }) => ({ file, key: relativePath })),
      );
      if (!uploaded) return;
    }
    await loadFolders();
    if (payload.files.length > 0) {
      showSnack('Loose files skipped — open a folder to upload single files');
    }
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

  const scopeTitle = scope === 'mine' ? 'Drive' : 'Shared with me';
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
      <FolderDuoIcon className="drive-folder-icon" />
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

  const dragHasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

  return (
    <div
      className={`drive-page drive${dropActive ? ' drive-page--dropping' : ''}`}
      onDragEnter={(event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        if (dragDepth.current === 0) return;
        dragDepth.current -= 1;
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={(event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropActive(false);
        // collectDropped must be invoked inside the handler: DataTransferItems
        // go inert once the drop event yields to the event loop.
        void collectDropped(Array.from(event.dataTransfer.items), Array.from(event.dataTransfer.files))
          .then(handleDropPayload)
          .catch((caught: Error) => {
            if (caught instanceof DropLimitError) showSnack(caught.message);
            else setError(caught.message);
          });
      }}
    >
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      {folder === null ? (
        <DriveRootView
          scope={scope}
          scopeTitle={scopeTitle}
          query={query}
          visible={visible}
          sharedVisible={sharedVisible}
          renderTile={renderTile}
          onNewFolder={() => {
            setNameField('');
            setDialog({ kind: 'new-folder' });
          }}
          onUploadFolder={() => dirInput.current?.click()}
        />
      ) : (
        <div>
          <div className="drive-head-row">
            <DriveCrumbs
              rootLabel={scopeTitle}
              folderName={folder.name}
              path={path}
              attachedNote={folder.attachedWorkspaceIds.length > 0
                ? `Attached to ${folder.attachedWorkspaceIds.map(workspaceName).join(', ')} at /workspace/shared/${folder.name}`
                : null}
              onRoot={() => goDrive(scope)}
              onFolderRoot={() => openPath(folder.id, [])}
              onPath={(next) => openPath(folder.id, next)}
            />
            {canWriteFolder(folder.role) && (
              <button
                className="drive-new-button"
                type="button"
                onClick={() => fileInput.current?.click()}
              >
                <UploadGlyph /><span>Upload</span>
              </button>
            )}
          </div>

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
                    <FolderDuoIcon className="drive-folder-icon" />
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
            <div className="drive-list-head"><span>Name</span><span>Owner</span><span>Last modified</span><span>Size</span><span /></div>
            {entries === null || entries.files.length === 0 ? (
              <div className="drive-empty">{trimmedQuery !== '' ? 'No files match' : 'No files here yet'}</div>
            ) : entries.files.map((entry) => (
              <DriveFileRow
                key={entry.key}
                entry={entry}
                ownerName={folder.owner.name}
                ownerAvatarUrl={folder.owner.avatarUrl}
                mine={folder.role === 'owner'}
                selected={selectedKey === entry.key}
                onToggleSelect={() => setSelectedKey(selectedKey === entry.key ? null : entry.key)}
                onDownload={() => download(entry.name, entry.key)}
                onMenu={(event) => openMenuFrom(event, fileMenuItems(entry.name, entry.key))}
                onContextMenu={(event) => openMenuAtPointer(event, fileMenuItems(entry.name, entry.key))}
              />
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
          if (files && files.length > 0 && folder !== null) {
            void uploadEntries(
              folder,
              Array.from(files).map((file) => ({ file, key: keyedAtPath(file.name) })),
            );
          }
          event.currentTarget.value = '';
        }}
      />
      <input
        // The directory-picker flag is not in React's typed DOM props, so the
        // ref callback stamps the attribute; webkitdirectory works cross-browser.
        ref={(node) => {
          dirInput.current = node;
          node?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        hidden
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files && files.length > 0) {
            try {
              void handleDropPayload(payloadFromPickedFiles(Array.from(files)));
            } catch (caught) {
              if (caught instanceof DropLimitError) showSnack(caught.message);
              else setError(caught instanceof Error ? caught.message : 'Folder upload failed.');
            }
          }
          event.currentTarget.value = '';
        }}
      />

      {menu !== null && <DriveMenu menu={menu} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'share' && (() => {
        const target = folders.find(({ id }) => id === dialog.folderId);
        return target === undefined ? null : (
          <ShareFolderDialog
            client={client}
            folder={target}
            viewerEmail={viewer.identity.email}
            orgName={viewer.org.name}
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
        <FolderNameDialog
          title={dialog.kind === 'new-folder' ? 'New folder' : 'Rename'}
          submitLabel={dialog.kind === 'new-folder' ? 'Create' : 'Rename'}
          note={dialog.kind === 'new-folder'
            ? 'You own it. Share it to add editors and viewers.'
            : 'Attached workspaces sync under the new name from the next tick; the old directory stays in the guest until removed there.'}
          value={nameField}
          submitDisabled={normalizeFolderName(nameField) === ''}
          onChange={setNameField}
          onCancel={() => setDialog(null)}
          onSubmit={() => {
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
          }}
        />
      )}

      {(dialog?.kind === 'delete-folder' || dialog?.kind === 'delete-object') && (() => {
        const target = dialog.kind === 'delete-folder'
          ? folders.find(({ id }) => id === dialog.folderId)
          : folder;
        if (target === undefined || target === null) return null;
        const objectDelete = dialog.kind === 'delete-object';
        return (
          <DriveDeleteDialog
            name={objectDelete ? dialog.name : target.name}
            note={objectDelete
              ? target.attachedWorkspaceIds.length > 0
                ? 'Deletes from the library now. Copies in attached workspaces return it on the next sync unless deleted there too.'
                : 'Deletes the file from the library. There is no undo.'
              : 'Deletes the folder, its grants, and every file in it. There is no undo.'}
            onCancel={() => setDialog(null)}
            onConfirm={() => {
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
          />
        );
      })()}

      {upload !== null && (
        <DriveUploaderCard
          upload={upload}
          onClose={cancelUpload}
        />
      )}

      {dropActive && (
        <div className="drive-droptarget" aria-hidden="true">
          <span>
            {folder !== null
              ? canWriteFolder(folder.role)
                ? <>Drop to upload to <b>{[folder.name, ...path].join('/')}</b></>
                : 'View-only — you need editor access to upload here'
              : scope === 'mine'
                ? 'Drop folders to add them to Drive'
                : 'Shared with me is read-only'}
          </span>
        </div>
      )}

      {snack !== null && <DriveSnackbar message={snack} onDismiss={() => setSnack(null)} />}
    </div>
  );
}
