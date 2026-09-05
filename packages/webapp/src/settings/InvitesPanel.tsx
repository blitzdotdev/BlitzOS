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

function currency(seats: number, monthlyPerSeat: number): string {
  return `$${(seats * monthlyPerSeat).toLocaleString('en-US')}`;
}

export function InvitesPanel({ client }: { client: ControlPlaneClient }) {
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [usage, setUsage] = useState<OrgUsageResponse | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SeatRefusal | null>(null);
  const load = useCallback(async () => {
    try {
      setInvites((await client.listInvites()).invites);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load invites.');
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

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Invites">
      <PanelHeader eyebrow="Organization" title="Invite links" />
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
        const input = { email: email.trim() || undefined, role };
        setRefusal(null);
        void client.createInvite(input).then((created) => {
          setOneTimeLink(`${window.location.origin}/invite/${created.code}`);
          setEmail('');
          return load();
        }).catch((caught: Error) => {
          if (caught instanceof ApiRequestError && caught.paymentUrl !== null) {
            setRefusal({
              message: caught.message,
              paymentUrl: caught.paymentUrl,
              // The buyer's own seat is one of these. Saying the total out
              // loud is the difference between an offer and an error.
              seatsNeeded: seatsUsed + 1,
            });
            return;
          }
          setError(caught.message);
        });
      }}>
        <label className="cfg-field">
          <span>Email (optional)</span>
          <input type="email" placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
        </label>
        <label className="cfg-field cfg-field--compact">
          <span>Role</span>
          <select value={role} onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></select>
        </label>
        <button className="webapp-action webapp-action--primary" type="submit">Create invite</button>
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
        {invites.map((invite) => (
          <div className="settings-person" key={invite.id}>
            <span className="settings-person-copy">
              <strong>{invite.email ?? 'Anyone with the link'}</strong>
              <span>{invite.role} · {invite.state}</span>
            </span>
            {invite.state === 'ready' && (
              <span className="settings-person-actions">
                <button className="webapp-action" type="button" onClick={() => void client.revokeInvite(invite.id).then(load).catch((caught: Error) => setError(caught.message))}>Revoke</button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
