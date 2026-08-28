import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '../api';
import type {
  AdminClient,
  AdminOrgView,
  CreateTrialOrgResponse,
} from '../admin-api';

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The operator's one-line read of an organization's standing. An expired
 * trial clock with platformCompute still on reads as live on purpose: the
 * expiry sweep, not this view, is what ends a trial. */
export function planState(
  org: Pick<AdminOrgView, 'trialExpiresAt' | 'platformCompute' | 'seatLimit'>,
  now: number,
): string {
  if (org.trialExpiresAt !== null) {
    return !org.platformCompute && org.trialExpiresAt <= now
      ? `Trial ended ${shortDate(org.trialExpiresAt)}`
      : `Trial until ${shortDate(org.trialExpiresAt)}`;
  }
  if (org.seatLimit === null) return 'Free';
  return `Paid · ${org.seatLimit} ${org.seatLimit === 1 ? 'seat' : 'seats'}`;
}

/** Server-side defaults, mirrored so the form shows what an empty submit
 * would do (control-plane core/admin.ts). */
const TRIAL_DAYS_DEFAULT = 14;
const TRIAL_SEAT_LIMIT_DEFAULT = 5;
const TRIAL_VM_LIMIT_DEFAULT = 2;

function positiveOr(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function TrialForm({ client, onCreated }: { client: AdminClient; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [trialDays, setTrialDays] = useState(String(TRIAL_DAYS_DEFAULT));
  const [seatLimit, setSeatLimit] = useState(String(TRIAL_SEAT_LIMIT_DEFAULT));
  const [vmLimit, setVmLimit] = useState(String(TRIAL_VM_LIMIT_DEFAULT));
  const [minted, setMinted] = useState<CreateTrialOrgResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <form className="settings-form" onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() === '') return;
        setError(null);
        void client.createTrialOrg({
          name: name.trim(),
          email: email.trim() === '' ? undefined : email.trim(),
          trialDays: positiveOr(trialDays, TRIAL_DAYS_DEFAULT),
          seatLimit: positiveOr(seatLimit, TRIAL_SEAT_LIMIT_DEFAULT),
          vmLimit: positiveOr(vmLimit, TRIAL_VM_LIMIT_DEFAULT),
        }).then((created) => {
          setMinted(created);
          setName('');
          setEmail('');
          onCreated();
        }).catch((caught: Error) => setError(caught.message));
      }}>
        <label className="settings-field">
          <span>Organization name</span>
          <input required value={name} placeholder="Acme Prospect" onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        <label className="settings-field">
          <span>Pin invite to email (optional)</span>
          <input type="email" placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
        </label>
        <label className="settings-field settings-field--compact">
          <span>Trial days</span>
          <input type="number" min={1} value={trialDays} onChange={(event) => setTrialDays(event.currentTarget.value)} />
        </label>
        <label className="settings-field settings-field--compact">
          <span>Seat limit</span>
          <input type="number" min={1} value={seatLimit} onChange={(event) => setSeatLimit(event.currentTarget.value)} />
        </label>
        <label className="settings-field settings-field--compact">
          <span>VM limit</span>
          <input type="number" min={1} value={vmLimit} onChange={(event) => setVmLimit(event.currentTarget.value)} />
        </label>
        <button className="webapp-action webapp-action--primary" type="submit">Start trial</button>
      </form>
      {minted && (() => {
        // The code is answered exactly once; this block is its only home.
        const link = `${window.location.origin}/invite/${minted.code}`;
        return (
          <div className="settings-onetime" role="status">
            <strong>Copy this link now — it is shown once.</strong>
            <div className="settings-onetime-row">
              <input readOnly value={link} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
              <button className="webapp-action" type="button" onClick={() => void navigator.clipboard.writeText(link)}>Copy</button>
            </div>
            <span>
              {minted.org.name} · trial ends {shortDate(minted.trialExpiresAt)} · link expires after {minted.ttlDays} days.
            </span>
          </div>
        );
      })()}
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
    </>
  );
}

function OrgCard({ org, now }: { org: AdminOrgView; now: number }) {
  const seatsUsed = org.members.filter((member) => member.status === 'active').length;
  // Every phase but destroyed occupies a VM slot; the route already omits
  // destroyed rows, so this states the rule rather than changing the count.
  const vmsUsed = org.workspaces.filter((workspace) => workspace.phase !== 'destroyed').length;
  return (
    <article className="settings-admin-org">
      <header className="settings-admin-org-head">
        <h2>{org.name}</h2>
        <span className="settings-admin-slug">/{org.slug}</span>
        <span className="settings-admin-badge">{planState(org, now)}</span>
        <span className="settings-admin-badge">{org.platformCompute ? 'platform cloud' : 'BYOK'}</span>
      </header>
      <p className="settings-admin-meta">
        Created {shortDate(org.createdAt)}
        {org.createdBy !== null && <> by {org.createdBy}</>}
        {' · '}
        {org.seatLimit !== null
          ? `${seatsUsed} / ${org.seatLimit} seats`
          : `${seatsUsed} ${seatsUsed === 1 ? 'seat' : 'seats'}`}
        {' · '}{vmsUsed} / {org.vmLimit} VMs
      </p>
      {org.members.length > 0 && (
        <div className="settings-admin-group">
          <span className="settings-admin-group-label">Members</span>
          {org.members.map((member) => (
            <div className="settings-admin-row" key={member.email}>
              <strong>{member.email}</strong>
              <span>{member.name}</span>
              <span className="settings-admin-dim">{member.role} · {member.status}</span>
            </div>
          ))}
        </div>
      )}
      {org.invites.length > 0 && (
        <div className="settings-admin-group">
          <span className="settings-admin-group-label">Invites</span>
          {org.invites.map((invite) => (
            <div className="settings-admin-row" key={invite.id}>
              <strong>{invite.email ?? 'Anyone with the link'}</strong>
              <span className="settings-admin-dim">
                {invite.role} · {invite.state} · expires {shortDate(invite.expiresAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      {org.workspaces.length > 0 && (
        <div className="settings-admin-group">
          <span className="settings-admin-group-label">Workspaces</span>
          {org.workspaces.map((workspace) => (
            <div className="settings-admin-row" key={workspace.id}>
              <strong>{workspace.name ?? workspace.id}</strong>
              <span>{workspace.phase}</span>
              <span>{workspace.machineTypeId}</span>
              <span className="settings-admin-dim">
                {workspace.credentialSource === 'deployment' ? 'platform cloud' : 'org key'}
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function AdminPage({ client }: { client: AdminClient }) {
  const [orgs, setOrgs] = useState<AdminOrgView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setOrgs((await client.adminOrgs()).orgs);
      setError(null);
      setRefused(null);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 403) {
        setRefused(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'Could not load organizations.');
      }
    }
    setLoaded(true);
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  if (refused !== null) {
    return (
      <section className="settings-page settings-page--admin">
        <div className="settings-content">
          <section className="settings-panel" role="alert" aria-label="Admin console">
            <header className="settings-panel-header">
              <div>
                <p>Platform</p>
                <h1>Admin console</h1>
                <span>This console is for platform operators. The control plane said: {refused}.</span>
              </div>
            </header>
          </section>
        </div>
      </section>
    );
  }

  const now = Date.now();
  return (
    <section className="settings-page settings-page--admin">
      <div className="settings-content">
        <section className="settings-panel" aria-label="Start a trial">
          <header className="settings-panel-header">
            <div>
              <p>Platform</p>
              <h1>Start a trial</h1>
              <span>Seeds a sponsored organization on the deployment's cloud key, with an admin invite link.</span>
            </div>
          </header>
          <TrialForm client={client} onCreated={() => { void load(); }} />
        </section>
        <section className="settings-panel" aria-label="Organizations">
          <header className="settings-panel-header">
            <div>
              <p>Platform</p>
              <h1>Organizations</h1>
              <span>{orgs.length === 1 ? '1 organization' : `${orgs.length} organizations`} on this deployment.</span>
            </div>
          </header>
          {error && <p className="webapp-form-message" role="alert">{error}</p>}
          {orgs.map((org) => <OrgCard org={org} now={now} key={org.id} />)}
          {loaded && error === null && orgs.length === 0 && (
            <p className="settings-admin-meta">No organizations yet.</p>
          )}
        </section>
      </div>
    </section>
  );
}
