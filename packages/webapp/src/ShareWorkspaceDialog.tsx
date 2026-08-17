import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControlPlaneClient, MemberView, WorkspaceGrantView } from './api';
import { DriveAvatar } from './files/DriveAvatar';

/** The Drive sharing popup, for workspaces: centered scrim dialog with
 * add-people suggestions, general org access, and per-person roles. */
export function ShareWorkspaceDialog({
  client,
  workspaceId,
  workspaceName,
  orgName,
  orgShareRole,
  owner,
  viewerIsOwner = false,
  onClose,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  workspaceName: string;
  orgName: string;
  orgShareRole: 'editor' | 'viewer' | null;
  owner?: { name: string; avatarUrl: string | null } | null;
  viewerIsOwner?: boolean;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [grants, setGrants] = useState<WorkspaceGrantView[]>([]);
  const [orgRole, setOrgRole] = useState<'editor' | 'viewer' | null>(orgShareRole);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [memberResponse, grantResponse] = await Promise.all([
        client.listMembers(),
        client.listWorkspaceGrants(workspaceId),
      ]);
      setMembers(memberResponse.members);
      setGrants(grantResponse.grants);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load sharing settings.');
    }
  }, [client, workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const granted = useMemo(() => new Set(grants.map((grant) => grant.membershipId)), [grants]);
  const trimmed = query.trim().toLowerCase();
  const candidates = members
    .filter((member) => member.status === 'active' && !granted.has(member.id))
    .filter((member) => trimmed === ''
      || member.name.toLowerCase().includes(trimmed)
      || member.email.toLowerCase().includes(trimmed))
    .slice(0, 5);

  const run = (action: Promise<unknown>) => {
    void action
      .then(() => load())
      .catch((caught: Error) => setError(caught.message));
  };

  return (
    <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="drive-dialog drive-dialog--wide" role="dialog" aria-modal="true" aria-label={`Share ${workspaceName}`}>
        <h2>Share <em>“{workspaceName}”</em></h2>
        <div className="drive-dialog-body">
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
                        run(client.createWorkspaceGrant(workspaceId, member.id, 'editor'));
                      }}
                    >
                      <DriveAvatar name={member.name || member.email} avatarUrl={member.avatarUrl} size="md" />
                      <span className="drive-person-copy"><strong>{member.name || member.email}</strong><span>{member.email}</span></span>
                    </button>
                  ))}
              </div>
            )}
          </div>
          <div className="drive-dialog-section">
            <p className="drive-field-label">General access</p>
            <div className="drive-people">
              <div className="drive-person">
                <span className="drive-org-glyph" aria-hidden="true">{orgName.charAt(0).toUpperCase()}</span>
                <span className="drive-person-copy">
                  <strong>Everyone at {orgName}</strong>
                  <span>{orgRole === null
                    ? 'No general access'
                    : orgRole === 'editor' ? 'Anyone in the org can edit' : 'Anyone in the org can view'}</span>
                </span>
                <select
                  className="drive-role-select"
                  aria-label={`Access for everyone at ${orgName}`}
                  value={orgRole ?? 'off'}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const next = value === 'editor' || value === 'viewer' ? value : null;
                    void client.setWorkspaceOrgRole(workspaceId, next)
                      .then(() => setOrgRole(next))
                      .catch((caught: Error) => setError(caught.message));
                  }}
                >
                  <option value="off">Off</option>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
              </div>
            </div>
          </div>
          <div className="drive-dialog-section">
            <p className="drive-field-label">People with access</p>
            <div className="drive-people">
              {owner && (
                <div className="drive-person">
                  <DriveAvatar name={owner.name} avatarUrl={owner.avatarUrl} me={viewerIsOwner} size="lg" />
                  <span className="drive-person-copy">
                    <strong>{viewerIsOwner ? `${owner.name} (you)` : owner.name}</strong>
                  </span>
                  <span className="drive-role-static">Owner</span>
                </div>
              )}
              {grants.map((grant) => (
                <div className="drive-person" key={grant.id}>
                  <DriveAvatar name={grant.member.name || grant.member.email} avatarUrl={grant.member.avatarUrl} size="lg" />
                  <span className="drive-person-copy">
                    <strong>{grant.member.name || grant.member.email}</strong>
                    <span>{grant.member.email}</span>
                  </span>
                  <select
                    className="drive-role-select"
                    aria-label={`Access for ${grant.member.name || grant.member.email}`}
                    value={grant.role}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === 'remove') {
                        run(client.revokeWorkspaceGrant(workspaceId, grant.id));
                        return;
                      }
                      run(client.createWorkspaceGrant(
                        workspaceId,
                        grant.membershipId,
                        value === 'viewer' ? 'viewer' : 'editor',
                      ));
                    }}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                    <option value="remove">Remove access</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
          {error && <p className="drive-dialog-note" role="alert">{error}</p>}
          <p className="drive-dialog-note">
            Editors can write in terminal, chat, and files. Viewers get a
            read-only terminal, files, and chat replay.
          </p>
        </div>
        <div className="drive-dialog-foot">
          <button className="drive-button drive-button--primary" type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
