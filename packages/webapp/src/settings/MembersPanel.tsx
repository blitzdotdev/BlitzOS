import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient, MemberView } from '../api';

export function MembersPanel({ client, admin }: { client: ControlPlaneClient; admin: boolean }) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setMembers((await client.listMembers()).members);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load members.');
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Members">
      <header className="settings-panel-header"><div><p>Organization</p><h1>Members</h1><span>People who can work in this organization.</span></div></header>
      {admin && (
        <form className="settings-credential-form" onSubmit={(event) => {
          event.preventDefault();
          void client.createMember(email, role).then(() => {
            setEmail('');
            return load();
          }).catch((caught: Error) => setError(caught.message));
        }}>
          <label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.currentTarget.value)} /></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <button className="webapp-action" type="submit">Add member</button>
        </form>
      )}
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="settings-definition-list">
        {members.map((member) => (
          <div key={member.id}>
            <dt>{member.name || member.email}<span>{member.email}</span></dt>
            <dd>
              {admin ? (
                <>
                  <select aria-label={`Role for ${member.email}`} value={member.role} onChange={(event) => {
                    const next = event.currentTarget.value === 'admin' ? 'admin' : 'member';
                    void client.updateMember(member.id, { role: next }).then(load).catch((caught: Error) => setError(caught.message));
                  }}><option value="member">member</option><option value="admin">admin</option></select>
                  {member.status === 'active' && <button type="button" onClick={() => void client.updateMember(member.id, { status: 'disabled' }).then(load).catch((caught: Error) => setError(caught.message))}>Disable</button>}
                  {member.status === 'disabled' && <button type="button" onClick={() => void client.updateMember(member.id, { status: 'active' }).then(load).catch((caught: Error) => setError(caught.message))}>Enable</button>}
                  {member.status === 'invited' && !member.bound && <button type="button" onClick={() => void client.deleteMember(member.id).then(load).catch((caught: Error) => setError(caught.message))}>Remove</button>}
                </>
              ) : `${member.role} · ${member.status}`}
            </dd>
          </div>
        ))}
      </div>
    </section>
  );
}
