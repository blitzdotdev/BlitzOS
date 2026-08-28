import { act } from 'react';
import type { ControlPlaneClient } from '../src/api.js';
import { WorkspaceDetailsDialog } from '../src/WorkspaceDetailsDialog.js';
import { DriveRail } from '../src/files/DriveRail.js';
import type { CloudWorkspaceModel } from '../src/workspace-store.js';
import { describe, expect, it, vi } from 'vitest';
import { render, settle } from './dom.js';

const workspace: CloudWorkspaceModel = {
  id: 'workspace-one',
  ownerMembershipId: 'member-owner',
  canControl: true,
  shared: false,
  owner: { name: 'Ada Owner', avatarUrl: null },
  accessRole: 'owner',
  orgShareRole: 'viewer',
  serverName: 'details-test',
  title: 'Details test',
  machineType: 'cx23@fsn1',
  volumeId: 'volume-private-id',
  environmentConfigured: true,
  startupConfigured: false,
  lifecycleStatus: 'running',
  errorDetail: null,
  retryAction: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_005_000,
  connections: ['github', 'linear'],
  agentDefault: 'claude',
};

describe('WorkspaceDetailsDialog', () => {
  it('shows catalog metadata and every effective access source without raw IDs', async () => {
    const onDelete = vi.fn();
    const client = {
      listWorkspaceGrants: vi.fn().mockResolvedValue({
        grants: [{
          id: 'grant-one',
          membershipId: 'member-editor',
          role: 'editor',
          createdAt: 1,
          member: { name: 'Grace Editor', email: 'grace@example.com', avatarUrl: null },
        }],
      }),
    } as unknown as ControlPlaneClient;
    const view = await render(
      <WorkspaceDetailsDialog
        client={client}
        workspace={workspace}
        orgName="Acme"
        listMachineTypes={async () => ({
          machineTypes: [{
            id: 'cx23@fsn1',
            providerId: 'hetzner',
            supportsVolumes: true,
            name: 'Shared x86',
            cpuCores: 2,
            memGb: 4,
            diskGb: 40,
            arch: 'x86',
            location: 'fsn1',
            monthlyPrice: null,
          }],
          failures: [],
        })}
        listVolumes={async () => [{
          id: 'volume-private-id',
          name: 'Project data',
          sizeGb: 80,
          location: 'fsn1',
          status: 'attached',
          attachedTo: 'raw-vm-id',
        }]}
        onClose={() => undefined}
        onDelete={onDelete}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain('Shared x86');
    expect(view.container.textContent).toContain('Hetzner');
    expect(view.container.textContent).toContain('2 vCPU');
    expect(view.container.textContent).toContain('80 GB');
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Compute');
    expect(view.container.textContent).not.toContain('Everyone at Acme');
    expect(view.container.textContent).not.toContain('Grace Editor');
    expect(view.container.textContent).toContain('Environment variablesYes');
    expect(view.container.textContent).toContain('Startup scriptNo');
    expect(view.container.textContent).not.toContain('volume-private-id');
    expect(view.container.textContent).not.toContain('raw-vm-id');
    expect([...view.container.querySelectorAll('button')]
      .some((button) => button.textContent === 'Done')).toBe(false);

    const accessTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === 'Access');
    await act(async () => accessTab?.click());
    expect(accessTab?.getAttribute('aria-selected')).toBe('true');
    expect(view.container.textContent).toContain('Ada Owner');
    expect(view.container.textContent).toContain('Everyone at Acme');
    expect(view.container.textContent).toContain('Grace Editor');
    expect(view.container.textContent).not.toContain('Shared x86');

    const deleteButton = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Delete workspace');
    await act(async () => deleteButton?.click());
    expect(onDelete).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('replaces the rail delete control with separate Share and Details actions', async () => {
    const onShare = vi.fn();
    const onDetails = vi.fn();
    const view = await render(
      <DriveRail
        workspaces={[workspace]}
        activeWorkspaceId={workspace.id}
        nav={null}
        identity={null}
        org={{ id: 'org-one', slug: 'acme', name: 'Acme', vmLimit: 10 }}
        organizations={[]}
        sessions={[]}
        activeSessionId=""
        onSelectSession={() => undefined}
        onOpenDrive={() => undefined}
        onOpenTemplates={() => undefined}
        onOpenRecipes={() => undefined}
        onSelectWorkspace={() => undefined}
        onCreateWorkspace={() => undefined}
        onSwitchOrg={() => undefined}
        onCreateOrg={() => undefined}
        onOpenSettings={() => undefined}
        onOpenAdmin={() => undefined}
        onOpenWorkspaceShare={onShare}
        onOpenWorkspaceDetails={onDetails}
        drawerOpen={false}
        onCloseDrawer={() => undefined}
      />,
    );

    expect(view.container.querySelector('button[aria-label="Delete Details test"]')).toBeNull();
    expect(view.container.textContent).toContain('cx23@fsn1');
    const share = view.container.querySelector<HTMLButtonElement>('button[aria-label="Share Details test"]');
    const details = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace details for Details test"]',
    );
    expect(share).not.toBeNull();
    expect(details).not.toBeNull();
    await act(async () => share?.click());
    await act(async () => details?.click());
    expect(onShare).toHaveBeenCalledWith(workspace.id);
    expect(onDetails).toHaveBeenCalledWith(workspace.id);

    await act(async () => view.root.render(
      <DriveRail
        workspaces={[{ ...workspace, accessRole: 'editor', shared: true }]}
        activeWorkspaceId={workspace.id}
        nav={null}
        identity={null}
        org={{ id: 'org-one', slug: 'acme', name: 'Acme', vmLimit: 10 }}
        organizations={[]}
        sessions={[]}
        activeSessionId=""
        onSelectSession={() => undefined}
        onOpenDrive={() => undefined}
        onOpenTemplates={() => undefined}
        onOpenRecipes={() => undefined}
        onSelectWorkspace={() => undefined}
        onCreateWorkspace={() => undefined}
        onSwitchOrg={() => undefined}
        onCreateOrg={() => undefined}
        onOpenSettings={() => undefined}
        onOpenAdmin={() => undefined}
        onOpenWorkspaceShare={onShare}
        onOpenWorkspaceDetails={onDetails}
        drawerOpen={false}
        onCloseDrawer={() => undefined}
      />,
    ));
    expect(view.container.querySelector('button[aria-label="Share Details test"]')).toBeNull();
    expect(view.container.querySelector(
      'button[aria-label="Workspace details for Details test"]',
    )).not.toBeNull();
    await view.unmount();
  });
});
