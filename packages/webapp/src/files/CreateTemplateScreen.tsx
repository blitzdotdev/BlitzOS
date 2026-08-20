import type {
  CreateWorkspaceTemplateRequest,
  MachineType,
  WorkspaceEnvironment,
  WorkspaceTemplateView,
} from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { FolderObjectView, FolderView } from '../file-library-api';
import { AgentRulesPicker } from '../AgentRulesPicker';
import { OutlinedLoadingRows } from '../LoadingSkeleton';
import { MachineCatalogGrid } from '../MachineCatalogGrid';
import {
  EMPTY_WORKSPACE_ENVIRONMENT,
  EnvironmentEditor,
  populatedEnvironment,
} from '../EnvironmentEditor';
import { DriveAvatar } from './DriveAvatar';
import { CloseGlyph } from './DriveIcons';
import { DocDuoIcon, FolderDuoIcon } from '../files-icons';
import {
  canManageFolder,
  entriesAt,
  formatBytes,
  formatWhen,
  normalizeFolderName,
} from './drive-model';
import { collectDropped, DropLimitError } from './drop-upload';

function BackGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  );
}

interface BrowseState {
  folderId: string;
  path: string[];
}

/** Dedicated screen for building a workspace template: name it, pick a
 * machine, and attach the Drive folders every workspace created from it
 * starts with. The folder browser merges My Drive and Shared with me:
 * single click selects, double click enters, Back walks up, and the drop
 * strip uploads a local directory as a new attached folder. */
export function CreateTemplateScreen({
  client,
  orgName,
  editTemplateId,
  onCreated,
  onCancel,
}: {
  client: ControlPlaneClient;
  orgName: string;
  /** When set, the screen edits this template instead of creating one. */
  editTemplateId?: string;
  onCreated: (template: WorkspaceTemplateView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [machineTypeId, setMachineTypeId] = useState('');
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [attachedIds, setAttachedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [objectsByFolder, setObjectsByFolder] = useState<Map<string, FolderObjectView[]>>(new Map());
  const [shareWithOrg, setShareWithOrg] = useState(true);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [environment, setEnvironment] = useState(EMPTY_WORKSPACE_ENVIRONMENT);
  // Editing loads the stored environment first, then re-keys the editor onto
  // it. Null means an edit whose template has not arrived yet.
  const [loadedEnvironment, setLoadedEnvironment] = useState<WorkspaceEnvironment | null>(
    editTemplateId === undefined ? EMPTY_WORKSPACE_ENVIRONMENT : null,
  );
  const [agentRuleId, setAgentRuleId] = useState<string | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    let mounted = true;
    void Promise.allSettled([
      client.listMachineTypes(),
      client.listFolders(),
    ]).then(([machineResult, folderResult]) => {
      if (!mounted) return;
      if (machineResult.status === 'fulfilled') {
        setMachines(machineResult.value.machineTypes);
        setMachineTypeId((current) => current || machineResult.value.machineTypes[0]?.id || '');
      } else {
        setError(machineResult.reason instanceof Error
          ? machineResult.reason.message
          : 'Machine types could not be loaded.');
      }
      if (folderResult.status === 'fulfilled') setFolders(folderResult.value.folders);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [client]);

  const accessible = folders.filter(({ role }) => role !== null);
  const rows = [...accessible].sort((left, right) => {
    const leftMine = left.role === 'owner' ? 0 : 1;
    const rightMine = right.role === 'owner' ? 0 : 1;
    if (leftMine !== rightMine) return leftMine - rightMine;
    return left.name.toLowerCase() < right.name.toLowerCase() ? -1 : 1;
  });
  const attached = rows.filter(({ id }) => attachedIds.has(id));
  const browsedFolder = browse === null
    ? null
    : accessible.find(({ id }) => id === browse.folderId) ?? null;
  const target = browsedFolder ?? accessible.find(({ id }) => id === selectedId) ?? null;
  const targetAttached = target !== null && attachedIds.has(target.id);

  const loadObjects = (folderId: string) => {
    if (objectsByFolder.has(folderId)) return;
    void client.listFolderObjects(folderId)
      .then(({ objects }) => {
        setObjectsByFolder((current) => new Map(current).set(folderId, objects));
      })
      .catch((caught: Error) => setError(caught.message));
  };

  const enterFolder = (folderId: string) => {
    setSelectedId(folderId);
    setBrowse({ folderId, path: [] });
    loadObjects(folderId);
  };

  const goBack = () => {
    setBrowse((current) => {
      if (current === null) return null;
      if (current.path.length === 0) return null;
      return { folderId: current.folderId, path: current.path.slice(0, -1) };
    });
  };

  const toggleAttach = () => {
    if (target === null) return;
    const id = target.id;
    setAttachedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const detach = (folderId: string) => {
    setAttachedIds((current) => {
      const next = new Set(current);
      next.delete(folderId);
      return next;
    });
  };

  const uploadDroppedFolders = async (
    dropped: { name: string; files: { file: File; relativePath: string }[] }[],
    looseFiles: number,
  ) => {
    if (dropped.length === 0) {
      setDropHint(looseFiles > 0 ? 'Drop folders, not loose files' : 'Nothing to upload in that drop');
      return;
    }
    setDropHint(null);
    for (const entry of dropped) {
      const folderName = normalizeFolderName(entry.name);
      if (folderName === '') continue;
      setUploading(folderName);
      try {
        const { folder } = await client.createFolder(folderName);
        for (const { file, relativePath } of entry.files) {
          await client.uploadFolderObject(folder.id, relativePath, file);
        }
        setAttachedIds((current) => new Set([...current, folder.id]));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Upload failed.');
        setUploading(null);
        return;
      }
    }
    setUploading(null);
    await client.listFolders()
      .then(({ folders: loaded }) => setFolders(loaded))
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(() => {
    if (editTemplateId === undefined) return;
    let mounted = true;
    void client.listWorkspaceTemplates().then(({ templates }) => {
      if (!mounted) return;
      const existing = templates.find(({ id }) => id === editTemplateId);
      if (existing === undefined) {
        setError('That template no longer exists.');
        return;
      }
      setName(existing.name);
      setMachineTypeId(existing.machineTypeId);
      // Keep every attached folder id, including ones this editor cannot
      // read — the server preserves them and only checks new additions.
      setAttachedIds(new Set(existing.folders.map(({ id }) => id)));
      const stored = existing.environment ?? EMPTY_WORKSPACE_ENVIRONMENT;
      setLoadedEnvironment(stored);
      // Seed the submitted value too: saving without opening Advanced has to
      // resubmit what is stored, not wipe it.
      setEnvironment(stored);
    }).catch((caught: Error) => setError(caught.message));
    return () => { mounted = false; };
  }, [client, editTemplateId]);

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '' || machineTypeId === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (shareWithOrg) {
        // Attached folders you control get org-wide viewer access so the
        // template works for members without individual grants; folders
        // someone else shared with you stay as they are.
        for (const folder of accessible) {
          if (!attachedIds.has(folder.id)) continue;
          if (!canManageFolder(folder.role) || folder.orgRole !== null) continue;
          await client.setFolderOrgRole(folder.id, 'viewer');
        }
      }
      const request: CreateWorkspaceTemplateRequest = {
        name: trimmed,
        machineTypeId,
        folderIds: [...attachedIds],
      };
      // The environment rides on both create and edit — the PUT handler
      // replaces it, so an edit that cleared it has to send the empty one
      // rather than omit the field. The agent rule rides only on create: the
      // PUT handler leaves the stored value untouched.
      const configured = populatedEnvironment(environment);
      if (configured !== undefined) request.environment = configured;
      else if (editTemplateId !== undefined) request.environment = EMPTY_WORKSPACE_ENVIRONMENT;
      if (editTemplateId === undefined && agentRuleId !== null) request.agentRuleId = agentRuleId;
      const { template } = editTemplateId === undefined
        ? await client.createWorkspaceTemplate(request)
        : await client.updateWorkspaceTemplate(editTemplateId, request);
      onCreated(template);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The template could not be saved.');
      setBusy(false);
    }
  };

  const dragHasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

  const entries = browse === null
    ? null
    : entriesAt(objectsByFolder.get(browse.folderId) ?? [], browse.path);

  const renderRootRows = () => (
    <>
      {rows.length === 0 && !loading && (
        <div className="tplf-empty">No Drive folders yet — drop one below, or make one in My Drive.</div>
      )}
      {rows.map((folder) => (
        <button
          className={`tplf-row${selectedId === folder.id ? ' tplf-row--selected' : ''}`}
          type="button"
          key={folder.id}
          onClick={() => setSelectedId(folder.id)}
          onDoubleClick={() => enterFolder(folder.id)}
        >
          <FolderDuoIcon className="drive-folder-icon" />
          <span className="tplf-row-name">{folder.name}</span>
          <span className="tplf-row-owner">
            <DriveAvatar name={folder.owner.name} avatarUrl={folder.owner.avatarUrl} me={folder.role === 'owner'} />
            <span>{folder.role === 'owner' ? 'me' : folder.owner.name}</span>
          </span>
          <span className="tplf-row-state">
            {folder.orgRole !== null && <em className="tplf-chip">{orgName}</em>}
            {attachedIds.has(folder.id) && <em className="tplf-chip tplf-chip--attached">In template</em>}
          </span>
        </button>
      ))}
    </>
  );

  const renderBrowseRows = () => {
    if (entries === null) return null;
    if (!objectsByFolder.has(browse?.folderId ?? '')) {
      return <div className="tplf-empty">Loading files…</div>;
    }
    if (entries.dirs.length === 0 && entries.files.length === 0) {
      return <div className="tplf-empty">This folder is empty</div>;
    }
    return (
      <>
        {entries.dirs.map((dir) => (
          <button
            className="tplf-row"
            type="button"
            key={`dir-${dir.name}`}
            onDoubleClick={() => {
              setBrowse((current) => current === null
                ? current
                : { folderId: current.folderId, path: [...current.path, dir.name] });
            }}
          >
            <FolderDuoIcon className="drive-folder-icon" />
            <span className="tplf-row-name">{dir.name}</span>
            <span className="tplf-row-owner" />
            <span className="tplf-row-state">{dir.fileCount} {dir.fileCount === 1 ? 'file' : 'files'}</span>
          </button>
        ))}
        {entries.files.map((file) => (
          <div className="tplf-row tplf-row--file" key={file.key}>
            <DocDuoIcon name={file.name} className="drive-folder-icon" />
            <span className="tplf-row-name">{file.name}</span>
            <span className="tplf-row-owner" />
            <span className="tplf-row-state">{formatWhen(file.mtime)} · {formatBytes(file.size)}</span>
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="create-workspace-screen" role="presentation">
      <form
        className="create-workspace-dialog"
        aria-label="Create workspace template"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <header className="create-workspace-header">
          <div className="create-workspace-header__title"><h1>{editTemplateId === undefined ? 'New workspace template' : 'Edit workspace template'}</h1></div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>

        <div className="create-workspace-main">
          {error && (
            <div className="create-workspace-notices">
              <p className="webapp-form-message" role="alert">{error}</p>
            </div>
          )}

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Name</h2>
              <p>Everyone at {orgName} sees this template on the create-workspace page.</p>
            </div>
            <label className="blueprint-field">
              Template name
              <input
                aria-label="Template name"
                maxLength={64}
                placeholder="e.g. data analysis starter"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Machine type</h2>
              <p>Workspaces created from this template run on this machine.</p>
            </div>
            {loading ? (
              <OutlinedLoadingRows count={4} ariaLabel="Loading machine types" />
            ) : machines.length > 0 ? (
              <MachineCatalogGrid
                machines={machines}
                selectedMachineType={machineTypeId}
                onSelect={setMachineTypeId}
              />
            ) : (
              <div className="blueprint-selection__empty">No machine types are available.</div>
            )}
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Attach folders</h2>
              <p>
                Attached folders sync into every workspace created from this template.
                Click to select, double-click to look inside — or drop a folder from
                your computer anywhere in the list to upload and attach it.
              </p>
            </div>
            <div className="tplf">
              <div
                className="tplf-main"
                onDragEnter={(event) => {
                  if (!dragHasFiles(event)) return;
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDropActive(true);
                  setDropHint(null);
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
                  void collectDropped(
                    Array.from(event.dataTransfer.items),
                    Array.from(event.dataTransfer.files),
                  )
                    .then((payload) => uploadDroppedFolders(payload.folders, payload.files.length))
                    .catch((caught: Error) => {
                      if (caught instanceof DropLimitError) setDropHint(caught.message);
                      else setError(caught.message);
                    });
                }}
              >
                <div className="tplf-head">
                  <button
                    className="tplf-back"
                    type="button"
                    aria-label="Back"
                    disabled={browse === null}
                    onClick={goBack}
                  >
                    <BackGlyph />
                  </button>
                  <span className="tplf-crumb">
                    {browse === null || browsedFolder === null
                      ? 'All folders'
                      : [browsedFolder.name, ...browse.path].join(' / ')}
                  </span>
                </div>
                <div className="tplf-rows" role="listbox" aria-label="Drive folders">
                  {browse === null ? renderRootRows() : renderBrowseRows()}
                </div>
                {(uploading !== null || dropHint !== null) && (
                  <p className="tplf-status" role="status">
                    {uploading !== null
                      ? <>Uploading <b>{uploading}</b>…</>
                      : dropHint}
                  </p>
                )}
                {dropActive && (
                  <div className="tplf-dropover" aria-hidden="true">
                    <span>Drop to upload to My Drive and attach to this template</span>
                  </div>
                )}
              </div>
              <aside className="tplf-side" aria-label="Attached folders">
                <h3>In this template</h3>
                <div className="tplf-side-list">
                  {attached.length === 0
                    ? <p className="tplf-side-empty">Nothing attached yet. Select a folder and press Attach.</p>
                    : attached.map((folder) => (
                      <div className="tplf-side-item" key={folder.id}>
                        <FolderDuoIcon className="drive-folder-icon" />
                        <span>{folder.name}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${folder.name} from template`}
                          onClick={() => detach(folder.id)}
                        >
                          <CloseGlyph />
                        </button>
                      </div>
                    ))}
                </div>
              </aside>
              <div className="tplf-foot">
                <span className="tplf-foot-hint">
                  {attached.length === 0
                    ? 'No folders attached'
                    : `${attached.length} ${attached.length === 1 ? 'folder' : 'folders'} attached`}
                </span>
                <button
                  className={`webapp-action${targetAttached ? '' : ' webapp-action--primary'}`}
                  type="button"
                  disabled={target === null}
                  onClick={toggleAttach}
                >
                  {target === null
                    ? 'Select a folder to attach'
                    : targetAttached ? `Detach “${target.name}”` : `Attach “${target.name}”`}
                </button>
              </div>
            </div>
            <label className="tplf-share">
              <input
                type="checkbox"
                checked={shareWithOrg}
                onChange={(event) => setShareWithOrg(event.currentTarget.checked)}
              />
              <span>
                Share attached folders you own with everyone at {orgName} (viewer),
                so the template works without individual grants
              </span>
            </label>
          </section>

          {loadedEnvironment !== null && (
            <details className="blueprint-advanced">
              <summary>Advanced</summary>
              <div className="blueprint-advanced__content">
                <EnvironmentEditor
                  key={editTemplateId ?? 'new'}
                  initial={loadedEnvironment}
                  onChange={setEnvironment}
                />
                {editTemplateId === undefined && (
                  <AgentRulesPicker
                    client={client}
                    value={agentRuleId}
                    onChange={setAgentRuleId}
                  />
                )}
              </div>
            </details>
          )}
        </div>

        <footer className="create-workspace-actions">
          <button className="blueprint-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="create-workspace-primary"
            type="submit"
            disabled={busy || loading || uploading !== null || name.trim() === '' || machineTypeId === ''}
          >
            {editTemplateId === undefined
              ? busy ? 'Creating…' : 'Create template'
              : busy ? 'Saving…' : 'Save template'}
          </button>
        </footer>
      </form>
    </div>
  );
}
