import type { CredentialLeaseView, CredentialRequestView } from '@blitzos/schema';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import type { WorkspaceDrawerSegment } from '../src/storage.js';
import {
  WorkspaceDrawer,
  WorkspaceLeasesPanel,
} from '../src/WorkspaceDrawer.js';
import { MembersPanel } from '../src/settings/MembersPanel.js';
import { render, settle } from './dom.js';

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    googleLoginUrl: () => '/auth/google/start',
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error('unused'); }),
    switchOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    updateMember: vi.fn(async () => { throw new Error('unused'); }),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error('unused'); }),
    revokeInvite: vi.fn(async () => undefined),
    listWorkspaceGrants: vi.fn(async () => ({ grants: [] })),
    createWorkspaceGrant: vi.fn(async () => { throw new Error('unused'); }),
    revokeWorkspaceGrant: vi.fn(async () => undefined),
    listFolders: vi.fn(async () => ({ folders: [] })),
    createFolder: vi.fn(async () => { throw new Error('unused'); }),
    deleteFolder: vi.fn(async () => undefined),
    createFolderGrant: vi.fn(async () => { throw new Error('unused'); }),
    revokeFolderGrant: vi.fn(async () => undefined),
    listFolderObjects: vi.fn(async () => ({ objects: [], cursor: null, truncated: false })),
    downloadFolderObject: vi.fn(async () => new Blob()),
    uploadFolderObject: vi.fn(async () => undefined),
    listWorkspaceFolders: vi.fn(async () => ({ folders: [] })),
    attachFolder: vi.fn(async () => { throw new Error('unused'); }),
    detachFolder: vi.fn(async () => undefined),
    renameFolder: vi.fn(async () => undefined),
    setFolderOrgRole: vi.fn(async () => undefined),
    listWorkspaceTemplates: vi.fn(async () => ({ templates: [] })),
    createWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
    deleteWorkspaceTemplate: vi.fn(async () => undefined),
    setWorkspaceOrgRole: vi.fn(async () => undefined),
    deleteFolderObject: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => { throw new Error('unused'); }),
    createOrg: vi.fn(async () => { throw new Error('unused'); }),
    getGlobalWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putGlobalWebAppState: vi.fn(async (doc) => ({ doc, updatedAt: 1 })),
    getWorkspaceWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putWorkspaceWebAppState: vi.fn(async (_id, doc) => ({ doc, updatedAt: 1 })),
    poll: vi.fn(async () => ({ workspaces: [] })),
    create: vi.fn(async () => { throw new Error('unused'); }),
    destroy: vi.fn(async () => { throw new Error('unused'); }),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [], failures: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
    listIntegrations: vi.fn(async () => ({ integrations: [] })),
    putIntegration: vi.fn(async () => undefined),
    deleteIntegration: vi.fn(async () => undefined),
    listLeases: vi.fn(async () => ({ leases: [] })),
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    revokeLease: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    ...overrides,
  };
}

function click(button: Element): void {
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('v2 credential surfaces', () => {
  it('mints an email-pinned invite from the members panel and shows its link once', async () => {
    const createInvite = vi.fn(async () => ({
      invite: {
        id: 'invite-one',
        email: 'person@example.com',
        role: 'member' as const,
        state: 'ready' as const,
        createdAt: 1,
        expiresAt: 2,
        redeemedAt: null,
      },
      code: 'one-time-code',
      ttlDays: 7,
    }));
    const view = await render(<MembersPanel client={client({ createInvite })} admin />);
    await settle();
    const input = view.container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setInputValue === undefined) throw new Error('input value setter is unavailable');
    await act(async () => {
      setInputValue.call(input, 'person@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(createInvite).toHaveBeenCalledWith({ email: 'person@example.com', role: 'member' });
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="Member invite link"]')?.value)
      .toBe(`${window.location.origin}/invite/one-time-code`);
    await view.unmount();
  });

  it('switches drawer segments under controlled workspace state', async () => {
    const wire = client();
    function Harness() {
      const [segment, setSegment] = useState<WorkspaceDrawerSegment>('files');
      return (
        <WorkspaceDrawer
          client={wire}
          workspaceId="workspace-one"
          mobile={false}
          open
          width={264}
          segment={segment}
          pendingRequests={[]}
          canManageCredentials
          files={<div>File tree</div>}
          onWidthChange={() => undefined}
          onSegmentChange={setSegment}
          onResolveRequest={async () => undefined}
        />
      );
    }

    let view = await render(<Harness />);
    const credentialsTab = [...view.container.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Credentials'))!;
    await act(async () => click(credentialsTab));
    expect(credentialsTab.getAttribute('aria-selected')).toBe('true');
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('Credentials');
    await view.unmount();
  });

  it('renders leases and revokes only after confirmation', async () => {
    const revokeLease = vi.fn(async () => undefined);
    const lease: CredentialLeaseView = {
      id: 'lease-one',
      workspaceId: 'workspace-one',
      boxId: null,
      integration: 'github',
      userId: null,
      scopes: ['repo:read'],
      mode: 'inject',
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      state: 'active',
    };
    const wire = client({
      revokeLease,
      listLeases: vi.fn(async () => ({
        leases: [lease],
      })),
    });
    const view = await render(
      <WorkspaceLeasesPanel client={wire} workspaceId="workspace-one" visible />,
    );
    await settle();
    expect(view.container.textContent).toContain('github');
    expect(view.container.textContent).toContain('repo:read');

    await act(async () => click([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Revoke')!));
    expect(revokeLease).not.toHaveBeenCalled();
    await act(async () => click([...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Revoke lease')!));
    await settle();
    expect(revokeLease).toHaveBeenCalledWith('lease-one');
    expect(view.container.textContent).toContain('revoked');
    await view.unmount();
  });

  it('shows the pending badge and removes an approved workspace request', async () => {
    const request: CredentialRequestView = {
      id: 'request-one',
      workspace_id: 'workspace-one',
      integration_name: 'github',
      requested_scopes: ['repo:read'],
      created_at: Date.now(),
      requester: { boxId: 'box-one', userId: 'user-one' },
    };
    const approve = vi.fn(async (_id: string) => undefined);
    function Harness() {
      const [requests, setRequests] = useState([request]);
      return (
        <WorkspaceDrawer
          client={client()}
          workspaceId="workspace-one"
          mobile={false}
          open
          width={264}
          segment="credentials"
          pendingRequests={requests}
          canManageCredentials
          files={<div>File tree</div>}
          onWidthChange={() => undefined}
          onSegmentChange={() => undefined}
          onResolveRequest={async (entry, action) => {
            if (action === 'approve') await approve(entry.id);
            setRequests((current) => current.filter(({ id }) => id !== entry.id));
          }}
        />
      );
    }
    const view = await render(<Harness />);
    expect(view.container.querySelector('.workspace-pending-badge')?.textContent).toBe('1');
    await act(async () => click([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Approve')!));
    await settle();
    expect(approve).toHaveBeenCalledWith('request-one');
    expect(view.container.querySelector('.workspace-pending-badge')).toBeNull();
    expect(view.container.textContent).toContain('No pending requests');
    await view.unmount();
  });
});
