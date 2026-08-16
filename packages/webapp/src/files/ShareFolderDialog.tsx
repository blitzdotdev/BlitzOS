import { useEffect, useState } from 'react';
import type { ControlPlaneClient, MemberView } from '../api';
import type { FolderView } from '../file-library-api';
import { DriveAvatar } from './DriveAvatar';
import { canManageFolder } from './drive-model';

export function ShareFolderDialog({
  client,
  folder,
  viewerEmail,
  onClose,
  onChanged,
  onSnack,
}: {
  client: ControlPlaneClient;
  folder: FolderView;
  viewerEmail: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onSnack: (message: React.ReactNode) => void;
}) {
  const manage = canManageFolder(folder.role);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!manage) return;
    void client.listMembers()
      .then(({ members: loaded }) => setMembers(loaded))
      .catch((caught: Error) => setError(caught.message));
  }, [client, manage]);

  const granted = new Set(folder.grants?.map((grant) => grant.membershipId) ?? []);
  const trimmed = query.trim().toLowerCase();
  const candidates = members
    .filter((member) => member.status === 'active' && !granted.has(member.id))
    .filter((member) => trimmed === ''
      || member.name.toLowerCase().includes(trimmed)
      || member.email.toLowerCase().includes(trimmed))
    .slice(0, 5);

  const run = (action: Promise<unknown>, done?: React.ReactNode) => {
    void action
      .then(() => onChanged())
      .then(() => {
        if (done !== undefined) onSnack(done);
      })
      .catch((caught: Error) => setError(caught.message));
  };

  return (
    <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="drive-dialog drive-dialog--wide" role="dialog" aria-modal="true" aria-label={`Share ${folder.name}`}>
        <h2>Share <em>“{folder.name}”</em></h2>
        <div className="drive-dialog-body">
          {manage && (
            <div className="drive-dialog-section">
              <input
                className="drive-field"
                type="text"
                autoComplete="off"
                placeholder="Add people"
                aria-label="Add people"
                value={query}
                onFocus={() => setOpen(true)}
                onChange={(event) => { setQuery(event.currentTarget.value); setOpen(true); }}
              />
              {open && (
                <div className="drive-suggestions">
                  {candidates.length === 0
                    ? <div className="drive-suggestion-empty">No one else to add</div>
                    : candidates.map((member) => (
                      <button
                        className="drive-suggestion"
                        type="button"
                        key={member.id}
                        onClick={() => {
                          setQuery('');
                          setOpen(false);
                          run(
                            client.createFolderGrant(folder.id, member.id, 'editor'),
                            <span><b>{member.name || member.email}</b> can now edit {folder.name}</span>,
                          );
                        }}
                      >
                        <DriveAvatar name={member.name || member.email} avatarUrl={member.avatarUrl} size="md" />
                        <span className="drive-person-copy"><strong>{member.name || member.email}</strong><span>{member.email}</span></span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
          <div className="drive-dialog-section">
            <p className="drive-field-label">People with access</p>
            <div className="drive-people">
              <div className="drive-person">
                <DriveAvatar
                  name={folder.owner.name}
                  avatarUrl={folder.owner.avatarUrl}
                  me={folder.role === 'owner'}
                  size="lg"
                />
                <span className="drive-person-copy">
                  <strong>{folder.role === 'owner' ? `${folder.owner.name} (you)` : folder.owner.name}</strong>
                </span>
                <span className="drive-role-static">Owner</span>
              </div>
              {folder.grants?.map((grant) => {
                const mine = grant.member.email === viewerEmail;
                return (
                  <div className="drive-person" key={grant.id}>
                    <DriveAvatar name={grant.member.name || grant.member.email} avatarUrl={grant.member.avatarUrl} me={mine} size="lg" />
                    <span className="drive-person-copy">
                      <strong>{mine ? `${grant.member.name} (you)` : grant.member.name || grant.member.email}</strong>
                      <span>{grant.member.email}</span>
                    </span>
                    {manage ? (
                      <select
                        className="drive-role-select"
                        aria-label={`Access for ${grant.member.name || grant.member.email}`}
                        value={grant.role}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          if (value === 'remove') {
                            run(
                              client.revokeFolderGrant(folder.id, grant.id),
                              <span><b>Access revoked immediately</b> · {grant.member.name || grant.member.email}’s next request — including the next chunk of an upload in flight — is refused</span>,
                            );
                            return;
                          }
                          run(
                            client.createFolderGrant(folder.id, grant.membershipId, value === 'viewer' ? 'viewer' : 'editor'),
                            <span><b>{grant.member.name || grant.member.email}</b> is now a {value} on {folder.name}</span>,
                          );
                        }}
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                        <option value="remove">Remove access</option>
                      </select>
                    ) : (
                      <span className="drive-role-static">{grant.role === 'editor' ? 'Editor' : 'Viewer'}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {error && <p className="drive-dialog-note" role="alert">{error}</p>}
          <p className="drive-dialog-note">
            {manage
              ? 'Everyone here can open every file in this folder. Removing access takes effect immediately.'
              : `You have ${folder.role === 'editor' ? 'editor' : 'viewer'} access. Only ${folder.owner.name} or an organization admin can change access.`}
          </p>
        </div>
        <div className="drive-dialog-foot">
          <button className="drive-button drive-button--primary" type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
