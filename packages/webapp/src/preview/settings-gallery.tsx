import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import '../tokens.css';
import '../webapp-icons.css';
import '../webapp-base.css';
import '../webapp-shell.css';
import '../webapp-workspace.css';
import '../webapp-select.css';
import '../chat-panel.css';
import '../files-drive.css';
import '../drive-shell.css';
import '../strip-rail.css';
import '../files.css';
import '../confirmation-dialog.css';
import '../workspace-details-dialog.css';
import '../loading-skeleton.css';
import '../create-workspace-dialog.css';
import '../settings.css';
import '../org-credentials.css';
import '../invite-redeem.css';
import './preview.css';
import type { CredentialRequestView, FolderView, GrantProposalView } from '@blitzos/schema';
import { AgentRulesPicker } from '../AgentRulesPicker';
import type { TenantMe } from '../api-adapter';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { CreateWorkspaceDialog } from '../CreateWorkspaceDialog';
import { ShareFolderDialog } from '../files/ShareFolderDialog';
import { AccessApprovalDialog } from '../AccessApprovalDialog';
import { MyMachineDialog } from '../MyMachineDialog';
import type { SettingsSection } from '../sessions-page-state';
import { SettingsHeader, SettingsPage } from '../SettingsPage';
import { chooseTheme, initTheme } from '../theme';
import { WorkspaceConnectionsPanel } from '../WorkspaceConnectionsPanel';
import { WorkspaceDetailsDialog, type WorkspaceDetailsTab } from '../WorkspaceDetailsDialog';
import {
  adminViewer,
  accessProposals,
  listMachineTypesFixture,
  memberViewer,
  previewFolder,
  previewWorkspace,
  wantedRequestsSeed,
} from './fixtures';
import { previewClient } from './preview-client';

/* The settings design gallery: every settings-redesign surface, mounted for
 * real with fixture data, so a reviewer can walk the components and flip the
 * palette without a control plane behind them. Served by the Vite dev server
 * at /settings-preview.html. */

function noop(): void {
  // The gallery has nowhere to navigate to.
}

function signOutSlowly(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
}

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section className="pv-section">
      <h2>{title}</h2>
      <p className="pv-caption">{caption}</p>
      {children}
    </section>
  );
}

function GalleryHeader() {
  return (
    <header className="pv-header">
      <h1>Settings — design-kit preview</h1>
      <div className="pv-theme" role="group" aria-label="Theme">
        <button className="webapp-action" type="button" onClick={() => chooseTheme('dark')}>Dark</button>
        <button className="webapp-action" type="button" onClick={() => chooseTheme('light')}>Light</button>
        <button className="webapp-action" type="button" onClick={() => chooseTheme('system')}>System</button>
      </div>
    </header>
  );
}

/** One full settings page in a bounded frame, left-rail navigation live. */
function SettingsFrame({ viewer }: { viewer: TenantMe }) {
  const [section, setSection] = useState<SettingsSection>('profile');
  return (
    <div className="pv-frame">
      <div className="settings-shell">
        <SettingsHeader workspaceLabel="brave-otter" onBack={noop} />
        <SettingsPage
          client={previewClient}
          viewer={viewer}
          section={section}
          onNavigate={setSection}
          onSignOut={signOutSlowly}
          onLeftOrg={noop}
          onSwitchOrg={noop}
          onCreateOrg={noop}
        />
      </div>
    </div>
  );
}

/** The grant-approval dialog, opened on its own. It hung off the Requests
 * panel's Review until that panel went; the shell raises it from an agent's
 * ask now, and the gallery raises it from a button. */
function AccessApprovalSection() {
  const [reviewing, setReviewing] = useState<GrantProposalView | null>(null);
  const pending = accessProposals.filter(({ state }) => state === 'pending');
  return (
    <Section
      title="Access approval dialog"
      caption="One pending grant proposal, as a member is asked to decide it."
    >
      <div className="pv-row">
        <button
          className="webapp-action"
          type="button"
          disabled={pending.length === 0}
          onClick={() => setReviewing(pending[0] ?? null)}
        >Review a proposal…</button>
      </div>
      {reviewing !== null && (
        <AccessApprovalDialog
          client={previewClient}
          proposal={reviewing}
          viewer={{ membershipId: adminViewer.membership.id, orgName: adminViewer.org.name }}
          workspaces={[{ id: previewWorkspace.id, name: previewWorkspace.title, members: previewWorkspace.members }]}
          onClose={() => setReviewing(null)}
          onResolved={() => setReviewing(null)}
        />
      )}
    </Section>
  );
}

function WorkspaceDetailsSection() {
  const [tab, setTab] = useState<WorkspaceDetailsTab | null>(null);
  const close = () => setTab(null);
  return (
    <Section
      title="Workspace details dialog"
      caption="The three-tab workspace admin surface, opened on each tab. Three members: running, provisioning, and a viewer with no machine."
    >
      <div className="pv-row">
        <button className="webapp-action" type="button" onClick={() => setTab('members')}>Members tab</button>
        <button className="webapp-action" type="button" onClick={() => setTab('credentials')}>Credentials tab</button>
        <button className="webapp-action" type="button" onClick={() => setTab('settings')}>Settings tab</button>
      </div>
      {tab !== null && (
        <WorkspaceDetailsDialog
          client={previewClient}
          workspace={previewWorkspace}
          listMachineTypes={listMachineTypesFixture}
          refreshWorkspaces={() => undefined}
          initialTab={tab}
          viewerMembershipId="m-june"
          orgName="Acme Robotics"
          orgWorkspaces={[{ id: previewWorkspace.id, name: previewWorkspace.title }]}
          onClose={close}
          onClone={close}
          onDelete={close}
        />
      )}
    </Section>
  );
}

function MyMachineSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="My machine dialog"
      caption="The member's own machine, first person: details list, type change, lifecycle verbs."
    >
      <div className="pv-row">
        <button className="webapp-action" type="button" onClick={() => setOpen(true)}>Open my machine</button>
      </div>
      {open && (
        <MyMachineDialog
          client={previewClient}
          workspace={previewWorkspace}
          membershipId="m-june"
          listMachineTypes={listMachineTypesFixture}
          onClose={() => setOpen(false)}
        />
      )}
    </Section>
  );
}

function CreateWorkspaceSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Create workspace dialog"
      caption="The full-screen create form: machine catalog, members draft, credentials, repos, agent rules."
    >
      <div className="pv-row">
        <button className="webapp-action" type="button" onClick={() => setOpen(true)}>Open create workspace</button>
      </div>
      {open && (
        <CreateWorkspaceDialog
          busy={false}
          error={null}
          orgName="Acme Robotics"
          orgId="org-acme"
          admin
          saveComputeCredential={previewClient.putComputeCredential}
          client={previewClient}
          listMachineTypes={listMachineTypesFixture}
          viewerName="June Park"
          onCancel={() => setOpen(false)}
          onSubmit={() => setOpen(false)}
        />
      )}
    </Section>
  );
}

function ConfirmationSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Confirmation dialog"
      caption="The shared destructive-action confirmation, focus on the safe choice."
    >
      <div className="pv-row">
        <button className="webapp-action webapp-action--danger" type="button" onClick={() => setOpen(true)}>
          Revoke a connection…
        </button>
      </div>
      {open && (
        <ConfirmationDialog
          title="Revoke this connection?"
          description="Revoke github? Every workspace holding a lease from it loses access immediately. Pasted keys must be pasted again to reconnect."
          confirmLabel="Revoke connection"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      )}
    </Section>
  );
}

function AgentRulesSection() {
  const [ruleId, setRuleId] = useState<string | null>(null);
  return (
    <Section
      title="Agent rules picker"
      caption="Inline picker with the built-in doc and one org rule; Edit opens the real editor modal."
    >
      <div className="pv-well">
        <AgentRulesPicker client={previewClient} value={ruleId} onChange={setRuleId} />
      </div>
    </Section>
  );
}

function DrawerConnectionsSection() {
  const [requests, setRequests] = useState<CredentialRequestView[]>(wantedRequestsSeed);
  const resolveRequest = async (request: CredentialRequestView) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    setRequests((current) => current.filter(({ id }) => id !== request.id));
  };
  return (
    <Section
      title="Workspace drawer — connections panel"
      caption="One connected provider (GitHub), one wanted request (Linear), one available provider (Notion), at drawer width."
    >
      <div className="pv-stage">
        <WorkspaceConnectionsPanel
          client={previewClient}
          workspaceId="ws-preview"
          pendingRequests={requests}
          workspaceConnections={['github']}
          onResolveRequest={resolveRequest}
        />
      </div>
    </Section>
  );
}

function ShareFolderSection() {
  const [folder, setFolder] = useState<FolderView | null>(null);
  const [snack, setSnack] = useState<ReactNode>(null);
  return (
    <Section
      title="Share folder dialog"
      caption="Drive sharing: owner view of a folder with org-wide access and two grants."
    >
      <div className="pv-row">
        <button className="webapp-action" type="button" onClick={() => setFolder(previewFolder())}>
          Share “Design reviews”…
        </button>
      </div>
      {snack !== null && <p className="pv-note" role="status">{snack}</p>}
      {folder !== null && (
        <ShareFolderDialog
          client={previewClient}
          folder={folder}
          viewerEmail="june@acme.dev"
          orgName="Acme Robotics"
          onClose={() => setFolder(null)}
          onChanged={async () => setFolder(previewFolder())}
          onSnack={setSnack}
        />
      )}
    </Section>
  );
}

function Gallery() {
  return (
    <div className="pv-page">
      <GalleryHeader />
      <Section
        title="Settings page (admin)"
        caption="All five panels behind a live left rail: Profile, People, Connections, Credentials, Compute."
      >
        <SettingsFrame viewer={adminViewer} />
      </Section>
      <Section
        title="Settings page (member view)"
        caption="The same page as a non-admin: Compute disappears, and People keeps the list and the danger zone with no invite row."
      >
        <SettingsFrame viewer={memberViewer} />
      </Section>
      <WorkspaceDetailsSection />
      <MyMachineSection />
      <CreateWorkspaceSection />
      <ConfirmationSection />
      <AccessApprovalSection />
      <AgentRulesSection />
      <DrawerConnectionsSection />
      <ShareFolderSection />
    </div>
  );
}

initTheme();

const root = document.getElementById('root');
if (root === null) throw new Error('Missing root element');

createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
