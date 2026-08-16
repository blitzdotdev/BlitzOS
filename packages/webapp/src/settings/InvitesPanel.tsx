import { INVITE_TTL_DAYS } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient, InviteView } from '../api';

export function InvitesPanel({ client }: { client: ControlPlaneClient }) {
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setInvites((await client.listInvites()).invites);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load invites.');
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Invites">
      <header className="settings-panel-header"><div><p>Organization</p><h1>Invite links</h1><span>Links expire after {INVITE_TTL_DAYS} days.</span></div></header>
      <form className="settings-credential-form" onSubmit={(event) => {
        event.preventDefault();
        const input = { email: email.trim() || undefined, role };
        void client.createInvite(input).then((created) => {
          setOneTimeLink(`${window.location.origin}/invite/${created.code}`);
          setEmail('');
          return load();
        }).catch((caught: Error) => setError(caught.message));
      }}>
        <label>Email (optional)<input type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} /></label>
        <label>Role<select value={role} onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></select></label>
        <button className="webapp-action" type="submit">Create invite</button>
      </form>
      {oneTimeLink && <div className="webapp-form-message"><strong>Copy this link now—it is shown once.</strong><input readOnly value={oneTimeLink} aria-label="Invite link" /><button type="button" onClick={() => void navigator.clipboard.writeText(oneTimeLink)}>Copy</button></div>}
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="settings-definition-list">
        {invites.map((invite) => <div key={invite.id}><dt>{invite.email ?? 'Anyone with the link'}</dt><dd>{invite.role} · {invite.state}{invite.state === 'ready' && <button type="button" onClick={() => void client.revokeInvite(invite.id).then(load).catch((caught: Error) => setError(caught.message))}>Revoke</button>}</dd></div>)}
      </div>
    </section>
  );
}
