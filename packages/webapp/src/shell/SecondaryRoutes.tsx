import type { GrantProposalView } from '@blitzos/schema';
import type { ReactNode } from 'react';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import { SettingsHeader, SettingsPage } from '../SettingsPage';
import {
  type AppRoute,
  type SettingsSection,
} from '../sessions-page-state';

/** Pages the shell draws beside the rail instead of a workspace. Settings is
 * one of them even though it hides the rail: it is still not the webApp. */
/* The template and recipe pages are gone from this switch: their routes no
 * longer parse and their control-plane routes are unmounted. The screens
 * themselves stay in the tree, unreachable — see `sessions-page-state.ts`. */
export type SecondaryRoutePage = 'home' | 'settings';

const SECONDARY_ROUTE_PAGES = new Set<string>(['home', 'settings']);

export function isSecondaryRoute(
  route: AppRoute,
): route is Extract<AppRoute, { page: SecondaryRoutePage }> {
  return SECONDARY_ROUTE_PAGES.has(route.page);
}

export type SecondaryRoutesProps = {
  route: Extract<AppRoute, { page: SecondaryRoutePage }>;
  client: ControlPlaneClient;
  viewer: TenantMe | null;
  loaded: boolean;
  /** The shell's own navigation columns, drawn on every page. */
  rail: ReactNode;
  pendingGrantProposals: readonly GrantProposalView[];
  dialogs: ReactNode;
  updateNotice: ReactNode;
  error: string | null;
  onDismissError: () => void;
  onNavigateToSettings: (section: SettingsSection) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  /** Reopens a pending grant proposal the person closed without deciding. */
  onReviewProposal: (proposalId: string) => void;
  onLeaveSettings: () => void;
  onSignOut: () => Promise<void>;
  onLeftOrg: () => void;
  /** Org switching lives on Settings → Profile since the strip lost its org
   * mark; the switch rebinds the session, so the caller reloads. */
  onSwitchOrg: (orgId: string) => void;
  onCreateOrg: () => void;
  activeWorkspaceTitle: string | undefined;
};

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="webapp-notice" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/** The route switch for every page that is not a workspace. Each branch is the
 * same shell: rail, content, notices, dialogs. */
export function SecondaryRoutes({
  route,
  client,
  viewer,
  loaded,
  rail,
  pendingGrantProposals,
  dialogs,
  updateNotice,
  error,
  onDismissError,
  onNavigateToSettings,
  onOpenWorkspace,
  onReviewProposal,
  onLeaveSettings,
  onSignOut,
  onLeftOrg,
  onSwitchOrg,
  onCreateOrg,
  activeWorkspaceTitle,
}: SecondaryRoutesProps) {
  const notice = error === null
    ? null
    : <Notice message={error} onDismiss={onDismissError} />;
  if (route.page === 'settings') {
    return (
      <main className="settings-shell" aria-busy={!loaded}>
        <SettingsHeader workspaceLabel={activeWorkspaceTitle} onBack={onLeaveSettings} />
        {loaded && viewer ? (
          <SettingsPage
            pendingGrantProposals={pendingGrantProposals}
            client={client}
            viewer={viewer}
            section={route.settingsSection}
            onNavigate={onNavigateToSettings}
            onOpenWorkspace={onOpenWorkspace}
            onReviewProposal={onReviewProposal}
            onSignOut={onSignOut}
            onLeftOrg={onLeftOrg}
            onSwitchOrg={onSwitchOrg}
            onCreateOrg={onCreateOrg}
          />
        ) : (
          <div className="settings-page-state settings-page-state--loading" role="status">
            Loading settings…
          </div>
        )}
        {notice}
        {updateNotice}
        {/* The create-org dialog opens from Profile now, so the shared dialog
          * layer must exist on this branch too, not only beside the rail. */}
        {dialogs}
      </main>
    );
  }

  return (
    <main className="app-shell" aria-busy={!loaded}>
      {rail}
      <div className="app-content">
        <div className="app-empty" role="status">
          {loaded && viewer ? 'Create a workspace to get started.' : 'Loading…'}
        </div>
      </div>
      {notice}
      {updateNotice}
      {dialogs}
    </main>
  );
}
