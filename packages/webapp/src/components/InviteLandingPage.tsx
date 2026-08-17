import { useEffect, useState } from 'react';
import type { ControlPlaneClient, InviteView } from '../api';

const CLOSED_COPY = {
  redeemed: {
    title: 'This invite was already used',
    detail: 'Each invite link works once. Ask for a fresh link if you still need access.',
  },
  revoked: {
    title: 'This invite was revoked',
    detail: 'An organization admin withdrew this link. Ask them for a new one.',
  },
  expired: {
    title: 'This invite expired',
    detail: 'Invite links stop working after a few days. Ask for a fresh link.',
  },
} as const;

export function InviteLandingPage({ client, code }: { client: ControlPlaneClient; code: string }) {
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client.inviteStatus(code)
      .then((response) => setInvite(response.invite))
      .catch((caught: Error) => setError(caught.message));
  }, [client, code]);

  const closed = invite !== null
    && (invite.state === 'redeemed' || invite.state === 'revoked' || invite.state === 'expired')
    ? CLOSED_COPY[invite.state]
    : null;

  return (
    <main className="invite-redeem">
      <section className="invite-redeem__panel" aria-live="polite">
        <p className="invite-redeem__label">BlitzOS invite</p>
        {error !== null ? (
          <>
            <h1>Invite not found</h1>
            <p>This link does not match an invite. Check that the full URL was copied.</p>
          </>
        ) : invite === null ? (
          <>
            <h1>Checking your invite…</h1>
            <p>One moment.</p>
          </>
        ) : closed !== null ? (
          <>
            <h1>{closed.title}</h1>
            <p>{closed.detail}</p>
          </>
        ) : (
          <>
            <h1>Join {invite.org?.name ?? 'an organization'}</h1>
            <p>
              You are invited as
              {invite.role === 'admin' ? ' an admin' : ' a member'}
              {invite.email !== null ? `, using ${invite.email}` : ''}.
              Sign in with Google to accept.
            </p>
            <a className="invite-redeem__action" href={client.inviteGoogleLoginUrl(code)}>
              Continue with Google
            </a>
            {invite.email !== null && (
              <small>Sign in with {invite.email} — the invite is bound to that address.</small>
            )}
          </>
        )}
      </section>
    </main>
  );
}
