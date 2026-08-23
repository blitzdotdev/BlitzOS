import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient, MemberView } from '../api';
import { DriveAvatar } from '../files/DriveAvatar';

/** Membership management only: roles, disable/enable. Adding people is invite
 * creation and lives in InvitesPanel, one settings tab over. */
export function MembersPanel({ client, admin }: { client: ControlPlaneClient; admin: boolean }) {
  const [members, setMembers] = useState<MemberView[]>([]);
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
      <header className="settings-panel-header"><div><p>Organization</p><h1>Members</h1><span>People who can work in this organization. Add people from the Invites tab.</span></div></header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="settings-people">
        {members.map((member) => (
          <div className={`settings-person${member.status === 'disabled' ? ' settings-person--disabled' : ''}`} key={member.id}>
            <DriveAvatar name={member.name || member.email} avatarUrl={member.avatarUrl} size="lg" />
            <span className="settings-person-copy">
              <strong>{member.name || member.email}</strong>
              <span>{member.email}{member.status === 'disabled' ? ' · disabled' : ''}</span>
            </span>
            {admin ? (
              <span className="settings-person-actions">
                <select aria-label={`Role for ${member.email}`} value={member.role} onChange={(event) => {
                  const next = event.currentTarget.value === 'admin' ? 'admin' : 'member';
                  void client.updateMember(member.id, { role: next }).then(load).catch((caught: Error) => setError(caught.message));
                }}><option value="member">member</option><option value="admin">admin</option></select>
                {member.status === 'active' && <button className="webapp-action" type="button" onClick={() => void client.updateMember(member.id, { status: 'disabled' }).then(load).catch((caught: Error) => setError(caught.message))}>Disable</button>}
                {member.status === 'disabled' && <button className="webapp-action" type="button" onClick={() => void client.updateMember(member.id, { status: 'active' }).then(load).catch((caught: Error) => setError(caught.message))}>Enable</button>}
              </span>
            ) : (
              <span className="settings-person-role">{member.role}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
