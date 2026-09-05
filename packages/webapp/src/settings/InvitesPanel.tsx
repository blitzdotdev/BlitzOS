import { INVITE_TTL_DAYS } from '@blitzos/schema';
import type { OrgUsageResponse } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, type ControlPlaneClient, type InviteView } from '../api';
import { PanelHeader } from './primitives';

/** A refusal that came with a way out. The seat gate is the only one, and it
 * is the only error here that must not be printed as a sentence. */
interface SeatRefusal {
  message: string;
  paymentUrl: string;
  seatsNeeded: number;
}

interface PendingInvite {
  id: string;
  email: string | null;
  role: 'admin' | 'member';
}

function currency(seats: number, monthlyPerSeat: number): string {
  return `$${(seats * monthlyPerSeat).toLocaleString('en-US')}`;
}

export function InvitesPanel({ client }: { client: ControlPlaneClient }) {
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [usage, setUsage] = useState<OrgUsageResponse | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SeatRefusal | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      setInvites((await client.listInvites()).invites);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load invites.');
    } finally {
      setLoading(false);
    }
    // A deployment with no billing service has no seat limit to show, and this
    // route still answers. Its failure is not the invite list's failure.
    try {
      setUsage(await client.orgUsage());
    } catch {
      setUsage(null);
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const seatLimit = usage?.seatLimit ?? null;
  const seatsUsed = usage?.seatsUsed ?? 0;
  const full = seatLimit !== null && seatsUsed >= seatLimit;

  // Follows the hop the control plane signs. Minted on the click rather than
  // on load: the token lives fifteen minutes, and a settings tab left open
  // outlives that. One destination — the billing service decides whether this
  // organization is buying seats or changing the ones it has.
  const openBilling = () => {
    void client.billing()
      .then((billing) => { window.location.href = billing.url; })
      .catch((caught: Error) => setError(caught.message));
  };

  const revoke = (invite: InviteView) => {
    const index = invites.findIndex(({ id }) => id === invite.id);
    setInvites((current) => current.filter(({ id }) => id !== invite.id));
    setError(null);
    void client.revokeInvite(invite.id).catch((cause: unknown) => {
      setInvites((current) => {
        if (current.some(({ id }) => id === invite.id)) return current;
        const restored = [...current];
        restored.splice(Math.max(index, 0), 0, invite);
        return restored;
      });
      setError(cause instanceof Error ? cause.message : 'Could not revoke invite.');
    });
  };

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Invites">
      <PanelHeader eyebrow="Organization" title="Invite links" detail={<>Links expire after {INVITE_TTL_DAYS} days.</>} />
      {seatLimit !== null && (
        <div className="settings-seats">
          <span><b>{seatsUsed}</b> of <b>{seatLimit}</b> {seatLimit === 1 ? 'seat' : 'seats'} used</span>
          <span className="settings-seats-bar">
            <span
              className={`settings-seats-fill${seatsUsed > seatLimit ? ' settings-seats-fill--over' : ''}`}
              style={{ width: `${Math.min(100, Math.round((seatsUsed / seatLimit) * 100))}%` }}
            />
          </span>
          <button
            className={`webapp-action${full ? ' webapp-action--primary' : ''}`}
            type="button"
            onClick={openBilling}
          >
            Manage
          </button>
        </div>
      )}
      <form className="settings-form" onSubmit={(event) => {
        event.preventDefault();
        if (loading || creating) return;
        const input = { email: email.trim() || undefined, role };
        const pending: PendingInvite = {
          id: `pending-invite-${crypto.randomUUID()}`,
          email: input.email ?? null,
          role,
        };
        setPendingInvites((current) => [pending, ...current]);
        setCreating(true);
        setError(null);
        setRefusal(null);
        void client.createInvite(input).then((created) => {
          setPendingInvites((current) => current.filter(({ id }) => id !== pending.id));
          setOneTimeLink(window.location.origin + '/invite/' + created.code);
          setInvites((current) => [
            created.invite,
            ...current.filter(({ id }) => id !== created.invite.id),
          ]);
          setEmail('');
        }).catch((caught: Error) => {
          setPendingInvites((current) => current.filter(({ id }) => id !== pending.id));
          if (caught instanceof ApiRequestError && caught.paymentUrl !== null) {
            setRefusal({
              message: caught.message,
              paymentUrl: caught.paymentUrl,
              // The buyer's own seat is one of these; show the total they need.
              seatsNeeded: seatsUsed + 1,
            });
            return;
          }
          setError(caught.message);
        }).finally(() => setCreating(false));
      }}>
        <label className="cfg-field">
          <span>Email (optional)</span>
          <input disabled={loading || creating} type="email" placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
        </label>
        <label className="cfg-field cfg-field--compact">
          <span>Role</span>
          <select disabled={loading || creating} value={role} onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></select>
        </label>
        <button className="webapp-action webapp-action--primary" type="submit" disabled={loading || creating}>{creating ? 'Creating…' : 'Create invite'}</button>
      </form>
      {refusal && (
        <div className="settings-paywall" role="alert">
          <strong>{seatLimit === null ? refusal.message : `Your plan covers ${seatLimit} ${seatLimit === 1 ? 'seat' : 'seats'}.`}</strong>
          <p>
            {seatsUsed === 1
              ? `Adding one more person needs ${refusal.seatsNeeded} seats. Your own seat is one of them.`
              : `This organization has ${seatsUsed} people. Adding one more needs ${refusal.seatsNeeded} seats.`}
          </p>
          <div className="settings-paywall-row">
            <a className="webapp-action webapp-action--primary" href={refusal.paymentUrl}>
              Buy {refusal.seatsNeeded} seats
            </a>
            <span className="settings-paywall-price">
              {currency(1, 100)} per seat per month · {currency(refusal.seatsNeeded, 100)} per month
            </span>
          </div>
        </div>
      )}
      {oneTimeLink && (
        <div className="settings-onetime" role="status">
          <strong>Copy this link now — it is shown once.</strong>
          <div className="settings-onetime-row">
            <input readOnly value={oneTimeLink} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
            <button className="webapp-action" type="button" onClick={() => void navigator.clipboard.writeText(oneTimeLink)}>Copy</button>
          </div>
        </div>
      )}
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="settings-people">
        {pendingInvites.map((invite) => (
          <div className="settings-person" key={invite.id}>
            <span className="settings-person-copy">
              <strong>{invite.email ?? 'Anyone with the link'}</strong>
              <span>{invite.role} · creating</span>
            </span>
          </div>
        ))}
        {invites.map((invite) => (
          <div className="settings-person" key={invite.id}>
            <span className="settings-person-copy">
              <strong>{invite.email ?? 'Anyone with the link'}</strong>
              <span>{invite.role} · {invite.state}</span>
            </span>
            {invite.state === 'ready' && (
              <span className="settings-person-actions">
                <button className="webapp-action" type="button" onClick={() => revoke(invite)}>Revoke</button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
