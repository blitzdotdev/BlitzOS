import { useCallback, useState } from 'react';
import type { TenantMe } from './api-adapter';
import type { ControlPlaneClient } from './api';
import { appliedTheme, chooseTheme, type ThemeChoice } from './theme';
import type { SettingsSection } from './sessions-page-state';
import { ConnectionsPanel } from './settings/ConnectionsPanel';
import { OrgCredentialsPanel } from './settings/OrgCredentialsPanel';
import { RequestsPanel } from './settings/RequestsPanel';
import { MembersPanel } from './settings/MembersPanel';
import { InvitesPanel } from './settings/InvitesPanel';
import { UsagePanel } from './settings/UsagePanel';
import { ComputeCredentialsPanel } from './settings/ComputeCredentialsPanel';

function initial(identity: TenantMe['identity']): string {
  return (identity.name || identity.email || 'B').trim().charAt(0).toUpperCase() || 'B';
}

function PanelHeader({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <header className="settings-panel-header">
      <div>
        <p>Account surface</p>
        <h1>{title}</h1>
        <span>{detail}</span>
      </div>
      {action}
    </header>
  );
}

function ProfilePanel({
  viewer,
  onSignOut,
}: {
  viewer: TenantMe;
  onSignOut: () => Promise<void>;
}) {
  const displayName = viewer.identity.name || viewer.identity.email;
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const signOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      await onSignOut();
    } catch {
      setSigningOut(false);
      setSignOutFailed(true);
    }
  }, [onSignOut]);
  return (
    <section className="settings-panel" role="tabpanel" aria-label="Profile">
      <PanelHeader
        title="Profile"
        detail="Identity from the BlitzOS control plane."
        action={(
          <button
            className="webapp-action"
            type="button"
            disabled={signingOut}
            onClick={() => void signOut()}
          >{signingOut ? 'Signing out…' : 'Sign out'}</button>
        )}
      />
      {signOutFailed && (
        <p className="webapp-form-message" role="alert">Could not sign out. Try again.</p>
      )}
      <div className="settings-identity">
        <svg className="settings-identity-avatar" viewBox="0 0 46 46" aria-hidden="true">
          <circle cx="23" cy="23" r="23" />
          <text x="23" y="23" dy="0.36em" textAnchor="middle">{initial(viewer.identity)}</text>
        </svg>
        <div>
          <strong>{displayName}</strong>
          <span>{viewer.identity.email}</span>
        </div>
      </div>
      <div className="cfg-section">
        <dl className="cfg-meta">
          <div><dt>Display name</dt><dd>{displayName}</dd></div>
          <div><dt>Identity</dt><dd>{viewer.identity.email}</dd></div>
          <div><dt>Workspace scope</dt><dd>{viewer.org.name || viewer.org.slug}</dd></div>
          {/* `OrgRole` is a wire term shown to a person; the e-mail above is
            * not, which is why the list itself re-cases nothing. */}
          <div><dt>Role</dt><dd className="cfg-meta-term">{viewer.membership.role}</dd></div>
        </dl>
      </div>
      <AppearanceControl />
    </section>
  );
}

/* Device-local preference (theme.ts): applies immediately, never synced. */
function AppearanceControl() {
  const [theme, setTheme] = useState<ThemeChoice>(() => appliedTheme());
  const choices: Array<{ id: ThemeChoice; label: string }> = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  return (
    <div className="cfg-section">
      <div className="cfg-section-head">
        <h2 className="cfg-title">Appearance</h2>
      </div>
      <div className="settings-appearance-options" role="radiogroup" aria-label="Theme">
        {choices.map((choice) => (
          <button
            className={choice.id === theme
              ? 'settings-appearance-option settings-appearance-option--active'
              : 'settings-appearance-option'}
            type="button"
            role="radio"
            aria-checked={choice.id === theme}
            key={choice.id}
            onClick={() => setTheme(chooseTheme(choice.id))}
          >{choice.label}</button>
        ))}
      </div>
      <span className="cfg-help">Applies to this device only.</span>
    </div>
  );
}

export function SettingsHeader({
  workspaceLabel,
  onBack,
}: {
  workspaceLabel?: string;
  onBack: () => void;
}) {
  return (
    <header className="settings-header">
      <button
        className="settings-back"
        type="button"
        aria-label={`Back to ${workspaceLabel || 'WebApp'}`}
        onClick={onBack}
      >
        <span className="codicon codicon-arrow-left" aria-hidden="true" />
        <span className="settings-back-label">{workspaceLabel || 'WebApp'}</span>
        <span className="settings-back-mobile-label">Back</span>
      </button>
      <strong>Settings</strong>
    </header>
  );
}

export function SettingsPage({
  client,
  viewer,
  section,
  onNavigate,
  onOpenWorkspace,
  onReviewProposal,
  onSignOut,
  onLeftOrg,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  /** A request row's Connect opens the workspace that wants the connection:
   * connecting happens there, not in settings, since the flow inversion. */
  onOpenWorkspace: (workspaceId: string) => void;
  /** Reopens the grant-approval dialog on a pending proposal the person
   * closed without deciding (plans/ORG-CREDENTIALS.md §7a). */
  onReviewProposal?: (proposalId: string) => void;
  onSignOut: () => Promise<void>;
  onLeftOrg: () => void;
}) {
  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'members', label: 'Members' },
    ...(viewer.membership.role === 'admin' ? [{ id: 'invites' as const, label: 'Invites' }] : []),
    { id: 'connections', label: 'Connections' },
    // Org credentials (plans/ORG-CREDENTIALS.md §9): any active member may
    // store one, so the tab is not admin-gated.
    { id: 'credentials', label: 'Credentials' },
    ...(viewer.membership.role === 'admin' ? [{ id: 'compute' as const, label: 'Compute' }] : []),
    { id: 'requests', label: 'Requests' },
    // The usage-capture routes are admin-only server-side; the tab matches.
    ...(viewer.membership.role === 'admin' ? [{ id: 'usage' as const, label: 'Usage' }] : []),
  ];
  const navigation = sections.map((candidate) => (
    <button
      className={candidate.id === section
        ? 'settings-nav-button settings-nav-button--active'
        : 'settings-nav-button'}
      type="button"
      role="tab"
      aria-selected={candidate.id === section}
      key={candidate.id}
      onClick={() => onNavigate(candidate.id)}
    >{candidate.label}</button>
  ));
  return (
    <section className="settings-page">
      <nav className="settings-segments" aria-label="Settings sections" role="tablist">
        {navigation}
      </nav>
      <aside className="settings-side">
        <span>Settings</span>
        <nav className="settings-side-nav" aria-label="Settings sections" role="tablist">
          {navigation}
        </nav>
        {/* The one place the product asks for a human. It lived in the strip's
          * account menu until that menu went; settings is where a member looks
          * for it next. */}
        <a
          className="settings-nav-link"
          href="https://discord.gg/VsywH6GNhB"
          target="_blank"
          rel="noreferrer"
        >Ask us on Discord</a>
      </aside>
      <div className="settings-content">
        {section === 'profile' && <ProfilePanel viewer={viewer} onSignOut={onSignOut} />}
        {section === 'members' && (
          <MembersPanel
            client={client}
            admin={viewer.membership.role === 'admin'}
            orgName={viewer.org.name || viewer.org.slug}
            onLeft={onLeftOrg}
          />
        )}
        {section === 'invites' && viewer.membership.role === 'admin' && <InvitesPanel client={client} />}
        {section === 'connections' && <ConnectionsPanel client={client} />}
        {section === 'credentials' && (
          <OrgCredentialsPanel client={client} viewer={viewer} />
        )}
        {section === 'compute' && viewer.membership.role === 'admin' && (
          <ComputeCredentialsPanel client={client} orgId={viewer.org.id} />
        )}
        {section === 'requests' && (
          <RequestsPanel
            client={client}
            onOpenWorkspace={onOpenWorkspace}
            onReviewProposal={onReviewProposal}
          />
        )}
        {section === 'usage' && viewer.membership.role === 'admin' && (
          <UsagePanel client={client} />
        )}
      </div>
    </section>
  );
}
