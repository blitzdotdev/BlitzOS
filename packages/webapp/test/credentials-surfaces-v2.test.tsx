import type { CredentialLeaseView, CredentialRequestView } from '@blitzos/schema';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import type { WorkspaceDrawerSegment } from '../src/storage.js';
import {
  WorkspaceDrawer,
  WorkspaceLeasesPanel,
} from '../src/WorkspaceDrawer.js';
import { render, settle } from './dom.js';

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    googleLoginUrl: () => '/auth/google/start',
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error('unused'); }),
    switchOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    createMember: vi.fn(async () => { throw new Error('unused'); }),
    updateMember: vi.fn(async () => { throw new Error('unused'); }),
    deleteMember: vi.fn(async () => undefined),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error('unused'); }),
    revokeInvite: vi.fn(async () => undefined),
    listWorkspaceGrants: vi.fn(async () => ({ grants: [] })),
    createWorkspaceGrant: vi.fn(async () => { throw new Error('unused'); }),
    revokeWorkspaceGrant: vi.fn(async () => undefined),
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
          files={<div>File tree</div>}
          onWidthChange={() => undefined}
          onSegmentChange={setSegment}
          onResolveRequest={async () => undefined}
        />
      );
    }

    let view = await render(<Harness />);
    const requestsTab = [...view.container.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Requests'))!;
    await act(async () => click(requestsTab));
    expect(requestsTab.getAttribute('aria-selected')).toBe('true');
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('Requests');
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
          segment="requests"
          pendingRequests={requests}
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
