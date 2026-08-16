import { useEffect, useState } from 'react';
import type { ControlPlaneClient, InviteView } from '../api';

export function InviteLandingPage({ client, code }: { client: ControlPlaneClient; code: string }) {
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client.inviteStatus(code).then((response) => setInvite(response.invite)).catch((caught: Error) => setError(caught.message));
  }, [client, code]);
  return (
    <main className="login-screen"><div className="card login-card">
      <p className="eyebrow">BlitzOS invitation</p>
      {error && <p role="alert">{error}</p>}
      {!error && invite === null && <p>Loading invitation…</p>}
      {invite && <><h1>Join {invite.org?.name ?? 'organization'}</h1><p>This invitation grants the {invite.role} role. Status: {invite.state}.</p>{invite.state === 'ready' && <a className="webapp-action webapp-action--primary" href={client.inviteGoogleLoginUrl(code)}>Continue with Google</a>}</>}
    </div></main>
  );
}
