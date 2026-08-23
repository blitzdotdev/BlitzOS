import { useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { WorkspaceView } from '@blitzos/schema';
import type { FolderView } from '../file-library-api';
import { ModalOverlay } from '../ModalOverlay';
import { BoxGlyph, CheckGlyph } from './DriveIcons';

export function AttachFolderDialog({
  client,
  folder,
  workspaces,
  onClose,
  onChanged,
  onSnack,
}: {
  client: ControlPlaneClient;
  folder: FolderView;
  workspaces: WorkspaceView[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onSnack: (message: React.ReactNode) => void;
}) {
  const attached = new Set(folder.attachedWorkspaceIds);
  const [target, setTarget] = useState(
    () => folder.attachedWorkspaceIds[0] ?? workspaces[0]?.id ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const targetAttached = attached.has(target);
  const path = `/workspace/shared/${folder.name}`;

  const run = (action: Promise<unknown>, done: React.ReactNode) => {
    void action
      .then(() => onChanged())
      .then(() => {
        onSnack(done);
        onClose();
      })
      .catch((caught: Error) => setError(caught.message));
  };

  return (
    <ModalOverlay className="drive-scrim" onDismiss={onClose}>
      <section className="drive-dialog" role="dialog" aria-modal="true" aria-label={`Attach ${folder.name}`}>
        <h2>Attach <em>“{folder.name}”</em></h2>
        <div className="drive-dialog-body">
          {workspaces.length === 0 ? (
            <p className="drive-dialog-note">No workspace you control is available.</p>
          ) : (
            <div className="drive-choices">
              {workspaces.map((workspace) => {
                const active = target === workspace.id;
                return (
                  <button
                    className={`drive-choice${active ? ' drive-choice--active' : ''}`}
                    type="button"
                    aria-pressed={active}
                    key={workspace.id}
                    onClick={() => setTarget(workspace.id)}
                  >
                    <BoxGlyph />
                    <span className="drive-choice-copy">
                      <strong>{workspace.name}</strong>
                      <span>
                        {workspace.phase}
                        {attached.has(workspace.id) ? ' · attached' : ''}
                      </span>
                    </span>
                    {active ? <CheckGlyph /> : <span />}
                  </button>
                );
              })}
            </div>
          )}
          <div className="drive-path-preview">
            <small>Files appear at</small>
            <code className="drive-path">{path}</code>
          </div>
          {error && <p className="drive-dialog-note" role="alert">{error}</p>}
          <p className="drive-dialog-note">
            Syncs both ways, newest write wins — on a periodic tick and
            immediately after webApp edits.
          </p>
        </div>
        <div className="drive-dialog-foot">
          {targetAttached && (
            <button
              className="drive-button drive-button--quiet"
              type="button"
              onClick={() => run(
                client.detachFolder(target, folder.id),
                <span><b>{folder.name}</b> detached</span>,
              )}
            >
              Detach
            </button>
          )}
          <button className="drive-button" type="button" onClick={onClose}>Cancel</button>
          <button
            className="drive-button drive-button--primary"
            type="button"
            disabled={target === '' || targetAttached}
            onClick={() => run(
              client.attachFolder(target, folder.id),
              <span><b>{folder.name}</b> attached · <span className="drive-path">{path}</span></span>,
            )}
          >
            Attach
          </button>
        </div>
      </section>
    </ModalOverlay>
  );
}
