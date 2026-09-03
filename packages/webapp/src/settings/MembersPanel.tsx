import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient, MemberView } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { DriveAvatar } from '../files/DriveAvatar';

export function MembersPanel({
  client,
  admin,
  orgName,
  onLeft,
}: {
  client: ControlPlaneClient;
  admin: boolean;
  orgName: string;
  /** Called after the server has removed the caller from the org. The session
   * is now bound elsewhere, or to no org at all, so the caller reloads. */
  onLeft: () => void;
}) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(() => new Set());
  const load = useCallback(async () => {
    try {
      setMembers((await client.listMembers()).members);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load members.');
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  // The server refuses a last-member leave with a 409. Deriving the same
  // condition from the list that is already loaded lets the button say why
  // before it is pressed; the 409 stays the authority.
  const soleMember = members.filter((member) => member.status === 'active').length <= 1;

  const mutateMember = (
    member: MemberView,
    input: { role?: 'admin' | 'member'; status?: 'disabled' | 'active' },
  ) => {
    const optimistic = { ...member, ...input };
    setMembers((current) => current.map((row) => row.id === member.id ? optimistic : row));
    setPendingMemberIds((current) => new Set(current).add(member.id));
    setError(null);
    void client.updateMember(member.id, input)
      .then(({ member: canonical }) => {
        setMembers((current) => current.map((row) => (
          row.id === member.id ? canonical : row
        )));
      })
      .catch((cause: unknown) => {
        setMembers((current) => current.map((row) => (
          row.id === member.id ? member : row
        )));
        setError(cause instanceof Error ? cause.message : 'Could not update member.');
      })
      .finally(() => {
        setPendingMemberIds((current) => {
          const next = new Set(current);
          next.delete(member.id);
          return next;
        });
      });
  };

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Members">
      <header className="settings-panel-header"><div><p>Organization</p><h1>Members</h1><span>People who can work in this organization.</span></div></header>
      {admin && (
        <form className="settings-form" onSubmit={(event) => {
          event.preventDefault();
          setCreatingInvite(true);
          setError(null);
          void client.createInvite({ email, role }).then((created) => {
            setOneTimeLink(window.location.origin + '/invite/' + created.code);
            setEmail('');
          }).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : 'Could not create invite.');
          }).finally(() => setCreatingInvite(false));
        }}>
          <label className="cfg-field">
            <span>Email</span>
            <input type="email" required disabled={creatingInvite} placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
          </label>
          <label className="cfg-field cfg-field--compact">
            <span>Role</span>
            <select value={role} disabled={creatingInvite} onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></select>
          </label>
          <button className="webapp-action webapp-action--primary" type="submit" disabled={creatingInvite}>{creatingInvite ? 'Adding…' : 'Add member'}</button>
        </form>
      )}
      {oneTimeLink && (
        <div className="settings-onetime" role="status">
          <strong>Copy this link now — it is shown once.</strong>
          <div className="settings-onetime-row">
            <input readOnly value={oneTimeLink} aria-label="Member invite link" onFocus={(event) => event.currentTarget.select()} />
            <button className="webapp-action" type="button" onClick={() => void navigator.clipboard.writeText(oneTimeLink)}>Copy</button>
          </div>
        </div>
      )}
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="settings-people">
        {members.map((member) => {
          const pending = pendingMemberIds.has(member.id);
          return (
            <div className={`settings-person${member.status === 'disabled' ? ' settings-person--disabled' : ''}`} key={member.id}>
              <DriveAvatar name={member.name || member.email} avatarUrl={member.avatarUrl} size="lg" />
              <span className="settings-person-copy">
                <strong>{member.name || member.email}</strong>
                <span>{member.email}{member.status === 'disabled' ? ' · disabled' : ''}</span>
              </span>
              {admin ? (
                <span className="settings-person-actions">
                  <select
                    aria-label={'Role for ' + member.email}
                    value={member.role}
                    disabled={pending}
                    onChange={(event) => {
                      const next = event.currentTarget.value === 'admin' ? 'admin' : 'member';
                      mutateMember(member, { role: next });
                    }}
                  ><option value="member">member</option><option value="admin">admin</option></select>
                  <button
                    className="webapp-action"
                    type="button"
                    disabled={pending}
                    onClick={() => mutateMember(member, {
                      status: member.status === 'active' ? 'disabled' : 'active',
                    })}
                  >{pending ? 'Updating…' : member.status === 'active' ? 'Disable' : 'Enable'}</button>
                </span>
              ) : (
                <span className="settings-person-role">{member.role}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="cfg-danger">
        <div className="cfg-danger-copy">
          <strong>Leave {orgName}</strong>
          <span>{soleMember
            ? 'You are the only member. Add another member first, or create your own organization and leave this one.'
            : 'You lose access to this organization\u2019s workspaces, files and connections. An admin can invite you back.'}</span>
        </div>
        <button
          className="cfg-danger-action"
          type="button"
          disabled={soleMember || leaving}
          onClick={() => setConfirmLeave(true)}
        >{leaving ? 'Leaving\u2026' : 'Leave'}</button>
      </div>
      {confirmLeave && (
        <ConfirmationDialog
          title={`Leave ${orgName}?`}
          description={`You lose access to everything in ${orgName}. Workspaces you own stay with the organization.`}
          confirmLabel="Yes, leave"
          cancelLabel="No"
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            setLeaving(true);
            void client.leaveOrg().then(onLeft).catch((caught: Error) => {
              setLeaving(false);
              setError(caught.message);
            });
          }}
        />
      )}
    </section>
  );
}
