import type {
  CatalogEntryView,
  ConnectionView,
  CreateWorkspaceTemplateRequest,
  GithubRepositoryView,
  MachineType,
  TemplateConnectionView,
  WorkspaceEnvironment,
  WorkspaceTemplateView,
} from '@blitzos/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { TemplateConnectionsSection } from './TemplateConnectionsSection';
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
} from './drive-model';
import { collectDropped, DropLimitError } from './drop-upload';
import { TemplateRepoPicker } from './TemplateRepoPicker';
import { TemplateRepoUrls } from './TemplateRepoUrls';
import { useTemplateUploads } from './use-template-uploads';
import { orgCredentialFor } from '../connections/ProviderAdminForm';

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
 * machine, and attach what every workspace created from it starts with —
 * Drive folders, loose files (wrapped into an auto-created files folder),
 * and GitHub repos. The folder browser merges My Drive and Shared with me:
 * single click selects, double click enters, Back walks up, and the drop
 * strip uploads dropped directories and files alike. */
export function CreateTemplateScreen({
  client,
  orgName,
  admin = false,
  editTemplateId,
  isAdmin = false,
  onCreated,
  onCancel,
}: {
  client: ControlPlaneClient;
  orgName: string;
  /** Shows the org-credential config forms; the PUT route enforces the same
   * gate server-side. Members see who to ask instead. */
  admin?: boolean;
  /** When set, the screen edits this template instead of creating one. */
  editTemplateId?: string;
  /** Renders the org-default checkbox; the server enforces it regardless. */
  isAdmin?: boolean;
  onCreated: (template: WorkspaceTemplateView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [machineTypeId, setMachineTypeId] = useState('');
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [attachedIds, setAttachedIds] = useState<Set<string>>(new Set());
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  /** Open state of the single Upload button's files-or-folder menu. */
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [objectsByFolder, setObjectsByFolder] = useState<Map<string, FolderObjectView[]>>(new Map());
  const [shareWithOrg, setShareWithOrg] = useState(true);
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  // A template references providers by name. It never carries a grant, so an
  // instantiating member always supplies their own identity — except the
  // admin-configured providers below, whose one org credential is stored
  // right here when the provider gets attached.
  const [templateConnections, setTemplateConnections] = useState<Map<string, TemplateConnectionView>>(new Map());
  const [orgConnections, setOrgConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [dropActive, setDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [environment, setEnvironment] = useState(EMPTY_WORKSPACE_ENVIRONMENT);
  // Editing loads the stored environment first, then re-keys the editor onto
  // it. Null means an edit whose template has not arrived yet.
  const [loadedEnvironment, setLoadedEnvironment] = useState<WorkspaceEnvironment | null>(
    editTemplateId === undefined ? EMPTY_WORKSPACE_ENVIRONMENT : null,
  );
  const [agentRuleId, setAgentRuleId] = useState<string | null>(null);
  const [isOrgDefault, setIsOrgDefault] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [installationRepos, setInstallationRepos] = useState<ReadonlySet<string> | null>(null);
  const dragDepth = useRef(0);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const folderPickerRef = useRef<HTMLInputElement | null>(null);
  const {
    uploading,
    dropHint,
    setDropHint,
    fileCounts,
    pickedNames,
    pickDriveFile,
    dropDriveFile,
    uploadDropped,
    uploadPickedFiles,
  } = useTemplateUploads({
    client,
    templateName: name,
    onAttach: (folderId) => setAttachedIds((current) => new Set([...current, folderId])),
    onFolders: setFolders,
    onError: setError,
  });

  const storeInstallationRepositories = useCallback((repositories: GithubRepositoryView[]) => {
    setInstallationRepos(new Set(repositories.map(({ fullName }) => fullName)));
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.allSettled([
      client.listMachineTypes(),
      client.listFolders(),
      client.listConnectionCatalog(),
      client.listConnections(),
    ]).then(([machineResult, folderResult, catalogResult, connectionsResult]) => {
      if (!mounted) return;
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value.providers);
      // Losing this read costs only the configured chips and the config
      // forms' replace state; the picker itself keeps working.
      if (connectionsResult.status === 'fulfilled') {
        setOrgConnections(connectionsResult.value.connections);
      }
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

  const loadObjects = (folderId: string) => {
    if (objectsByFolder.has(folderId)) return;
    void client.listFolderObjects(folderId)
      .then(({ objects }) => {
        setObjectsByFolder((current) => new Map(current).set(folderId, objects));
      })
      .catch((caught: Error) => setError(caught.message));
  };

  const enterFolder = (folderId: string) => {
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

  const toggleAttach = (folderId: string) => {
    setAttachedIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
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
      setIsOrgDefault(existing.isOrgDefault);
      setRepos(existing.repos);
      // Keep every attached folder id, including ones this editor cannot
      // read — the server preserves them and only checks new additions.
      setAttachedIds(new Set(existing.folders.map(({ id }) => id)));
      setTemplateConnections(new Map(
        existing.connections.map((connection) => [connection.provider, connection]),
      ));
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
        connections: [...templateConnections.values()],
        repos,
      };
      // Only admins see the checkbox, so only admins speak about the org
      // default at all — absence leaves the org pointer untouched.
      if (isAdmin) request.isOrgDefault = isOrgDefault;
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
          className={`tplf-row${attachedIds.has(folder.id) ? ' tplf-row--selected' : ''}`}
          type="button"
          key={folder.id}
          aria-pressed={attachedIds.has(folder.id)}
          onClick={() => toggleAttach(folder.id)}
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
        {entries.files.map((file) => {
          const picked = pickedNames.has(file.name);
          return (
            <button
              className={`tplf-row${picked ? ' tplf-row--selected' : ''}`}
              type="button"
              key={file.key}
              aria-pressed={picked}
              disabled={uploading !== null}
              onClick={() => {
                if (browse === null) return;
                if (picked) void dropDriveFile(file.name);
                else void pickDriveFile(browse.folderId, file.key, file.name);
              }}
            >
              <DocDuoIcon name={file.name} className="drive-folder-icon" />
              <span className="tplf-row-name">{file.name}</span>
              <span className="tplf-row-owner" />
              <span className="tplf-row-state">
                {picked && <em className="tplf-chip tplf-chip--attached">In template</em>}
                <span>{formatWhen(file.mtime)} · {formatBytes(file.size)}</span>
              </span>
            </button>
          );
        })}
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
              <h2>Files</h2>
              <p>Every workspace starts with these. Click to attach, double-click to look inside.</p>
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
                    .then(uploadDropped)
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
              <aside className="tplf-side" aria-label="In this template">
                <h3>In this template</h3>
                <div className="tplf-side-list">
                  {attached.length === 0
                    ? <p className="tplf-side-empty">Nothing yet. Click a folder, or upload.</p>
                    : attached.map((folder) => (
                      <div className="tplf-side-item" key={folder.id}>
                        <FolderDuoIcon className="drive-folder-icon" />
                        <span>
                          {folder.name}
                          {fileCounts.has(folder.id) && (
                            ` · ${String(fileCounts.get(folder.id))} ${fileCounts.get(folder.id) === 1 ? 'file' : 'files'}`
                          )}
                        </span>
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
                    ? 'Nothing attached'
                    : `${attached.length} ${attached.length === 1 ? 'attachment' : 'attachments'}`}
                </span>
                <input
                  ref={filePickerRef}
                  type="file"
                  multiple
                  hidden
                  aria-label="Upload files"
                  onChange={(event) => {
                    const picked = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = '';
                    if (picked.length > 0) uploadPickedFiles(picked);
                  }}
                />
                <input
                  // The directory-picker flag is not in React's typed DOM props,
                  // so the ref callback stamps the attribute; webkitdirectory
                  // works cross-browser.
                  ref={(node) => {
                    folderPickerRef.current = node;
                    node?.setAttribute('webkitdirectory', '');
                  }}
                  type="file"
                  hidden
                  aria-label="Upload a folder"
                  onChange={(event) => {
                    const picked = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = '';
                    if (picked.length > 0) uploadPickedFiles(picked);
                  }}
                />
                <div className="tplf-upload-wrap">
                  <button
                    className="create-workspace-primary tplf-upload"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={uploadMenuOpen}
                    disabled={uploading !== null}
                    onClick={() => setUploadMenuOpen((open) => !open)}
                  >
                    {uploading === null ? 'Upload' : 'Uploading…'}
                  </button>
                  {uploadMenuOpen && (
                    <>
                      <button
                        className="drive-new-scrim"
                        type="button"
                        aria-label="Close menu"
                        onClick={() => setUploadMenuOpen(false)}
                      />
                      <div className="drive-menu tplf-upload-menu" role="menu">
                        <button
                          className="drive-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setUploadMenuOpen(false);
                            filePickerRef.current?.click();
                          }}
                        >
                          <DocDuoIcon name="file" /><span>Files</span>
                        </button>
                        <button
                          className="drive-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setUploadMenuOpen(false);
                            folderPickerRef.current?.click();
                          }}
                        >
                          <FolderDuoIcon /><span>Folder</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <TemplateConnectionsSection
              client={client}
              admin={admin}
              catalog={catalog}
              orgConnections={orgConnections}
              onOrgConnections={setOrgConnections}
              value={templateConnections}
              onChange={setTemplateConnections}
            />
            <div className="tplf-repos">
              <h2>Repositories</h2>
              <p>Repos cloned into /workspace at start. Picking one attaches GitHub above.</p>
              <TemplateRepoPicker
                client={client}
                admin={admin}
                githubConfigured={orgCredentialFor(orgConnections, 'github')}
                value={repos}
                onChange={setRepos}
                onRepositories={storeInstallationRepositories}
              />
              <TemplateRepoUrls
                client={client}
                value={repos}
                onChange={setRepos}
                installationRepos={installationRepos}
              />
            </div>
            <label className="tplf-share">
              <input
                type="checkbox"
                checked={shareWithOrg}
                onChange={(event) => setShareWithOrg(event.currentTarget.checked)}
              />
              <span>Let everyone at {orgName} see these files</span>
            </label>
            {isAdmin && (
              <label className="tplf-share">
                <input
                  type="checkbox"
                  aria-label={`Default template for ${orgName}`}
                  checked={isOrgDefault}
                  onChange={(event) => setIsOrgDefault(event.currentTarget.checked)}
                />
                <span>Make this the default for {orgName}</span>
              </label>
            )}
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
