import type { MachineType, WorkspaceTemplateView } from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { FolderView } from '../file-library-api';
import { OutlinedLoadingRows } from '../LoadingSkeleton';
import { MachineCatalogGrid } from '../MachineCatalogGrid';
import { canManageFolder, normalizeFolderName, splitFolders } from './drive-model';
import { collectDropped } from './drop-upload';

/** Dedicated screen for building a workspace template: name it, pick a
 * machine, and select the Drive folders every workspace created from it
 * starts with. Dropping a directory here uploads it as a new folder and
 * selects it. */
export function CreateTemplateScreen({
  client,
  orgName,
  onCreated,
  onCancel,
}: {
  client: ControlPlaneClient;
  orgName: string;
  onCreated: (template: WorkspaceTemplateView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [machineTypeId, setMachineTypeId] = useState('');
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareWithOrg, setShareWithOrg] = useState(true);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dragDepth = useRef(0);

  const loadFolders = async () => {
    const response = await client.listFolders();
    setFolders(response.folders);
    return response.folders;
  };

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

  const toggle = (folderId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const uploadDroppedFolders = async (
    dropped: { name: string; files: { file: File; relativePath: string }[] }[],
  ) => {
    for (const entry of dropped) {
      const folderName = normalizeFolderName(entry.name);
      if (folderName === '') continue;
      setUploading(folderName);
      try {
        const { folder } = await client.createFolder(folderName);
        for (const { file, relativePath } of entry.files) {
          await client.uploadFolderObject(folder.id, relativePath, file);
        }
        setSelected((current) => new Set([...current, folder.id]));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Upload failed.');
        setUploading(null);
        return;
      }
    }
    setUploading(null);
    await loadFolders().catch((caught: Error) => setError(caught.message));
  };

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '' || machineTypeId === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (shareWithOrg) {
        // Folders you control get org-wide viewer access so the template
        // works for members without individual grants; folders someone else
        // shared with you stay as they are.
        for (const folder of folders) {
          if (!selected.has(folder.id)) continue;
          if (!canManageFolder(folder.role) || folder.orgRole !== null) continue;
          await client.setFolderOrgRole(folder.id, 'viewer');
        }
      }
      const { template } = await client.createWorkspaceTemplate({
        name: trimmed,
        machineTypeId,
        folderIds: [...selected],
      });
      onCreated(template);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Template creation failed.');
      setBusy(false);
    }
  };

  const { mine, shared } = splitFolders(folders);
  const renderFolderRow = (folder: FolderView) => (
    <label className="template-pick" key={folder.id}>
      <input
        type="checkbox"
        checked={selected.has(folder.id)}
        onChange={() => toggle(folder.id)}
      />
      <span className="template-pick__name">{folder.name}</span>
      <span className="template-pick__meta">
        {folder.role === 'owner' ? 'yours' : `by ${folder.owner.name}`}
        {folder.orgRole !== null ? ` · everyone at ${orgName}` : ''}
      </span>
    </label>
  );

  const dragHasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

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
          <div className="create-workspace-header__title"><h1>New workspace template</h1></div>
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

          <section
            className={`blueprint-selection${dropActive ? ' template-dropzone--active' : ''}`}
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
              void collectDropped(
                Array.from(event.dataTransfer.items),
                Array.from(event.dataTransfer.files),
              )
                .then((payload) => uploadDroppedFolders(payload.folders))
                .catch((caught: Error) => setError(caught.message));
            }}
          >
            <div className="blueprint-selection__heading">
              <h2>Folders</h2>
              <p>
                Selected folders sync into every workspace created from this template.
                Drag a folder from your computer here to upload it.
              </p>
            </div>
            {uploading !== null && (
              <p className="template-uploading" role="status">Uploading <b>{uploading}</b>…</p>
            )}
            {folders.length === 0 && !loading && (
              <div className="blueprint-selection__empty">
                No Drive folders yet — drop one here or make one in My Drive.
              </div>
            )}
            {mine.length > 0 && (
              <div className="template-pick-group">
                <h3>My Drive</h3>
                {mine.map(renderFolderRow)}
              </div>
            )}
            {shared.length > 0 && (
              <div className="template-pick-group">
                <h3>Shared with me</h3>
                {shared.map(renderFolderRow)}
              </div>
            )}
            <label className="template-pick template-pick--option">
              <input
                type="checkbox"
                checked={shareWithOrg}
                onChange={(event) => setShareWithOrg(event.currentTarget.checked)}
              />
              <span className="template-pick__name">
                Share selected folders with everyone at {orgName} (viewer)
              </span>
              <span className="template-pick__meta">
                so the template works for members without individual grants
              </span>
            </label>
          </section>
        </div>

        <footer className="create-workspace-actions">
          <button className="blueprint-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="create-workspace-primary"
            type="submit"
            disabled={busy || loading || name.trim() === '' || machineTypeId === ''}
          >
            {busy ? 'Creating…' : 'Create template'}
          </button>
        </footer>
      </form>
    </div>
  );
}
