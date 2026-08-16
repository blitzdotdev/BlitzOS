import { useCallback, useEffect, useState } from 'react';
import type { FileStat, WebDAVClient } from 'webdav';
import type { FolderAttachmentView } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import { normalizeFolderName } from './drive-model';
import { BoxGlyph, CheckGlyph, FolderGlyph, LinkGlyph, SharedGlyph } from './DriveIcons';

/** The mockup's workspace "shared" tree section: attachments synced from
 * Drive, plus the publish flow that shares a live workspace directory. */
export function WorkspaceSharedFolders({
  client,
  workspaceId,
  filesClient,
  canControl,
  visible,
  onOpenFolder,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  filesClient: WebDAVClient | null;
  canControl: boolean;
  visible: boolean;
  onOpenFolder: (folderId: string) => void;
}) {
  const [attachments, setAttachments] = useState<FolderAttachmentView[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [directories, setDirectories] = useState<string[] | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void client.listWorkspaceFolders(workspaceId)
      .then(({ folders }) => {
        setAttachments(folders);
        setError(null);
      })
      .catch((caught: Error) => setError(caught.message));
  }, [client, workspaceId]);

  useEffect(() => {
    if (!visible) return;
    load();
  }, [load, visible]);

  useEffect(() => {
    if (!publishOpen || filesClient === null) return;
    setDirectories(null);
    void filesClient.getDirectoryContents('/')
      .then((listing) => {
        const entries: FileStat[] = Array.isArray(listing) ? listing : [];
        setDirectories(entries
          .filter((entry) => entry.type === 'directory')
          .map((entry) => entry.basename)
          .filter((name) => name !== 'shared'));
      })
      .catch((caught: Error) => setError(caught.message));
  }, [filesClient, publishOpen]);

  const publish = () => {
    const name = normalizeFolderName(picked);
    if (name === '' || busy) return;
    setBusy(true);
    setError(null);
    void client.createFolder(name)
      .then(({ folder }) => client.attachFolder(workspaceId, folder.id, picked)
        .then(() => {
          setPublishOpen(false);
          setBusy(false);
          load();
          onOpenFolder(folder.id);
        }))
      .catch((caught: Error) => {
        setBusy(false);
        setError(caught.message);
      });
  };

  if (!visible) return null;

  return (
    <div className="ws-shared" aria-label="Drive folders in this workspace">
      <div className="ws-shared-head">
        <SharedGlyph />
        <span>Drive folders</span>
        {canControl && filesClient !== null && (
          <button
            type="button"
            className="ws-shared-publish"
            onClick={() => { setPicked(''); setPublishOpen(true); }}
          >
            Share a folder…
          </button>
        )}
      </div>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {attachments.length === 0
        ? <p className="ws-shared-empty">No Drive folders attached.</p>
        : attachments.map((attachment) => (
          <button
            className="ws-shared-row"
            type="button"
            key={attachment.id}
            title={`/workspace/${attachment.guestPath ?? `shared/${attachment.name}`} · synced with Drive`}
            onClick={() => onOpenFolder(attachment.id)}
          >
            <FolderGlyph />
            <span>{attachment.name}</span>
            <span className="ws-shared-link"><LinkGlyph /></span>
          </button>
        ))}
      {publishOpen && (
        <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setPublishOpen(false); }}>
          <section className="drive-dialog" role="dialog" aria-modal="true" aria-label="Share a workspace folder to Drive">
            <h2>Share a folder to Drive</h2>
            <div className="drive-dialog-body">
              {directories === null
                ? <p className="drive-dialog-note">Reading /workspace…</p>
                : directories.length === 0
                  ? <p className="drive-dialog-note">No directories under /workspace yet.</p>
                  : (
                    <div className="drive-choices">
                      {directories.map((name) => {
                        const active = picked === name;
                        return (
                          <button
                            className={`drive-choice${active ? ' drive-choice--active' : ''}`}
                            type="button"
                            aria-pressed={active}
                            key={name}
                            onClick={() => setPicked(name)}
                          >
                            <BoxGlyph />
                            <span className="drive-choice-copy">
                              <strong>{name}</strong>
                              <span className="drive-path">/workspace/{name}</span>
                            </span>
                            {active ? <CheckGlyph /> : <span />}
                          </button>
                        );
                      })}
                    </div>
                  )}
              <p className="drive-dialog-note">
                The directory becomes a Drive folder that keeps syncing both
                ways at its current path. Share it from Drive to add people.
              </p>
            </div>
            <div className="drive-dialog-foot">
              <button className="drive-button" type="button" onClick={() => setPublishOpen(false)}>Cancel</button>
              <button
                className="drive-button drive-button--primary"
                type="button"
                disabled={picked === '' || busy}
                onClick={publish}
              >
                {busy ? 'Sharing…' : 'Share to Drive'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
