import { useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { normalizeFolderName } from './drive-model';

/** Confirms publishing one live workspace directory to Drive. Reached from
 * the files view context menu ("Share to Drive…" on a top-level folder). */
export function ShareToDriveDialog({
  client,
  workspaceId,
  path,
  onCancel,
  onShared,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  path: string;
  onCancel: () => void;
  onShared: (folderId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = normalizeFolderName(path);

  const share = () => {
    if (name === '' || busy) return;
    setBusy(true);
    setError(null);
    void client.createFolder(name)
      .then(({ folder }) => client.attachFolder(workspaceId, folder.id, path)
        .then(() => onShared(folder.id))
        // The folder only exists to carry this attachment; a failed attach
        // must not leave an empty orphan in Drive.
        .catch(async (caught: Error) => {
          await client.deleteFolder(folder.id).catch(() => undefined);
          throw caught;
        }))
      .catch((caught: Error) => {
        setBusy(false);
        setError(caught.message);
      });
  };

  return (
    <div
      className="drive-scrim"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <section className="drive-dialog" role="dialog" aria-modal="true" aria-label="Share a workspace folder to Drive">
        <h2>Share “{path}” to Drive</h2>
        <div className="drive-dialog-body">
          {error && <p className="webapp-form-message" role="alert">{error}</p>}
          <p className="drive-dialog-note">
            <code>/workspace/{path}</code> becomes the Drive folder
            “{name}” and keeps syncing both ways at its current path.
            Share it from Drive to add people.
          </p>
        </div>
        <div className="drive-dialog-foot">
          <button className="drive-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="drive-button drive-button--primary"
            type="button"
            disabled={name === '' || busy}
            onClick={share}
          >
            {busy ? 'Sharing…' : 'Share to Drive'}
          </button>
        </div>
      </section>
    </div>
  );
}
