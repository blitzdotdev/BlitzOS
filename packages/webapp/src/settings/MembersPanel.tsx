import type { OrgUsageResponse } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  type ControlPlaneClient,
  type InviteView,
  type MemberView,
} from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import { MemberAvatar } from '../MemberAvatar';
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** What an invite row says instead of a timestamp: the question about a
 * pending invite is how long it has left, never when it was minted. */
function expiry(invite: InviteView, now: number): string {
  const left = invite.expiresAt - now;
  if (left <= 0) return 'expired';
  const days = Math.ceil(left / DAY_MS);
  return `expires in ${String(days)} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Members: the people of the organization, and the invites that are on their
 * way to becoming members.
 *
 * ONE PAGE, BECAUSE IT WAS ALWAYS ONE QUESTION. Members and Invites were two
 * sections of the settings nav, and both of them minted invites — the members
 * page had its own form because adding a person is what a reader goes to a
 * members page to do, and the invites page had the same form again beside the
 * seat meter. Two forms against one route is one form too many; the seat count
 * that governs both of them sat on only one of the pages.
 *
 * THE INVITE ROW IS THE LAST ROW OF THE MEMBERS LIST. The list is the surface
 * and adding to it is a detail of the list, so `+ Invite someone` reveals the
 * fields in place — the pattern `AccessListEditor` uses, for the reason it uses
 * it: the row being added is visibly the row that will be there.
 *
 * PENDING INVITES ARE A SECTION, NOT A PAGE, and they are only drawn when the
 * organization has some. An admin with nothing pending reads a members list,
 * which is the truth about who is in the organization.
 *
 * A NON-ADMIN SEES THE LIST AND THE DANGER ZONE. Every write here is refused
 * by the server for a member, so nothing offers one: no invite row, no pending
 * invites, no seat action.
 */
export function MembersPanel({
  client,
  admin,
  orgName,
  onLeft,
}: {
  client: ControlPlaneClient;
  admin: boolean;
  orgName: string;
  /** Starts the shell-level leave once this panel has confirmed it. The call,
   * its loading state and its rollback are the shell's (#205); the panel only
   * asks the question. */
  onLeft: () => void;
}) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [usage, setUsage] = useState<OrgUsageResponse | null>(null);
  const [inviting, setInviting] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  // Rows being written. A row that is answering cannot be asked again (#205).
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(() => new Set());
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SeatRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers((await client.listMembers()).members);
      setError(null);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Could not load members.'));
    }
    // Both of these are admin surfaces, and a member's own call would be
    // refused; the list above is what a member came for.
    if (!admin) return;
    try {
      setInvites((await client.listInvites()).invites);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Could not load invites.'));
    }
    // A deployment with no billing service has no seat limit to show, and this
    // route still answers. Its failure is not the people list's failure.
    try {
      setUsage(await client.orgUsage());
    } catch {
      setUsage(null);
    }
  }, [admin, client]);
  useEffect(() => { void load(); }, [load]);

  // The server refuses a last-member leave with a 409. Deriving the same
  // condition from the list that is already loaded lets the button say why
  // before it is pressed; the 409 stays the authority.
  const soleMember = members.filter((member) => member.status === 'active').length <= 1;
  const seatLimit = usage?.seatLimit ?? null;
  const seatsUsed = usage?.seatsUsed ?? 0;
  const full = seatLimit !== null && seatsUsed >= seatLimit;
  const pending = invites.filter((invite) => invite.state === 'ready');
  const now = Date.now();

  // Follows the hop the control plane signs. Minted on the click rather than
  // on load: the token lives fifteen minutes, and a settings tab left open
  // outlives that. One destination — the billing service decides whether this
  // organization is buying seats or changing the ones it has.
  const openBilling = () => {
    void client.billing()
      .then((billing) => { window.location.href = billing.url; })
      .catch((caught: Error) => setError(caught.message));
  };

  /** A revoked invite leaves the list at once and returns to its own place if
   * the server refuses — a redeemed invite is the refusal that happens (#205). */
  const revokeInvite = (invite: InviteView) => {
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
      setError(caughtErrorMessage(cause, 'Could not revoke invite.'));
    });
  };

  /** A row answers at once and rolls back if the server refuses (#205). The
   * optimistic value is what the person just chose; the server's own answer
   * replaces it, so a rename or a role the server normalised still wins. */
  const mutateMember = (
    member: MemberView,
    input: { role?: 'admin' | 'member'; status?: 'disabled' | 'active' },
  ) => {
    const optimistic = { ...member, ...input };
    setMembers((current) => current.map((row) => (row.id === member.id ? optimistic : row)));
    setPendingMemberIds((current) => new Set(current).add(member.id));
    setError(null);
    void client.updateMember(member.id, input)
      .then(({ member: canonical }) => {
        setMembers((current) => current.map((row) => (row.id === member.id ? canonical : row)));
      })
      .catch((cause: unknown) => {
        setMembers((current) => current.map((row) => (row.id === member.id ? member : row)));
        setError(caughtErrorMessage(cause, 'Could not update member.'));
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
      <PanelHeader
        eyebrow="Organization"
        title="Members"
        action={seatLimit !== null ? (
          <button
            className={`webapp-action${full ? ' webapp-action--primary' : ''}`}
            type="button"
            onClick={openBilling}
          >Manage seats</button>
        ) : undefined}
      />
      {seatLimit !== null && (
        <div className="settings-seats">
          <span><b>{seatsUsed}</b> of <b>{seatLimit}</b> {seatLimit === 1 ? 'seat' : 'seats'} used</span>
          <span className="settings-seats-bar">
            <span
              className={`settings-seats-fill${seatsUsed > seatLimit ? ' settings-seats-fill--over' : ''}`}
              style={{ width: `${Math.min(100, Math.round((seatsUsed / seatLimit) * 100))}%` }}
            />
          </span>
        </div>
      )}
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}

      <section className="cfg-section" aria-label="Members">
        <div className="settings-section-heading">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Members · {members.length}</h2>
          </div>
        </div>
        <div className="settings-people">
          {members.map((member) => {
            const pending = pendingMemberIds.has(member.id);
            return (
              <div className={`settings-person${member.status === 'disabled' ? ' settings-person--disabled' : ''}`} key={member.id}>
                <MemberAvatar name={member.name || member.email} avatarUrl={member.avatarUrl} size="lg" />
                <span className="settings-person-copy">
                  <strong>{member.name || member.email}</strong>
                  <span>{member.email}{member.status === 'disabled' ? ' · disabled' : ''}</span>
                </span>
                {admin ? (
                  <span className="settings-person-actions">
                    <select
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      disabled={pending}
                      onChange={(event) => {
                        mutateMember(member, {
                          role: event.currentTarget.value === 'admin' ? 'admin' : 'member',
                        });
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
          {admin && (inviting ? (
            /* NO CANCEL, for `AccessListEditor`'s reason: nothing is recorded
               until Send invite is pressed, so leaving the row open costs
               nothing and a dismiss verb would be the only thing on the card
               that looks like it undoes something. */
            <form className="settings-person-add" onSubmit={(event) => {
              event.preventDefault();
              setCreatingInvite(true);
              setRefusal(null);
              // An empty address is a link anybody may redeem, which is the
              // open-invite the Invites page used to mint.
              void client.createInvite({ email: email.trim() || undefined, role }).then((created) => {
                setOneTimeLink(`${window.location.origin}/invite/${created.code}`);
                // The row the server just handed back, not another list call
                // (#205): the mint's own answer is the newest truth there is.
                setInvites((current) => [
                  created.invite,
                  ...current.filter(({ id }) => id !== created.invite.id),
                ]);
                setEmail('');
                setInviting(false);
              }).catch((caught: Error) => {
                if (caught instanceof ApiRequestError && caught.paymentUrl !== null) {
                  setRefusal({
                    message: caught.message,
                    paymentUrl: caught.paymentUrl,
                    // The buyer's own seat is one of these. Saying the total
                    // out loud is the difference between an offer and an error.
                    seatsNeeded: seatsUsed + 1,
                  });
                  return;
                }
                setError(caught.message);
              }).finally(() => setCreatingInvite(false));
            }}>
              <label className="cfg-field">
                <span>Email</span>
                <input type="email" disabled={creatingInvite} placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
              </label>
              <label className="cfg-field cfg-field--compact">
                <span>Role</span>
                <select value={role} disabled={creatingInvite} onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')}><option value="member">Member</option><option value="admin">Admin</option></select>
              </label>
              <button className="webapp-action webapp-action--primary" type="submit" disabled={creatingInvite}>{creatingInvite ? 'Adding…' : 'Send invite'}</button>
            </form>
          ) : (
            <button
              className="settings-person-open"
              type="button"
              onClick={() => setInviting(true)}
            >+ Invite someone</button>
          ))}
        </div>
        {refusal !== null && (
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
        {oneTimeLink !== null && (
          <div className="settings-onetime" role="status">
            <strong>Copy this link now — it is shown once.</strong>
            <div className="settings-onetime-row">
              <input readOnly value={oneTimeLink} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
              <button className="webapp-action" type="button" onClick={() => void navigator.clipboard.writeText(oneTimeLink)}>Copy</button>
            </div>
          </div>
        )}
      </section>

      {admin && pending.length > 0 && (
        <section className="cfg-section" aria-label="Pending invites">
          <div className="settings-section-heading">
            <div className="cfg-section-head">
              <h2 className="cfg-title">Pending invites · {pending.length}</h2>
            </div>
          </div>
          <div className="settings-people">
            {pending.map((invite) => (
              <div className="settings-person" key={invite.id}>
                <span className="settings-person-copy">
                  <strong>{invite.email ?? 'Anyone with the link'}</strong>
                  <span>{invite.role} · {expiry(invite, now)}</span>
                </span>
                <span className="settings-person-actions">
                  {/* NO COPY LINK. `InviteView` carries no code — the control
                    * plane hands one out on mint and never again — so a copy
                    * button here would have nothing to copy. The block above
                    * is the one chance, and it says so. */}
                  <button className="webapp-action" type="button" onClick={() => revokeInvite(invite)}>Revoke</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="cfg-section" aria-label="Danger zone">
        <div className="cfg-section-head">
          <h2 className="cfg-title">Danger zone</h2>
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
            disabled={soleMember}
            onClick={() => setConfirmLeave(true)}
          >Leave</button>
        </div>
      </section>
      {confirmLeave && (
        <ConfirmationDialog
          title={`Leave ${orgName}?`}
          description={`You lose access to everything in ${orgName}. Workspaces you own stay with the organization.`}
          confirmLabel="Yes, leave"
          cancelLabel="No"
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            onLeft();
          }}
        />
      )}
    </section>
  );
}
