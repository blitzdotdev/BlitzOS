import { useEffect, useState } from 'react';
import type { ControlPlaneClient, MemberView } from '../api';
import type { FolderGrantView, FolderView } from '../file-library-api';
import { DriveAvatar } from './DriveAvatar';
import { canManageFolder } from './drive-model';

export function ShareFolderDialog({
  client,
  folder,
  viewerEmail,
  orgName,
  onClose,
  onChanged,
  onSnack,
}: {
  client: ControlPlaneClient;
  folder: FolderView;
  viewerEmail: string;
  orgName: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onSnack: (message: React.ReactNode) => void;
}) {
  const manage = canManageFolder(folder.role);
  const [displayedFolder, setDisplayedFolder] = useState(folder);
  const [busy, setBusy] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDisplayedFolder(folder), [folder]);
  useEffect(() => {
    if (!manage) return;
    void client.listMembers()
      .then(({ members: loaded }) => setMembers(loaded))
      .catch((caught: Error) => setError(caught.message));
  }, [client, manage]);

  const granted = new Set(displayedFolder.grants?.map((grant) => grant.membershipId) ?? []);
  const trimmed = query.trim().toLowerCase();
  const candidates = members
    .filter((member) => member.status === 'active' && !granted.has(member.id))
    .filter((member) => trimmed === ''
      || member.name.toLowerCase().includes(trimmed)
      || member.email.toLowerCase().includes(trimmed))
    .slice(0, 5);

  const finish = (done?: React.ReactNode) => {
    setBusy(null);
    if (done !== undefined) onSnack(done);
    void onChanged().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Could not refresh folder access.');
    });
  };

  const setOrgRole = (next: FolderView['orgRole'], done: React.ReactNode) => {
    if (busy !== null) return;
    const preceding = displayedFolder;
    setDisplayedFolder({ ...preceding, orgRole: next });
    setBusy('Updating general access…');
    setError(null);
    void client.setFolderOrgRole(folder.id, next)
      .then(() => finish(done))
      .catch((cause: unknown) => {
        setDisplayedFolder(preceding);
        setBusy(null);
        setError(cause instanceof Error ? cause.message : 'Could not update general access.');
      });
  };

  const putGrant = (
    membershipId: string,
    member: FolderGrantView['member'],
    role: FolderGrantView['role'],
    done: React.ReactNode,
  ) => {
    if (busy !== null) return;
    const preceding = displayedFolder;
    const previous = displayedFolder.grants?.find((grant) => (
      grant.membershipId === membershipId
    ));
    const optimistic: FolderGrantView = {
      id: previous?.id ?? 'pending-' + membershipId,
      membershipId,
      role,
      createdAt: previous?.createdAt ?? Date.now(),
      member,
    };
    setDisplayedFolder({
      ...preceding,
      grants: [
        ...(preceding.grants ?? []).filter((grant) => grant.membershipId !== membershipId),
        optimistic,
      ],
    });
    setBusy((previous === undefined ? 'Adding ' : 'Updating ') + (member.name || member.email) + '…');
    setError(null);
    void client.createFolderGrant(folder.id, membershipId, role)
      .then(({ grant: canonical }) => {
        setDisplayedFolder((current) => ({
          ...current,
          grants: [
            ...(current.grants ?? []).filter((grant) => grant.membershipId !== membershipId),
            canonical,
          ],
        }));
        finish(done);
      })
      .catch((cause: unknown) => {
        setDisplayedFolder(preceding);
        setBusy(null);
        setError(cause instanceof Error ? cause.message : 'Could not update folder access.');
      });
  };

  const removeGrant = (grant: FolderGrantView, done: React.ReactNode) => {
    if (busy !== null) return;
    const preceding = displayedFolder;
    setDisplayedFolder({
      ...preceding,
      grants: (preceding.grants ?? []).filter(({ id }) => id !== grant.id),
    });
    setBusy('Removing ' + (grant.member.name || grant.member.email) + '…');
    setError(null);
    void client.revokeFolderGrant(folder.id, grant.id)
      .then(() => finish(done))
      .catch((cause: unknown) => {
        setDisplayedFolder(preceding);
        setBusy(null);
        setError(cause instanceof Error ? cause.message : 'Could not remove folder access.');
      });
  };

  return (
    <div className="drive-scrim" role="presentation" onClick={(event) => { if (busy === null && event.target === event.currentTarget) onClose(); }}>
      <section className="drive-dialog drive-dialog--wide" role="dialog" aria-modal="true" aria-busy={busy !== null} aria-label={`Share ${folder.name}`}>
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
                disabled={busy !== null}
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
                        disabled={busy !== null}
                        onClick={() => {
                          setQuery('');
                          setOpen(false);
                          putGrant(
                            member.id,
                            {
                              name: member.name,
                              email: member.email,
                              avatarUrl: member.avatarUrl,
                            },
                            'editor',
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
            <p className="drive-field-label">General access</p>
            <div className="drive-people">
              <div className="drive-person">
                <span className="drive-org-glyph" aria-hidden="true">{orgName.charAt(0).toUpperCase()}</span>
                <span className="drive-person-copy">
                  <strong>Everyone at {orgName}</strong>
                  <span>{displayedFolder.orgRole === null
                    ? 'No general access'
                    : displayedFolder.orgRole === 'editor' ? 'Anyone in the org can edit' : 'Anyone in the org can view'}</span>
                </span>
                {manage ? (
                  <select
                    className="drive-role-select"
                    aria-label={`Access for everyone at ${orgName}`}
                    value={displayedFolder.orgRole ?? 'off'}
                    disabled={busy !== null}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const next = value === 'editor' || value === 'viewer' ? value : null;
                      setOrgRole(next, next === null
                          ? <span><b>General access removed</b> — only invited people keep access to {folder.name}</span>
                          : <span><b>Everyone at {orgName}</b> can now {next === 'editor' ? 'edit' : 'view'} {folder.name}</span>);
                    }}
                  >
                    <option value="off">Off</option>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                ) : (
                  <span className="drive-role-static">
                    {displayedFolder.orgRole === null ? 'Off' : displayedFolder.orgRole === 'editor' ? 'Editor' : 'Viewer'}
                  </span>
                )}
              </div>
            </div>
          </div>
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
              {displayedFolder.grants?.map((grant) => {
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
                        disabled={busy !== null}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          if (value === 'remove') {
                            removeGrant(grant, <span><b>Access revoked immediately</b> · {grant.member.name || grant.member.email}’s next request — including the next chunk of an upload in flight — is refused</span>);
                            return;
                          }
                          putGrant(
                            grant.membershipId,
                            grant.member,
                            value === 'viewer' ? 'viewer' : 'editor',
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
          {busy !== null && <p className="drive-dialog-note" role="status">{busy}</p>}
          {error && <p className="drive-dialog-note" role="alert">{error}</p>}
          <p className="drive-dialog-note">
            {manage
              ? 'Everyone here can open every file in this folder. Removing access takes effect immediately.'
              : `You have ${folder.role === 'editor' ? 'editor' : 'viewer'} access. Only ${folder.owner.name} or an organization admin can change access.`}
          </p>
        </div>
        <div className="drive-dialog-foot">
          <button className="drive-button drive-button--primary" type="button" disabled={busy !== null} onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
