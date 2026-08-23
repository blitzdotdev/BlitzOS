import { useEffect, useState, type ReactNode } from 'react';
import type { ControlPlaneClient, MemberView } from './api';
import { DriveAvatar } from './files/DriveAvatar';
import { ModalOverlay } from './ModalOverlay';

/** The grant row both resources share: workspace and folder grants are
 * structurally identical on the wire, so one dialog renders either. */
export type ShareGrantRow = {
  id: string;
  membershipId: string;
  role: 'editor' | 'viewer';
  member: { name: string; email: string; avatarUrl: string | null };
};

/** The Drive sharing popup, shared by workspaces and folders: add-people
 * suggestions, general org access, and per-person roles. The resource side
 * stays with the wrapper — it supplies the grants to draw and async actions
 * that carry their own reload (and snackbar) chains; failures land in this
 * dialog's error slot. */
export function ShareAccessDialog({
  client,
  name,
  orgName,
  manage = true,
  owner,
  viewerEmail,
  orgRole,
  grants,
  note,
  onLoad,
  onSetOrgRole,
  onGrant,
  onChangeRole,
  onRevoke,
  onClose,
}: {
  client: Pick<ControlPlaneClient, 'listMembers'>;
  /** The resource's display name, quoted in the heading. */
  name: string;
  orgName: string;
  /** False renders the read-only shape: no add-people, static role labels. */
  manage?: boolean;
  owner: { name: string; avatarUrl: string | null; isViewer: boolean } | null;
  /** Marks the viewer's own grant row with "(you)" when it matches. */
  viewerEmail?: string;
  orgRole: 'editor' | 'viewer' | null;
  grants: readonly ShareGrantRow[];
  /** The explanatory footnote under the people list. */
  note: ReactNode;
  /** Loads the wrapper's grant state once on mount; errors land here. */
  onLoad?: () => Promise<void>;
  onSetOrgRole: (next: 'editor' | 'viewer' | null) => Promise<void>;
  onGrant: (member: MemberView) => Promise<void>;
  onChangeRole: (grant: ShareGrantRow, role: 'editor' | 'viewer') => Promise<void>;
  onRevoke: (grant: ShareGrantRow) => Promise<void>;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: Promise<void>) => {
    void action.catch((caught: Error) => setError(caught.message));
  };

  useEffect(() => {
    if (!manage) return;
    void client.listMembers()
      .then(({ members: loaded }) => setMembers(loaded))
      .catch((caught: Error) => setError(caught.message));
  }, [client, manage]);

  useEffect(() => {
    if (onLoad === undefined) return;
    void onLoad().catch((caught: Error) => setError(caught.message));
  }, [onLoad]);

  const granted = new Set(grants.map((grant) => grant.membershipId));
  const trimmed = query.trim().toLowerCase();
  const candidates = members
    .filter((member) => member.status === 'active' && !granted.has(member.id))
    .filter((member) => trimmed === ''
      || member.name.toLowerCase().includes(trimmed)
      || member.email.toLowerCase().includes(trimmed))
    .slice(0, 5);

  return (
    <ModalOverlay className="drive-scrim" onDismiss={onClose}>
      <section className="drive-dialog drive-dialog--wide" role="dialog" aria-modal="true" aria-label={`Share ${name}`}>
        <h2>Share <em>“{name}”</em></h2>
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
                          run(onGrant(member));
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
                  <span>{orgRole === null
                    ? 'No general access'
                    : orgRole === 'editor' ? 'Anyone in the org can edit' : 'Anyone in the org can view'}</span>
                </span>
                {manage ? (
                  <select
                    className="drive-role-select"
                    aria-label={`Access for everyone at ${orgName}`}
                    value={orgRole ?? 'off'}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const next = value === 'editor' || value === 'viewer' ? value : null;
                      run(onSetOrgRole(next));
                    }}
                  >
                    <option value="off">Off</option>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                ) : (
                  <span className="drive-role-static">
                    {orgRole === null ? 'Off' : orgRole === 'editor' ? 'Editor' : 'Viewer'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="drive-dialog-section">
            <p className="drive-field-label">People with access</p>
            <div className="drive-people">
              {owner && (
                <div className="drive-person">
                  <DriveAvatar name={owner.name} avatarUrl={owner.avatarUrl} me={owner.isViewer} size="lg" />
                  <span className="drive-person-copy">
                    <strong>{owner.isViewer ? `${owner.name} (you)` : owner.name}</strong>
                  </span>
                  <span className="drive-role-static">Owner</span>
                </div>
              )}
              {grants.map((grant) => {
                const mine = viewerEmail !== undefined && grant.member.email === viewerEmail;
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
                            run(onRevoke(grant));
                            return;
                          }
                          run(onChangeRole(grant, value === 'viewer' ? 'viewer' : 'editor'));
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
          <p className="drive-dialog-note">{note}</p>
        </div>
        <div className="drive-dialog-foot">
          <button className="drive-button drive-button--primary" type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </ModalOverlay>
  );
}
