import { useEffect, useState } from 'react';
import { asJsonObject, isNumber, isString, type JsonValue } from './type-guards';

type InviteSummary = {
  email: string | null;
  role: string;
  state: 'ready' | 'redeemed' | 'revoked' | 'expired';
  orgName: string;
};

type InviteStatus =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'invite'; invite: InviteSummary };

function parseInvite<Value>(value: Value): InviteSummary | null {
  const object = asJsonObject(value);
  const invite = object === null ? null : asJsonObject(object.invite);
  if (invite === null) return null;
  const org = asJsonObject(invite.org);
  const state = invite.state;
  if (
    !(state === 'ready' || state === 'redeemed' || state === 'revoked' || state === 'expired')
    || !isString(invite.role)
    || !(invite.email === null || isString(invite.email))
    || isNumber(invite.email)
  ) return null;
  return {
    email: invite.email ?? null,
    role: invite.role,
    state,
    orgName: org !== null && isString(org.name) ? org.name : 'an organization',
  };
}

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

/** The unauthenticated invite landing: shows who invited you where, then
 * hands off to Google sign-in, whose callback redeems the invite. */
export function InviteRedeemPage({ inviteCode }: { inviteCode: string }) {
  const [status, setStatus] = useState<InviteStatus>({ kind: 'loading' });

  useEffect(() => {
    let mounted = true;
    void fetch(`/invite/${encodeURIComponent(inviteCode)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) return { kind: 'unknown' as const };
        // SAFETY: Response.json parses JSON text, whose values are representable by JsonValue.
        const invite = parseInvite(await response.json() as JsonValue);
        return invite === null
          ? { kind: 'unknown' as const }
          : { kind: 'invite' as const, invite };
      })
      .then((next) => {
        if (mounted) setStatus(next);
      })
      .catch(() => {
        if (mounted) setStatus({ kind: 'unknown' });
      });
    return () => { mounted = false; };
  }, [inviteCode]);

  const loginUrl = `/auth/google/start?invite=${encodeURIComponent(inviteCode)}`;
  const closed = status.kind === 'invite'
    && (status.invite.state === 'redeemed'
      || status.invite.state === 'revoked'
      || status.invite.state === 'expired')
    ? CLOSED_COPY[status.invite.state]
    : null;

  return (
    <main className="invite-redeem">
      <section className="invite-redeem__panel" aria-live="polite">
        <p className="invite-redeem__label">BlitzOS invite</p>
        {status.kind === 'loading' ? (
          <>
            <h1>Checking your invite…</h1>
            <p>One moment.</p>
          </>
        ) : status.kind === 'unknown' ? (
          <>
            <h1>Invite not found</h1>
            <p>This link does not match an invite. Check that the full URL was copied.</p>
          </>
        ) : closed !== null ? (
          <>
            <h1>{closed.title}</h1>
            <p>{closed.detail}</p>
          </>
        ) : (
          <>
            <h1>Join {status.invite.orgName}</h1>
            <p>
              You are invited as
              {status.invite.role === 'admin' ? ' an admin' : ' a member'}
              {status.invite.email !== null ? `, using ${status.invite.email}` : ''}.
              Sign in with Google to accept.
            </p>
            <a className="invite-redeem__action" href={loginUrl}>Continue with Google</a>
            {status.invite.email !== null && (
              <small>Sign in with {status.invite.email} — the invite is bound to that address.</small>
            )}
          </>
        )}
      </section>
    </main>
  );
}
