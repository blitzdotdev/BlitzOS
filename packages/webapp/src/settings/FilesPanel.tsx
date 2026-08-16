import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ControlPlaneClient,
  MemberView,
} from '../api';
import type {
  FolderObjectView,
  FolderView,
} from '../file-library-api';

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function FilesPanel({ client }: { client: ControlPlaneClient }) {
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [objects, setObjects] = useState<FolderObjectView[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [name, setName] = useState('');
  const [membershipId, setMembershipId] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = folders.find(({ id }) => id === selectedId) ?? null;
  const canControl = selected?.role === 'owner' || selected?.role === 'admin';
  const canWrite = selected !== null && selected.role !== 'viewer';

  const loadFolders = useCallback(async () => {
    try {
      const response = await client.listFolders();
      setFolders(response.folders);
      setSelectedId((current) => response.folders.some(({ id }) => id === current)
        ? current
        : response.folders[0]?.id ?? '');
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load folders.');
    }
  }, [client]);

  const loadObjects = useCallback(async () => {
    if (!selectedId) {
      setObjects([]);
      return;
    }
    try {
      setObjects((await client.listFolderObjects(selectedId)).objects);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load folder files.');
    }
  }, [client, selectedId]);

  useEffect(() => { void loadFolders(); }, [loadFolders]);
  useEffect(() => { void loadObjects(); }, [loadObjects]);
  useEffect(() => {
    if (!canControl) return;
    void client.listMembers().then(({ members: loaded }) => setMembers(loaded)).catch((caught: Error) => {
      setError(caught.message);
    });
  }, [canControl, client]);

  const grantedMemberships = useMemo(
    () => new Set(selected?.grants.map((grant) => grant.membershipId) ?? []),
    [selected?.grants],
  );
  const shareCandidates = members.filter((member) => (
    member.status === 'active'
    && !grantedMemberships.has(member.id)
  ));

  const upload = async (files: FileList) => {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await client.uploadFolderObject(selected.id, file.webkitRelativePath || file.name, file);
      }
      await loadObjects();
      if (fileInput.current) fileInput.current.value = '';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Files">
      <header className="settings-panel-header">
        <div><p>Organization library</p><h1>Files</h1><span>Shared folders persist outside workspaces.</span></div>
      </header>
      <form className="settings-credential-form" onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        void client.createFolder(name.trim()).then(({ folder }) => {
          setName('');
          setSelectedId(folder.id);
          return loadFolders();
        }).catch((caught: Error) => setError(caught.message)).finally(() => setBusy(false));
      }}>
        <label>Folder name<input value={name} maxLength={128} onChange={(event) => setName(event.currentTarget.value)} /></label>
        <button className="webapp-action" type="submit" disabled={busy || !name.trim()}>Create folder</button>
      </form>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {folders.length === 0 ? (
        <p className="settings-credential-state">No folders yet.</p>
      ) : (
        <>
          <div className="files-library-toolbar">
            <label>Folder<select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name} · {folder.role}</option>)}</select></label>
            {canWrite && <label className="webapp-action">{busy ? 'Uploading…' : 'Upload'}<input ref={fileInput} type="file" multiple disabled={busy} onChange={(event) => { if (event.currentTarget.files) void upload(event.currentTarget.files); }} /></label>}
            {canControl && selected && <button className="webapp-action webapp-action--danger" type="button" disabled={busy} onClick={() => {
              if (!window.confirm(`Delete ${selected.name} and every file in it?`)) return;
              setBusy(true);
              void client.deleteFolder(selected.id).then(loadFolders).catch((caught: Error) => setError(caught.message)).finally(() => setBusy(false));
            }}>Delete folder</button>}
          </div>
          {canControl && selected && (
            <section className="files-library-share" aria-label={`Share ${selected.name}`}>
              <h2>Sharing</h2>
              <p>Guest workspace edits are attributed to the workspace owner until guest identity tickets ship.</p>
              <form onSubmit={(event) => {
                event.preventDefault();
                if (!membershipId) return;
                void client.createFolderGrant(selected.id, membershipId, shareRole).then(() => {
                  setMembershipId('');
                  return loadFolders();
                }).catch((caught: Error) => setError(caught.message));
              }}>
                <select aria-label="Member" value={membershipId} onChange={(event) => setMembershipId(event.currentTarget.value)}><option value="">Select member</option>{shareCandidates.map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}</select>
                <select aria-label="Folder role" value={shareRole} onChange={(event) => setShareRole(event.currentTarget.value === 'viewer' ? 'viewer' : 'editor')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
                <button type="submit" disabled={!membershipId}>Share</button>
              </form>
              <ul>{selected.grants.map((grant) => <li key={grant.id}><span>{grant.member.name || grant.member.email} · {grant.role}</span><button type="button" onClick={() => void client.revokeFolderGrant(selected.id, grant.id).then(loadFolders).catch((caught: Error) => setError(caught.message))}>Revoke</button></li>)}</ul>
            </section>
          )}
          <div className="settings-credential-list files-library-list">
            {objects.length === 0 && <p className="settings-credential-state">This folder is empty.</p>}
            {objects.map((object) => (
              <div className="settings-credential-row" key={object.key}>
                <div><h3>{object.key}</h3><p>{readableSize(object.size)} · edited {new Date(object.mtime).toLocaleString()} by {object.editedBy}</p></div>
                <button className="webapp-action" type="button" onClick={() => void client.downloadFolderObject(selectedId, object.key).then((blob) => {
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = object.key.split('/').at(-1) || object.key;
                  link.click();
                  URL.revokeObjectURL(url);
                }).catch((caught: Error) => setError(caught.message))}>Download</button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
