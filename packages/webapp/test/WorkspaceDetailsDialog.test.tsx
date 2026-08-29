import { act } from 'react';
import type { MachineType, WorkspaceMemberView } from '@blitzos/schema';
import type { ControlPlaneClient } from '../src/api.js';
import { WorkspaceDetailsDialog } from '../src/WorkspaceDetailsDialog.js';
import { WorkspaceSessionRail } from '../src/shell/WorkspaceSessionRail.js';
import { describe, expect, it, vi } from 'vitest';
import { render, settle } from './dom.js';
import { workspaceModelFixture } from './workspace-fixtures.js';

const machineTypes: MachineType[] = [
  {
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
  },
  {
    id: 'cx33@hel1',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'Shared x86 large',
    cpuCores: 4,
    memGb: 8,
    diskGb: 80,
    arch: 'x86',
    location: 'hel1',
    monthlyPrice: null,
  },
];

const ada: WorkspaceMemberView = {
  membershipId: 'membership-1',
  name: 'Ada Owner',
  avatarUrl: null,
  role: 'admin',
  machine: {
    id: 'machine-ada',
    state: 'running',
    machineTypeId: 'cx23@fsn1',
    volumeId: 'volume-one',
    membershipId: 'membership-1',
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
};

const grace: WorkspaceMemberView = {
  membershipId: 'membership-2',
  name: 'Grace Viewer',
  avatarUrl: null,
  role: 'viewer',
  machine: null,
};

const workspace = workspaceModelFixture({
  serverName: 'details-test',
  title: 'Details test',
  members: [ada, grace],
  credentials: [{ name: 'STRIPE_API_KEY', label: 'billing', createdAt: 1_700_000_000_000 }],
});

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listMembers: vi.fn().mockResolvedValue({
      members: [
        { id: 'membership-1', email: 'ada@example.com', name: 'Ada Owner', avatarUrl: null, role: 'admin', status: 'active' },
        { id: 'membership-2', email: 'grace@example.com', name: 'Grace Viewer', avatarUrl: null, role: 'member', status: 'active' },
        { id: 'membership-3', email: 'nia@example.com', name: 'Nia Newcomer', avatarUrl: null, role: 'member', status: 'active' },
      ],
    }),
    ...overrides,
    // SAFETY: the dialog reaches for listMembers and the writes each test names.
  } as unknown as ControlPlaneClient;
}

function dialog(overrides: Partial<Parameters<typeof WorkspaceDetailsDialog>[0]> = {}) {
  return (
    <WorkspaceDetailsDialog
      client={client()}
      workspace={workspace}
      listMachineTypes={async () => ({ machineTypes, failures: [] })}
      onClose={() => undefined}
      onClone={() => undefined}
      onDelete={() => undefined}
      {...overrides}
    />
  );
}

function tab(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((button) => button.textContent === label);
}

describe('WorkspaceDetailsDialog', () => {
  it('opens on Members and lists one row per member, viewers without a machine', async () => {
    const view = await render(dialog());
    await settle();

    expect(tab(view.container, 'Members')?.getAttribute('aria-selected')).toBe('true');
    expect(view.container.textContent).toContain('Ada Owner');
    expect(view.container.textContent).toContain('Grace Viewer');
    // The machine state chip, and the type select on the member who holds one.
    expect(view.container.textContent).toContain('running');
    expect(view.container.querySelector('[aria-label="Machine type for Ada Owner"]')).not.toBeNull();
    // A viewer never holds a machine (§2.2), so no type select and no menu.
    expect(view.container.querySelector('[aria-label="Machine type for Grace Viewer"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Machine actions for Grace Viewer"]')).toBeNull();
    // The workspace owner cannot be removed; another member can.
    expect(view.container.querySelector('button[aria-label="Remove Ada Owner"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Remove Grace Viewer"]')).not.toBeNull();
    await view.unmount();
  });

  it('confirms a machine-type change as keeping the disk before it writes', async () => {
    const setMachineType = vi.fn().mockResolvedValue({ machine: ada.machine });
    const view = await render(dialog({ client: client({ setMachineType }) }));
    await settle();

    const select = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Machine type for Ada Owner"]',
    );
    await act(async () => select?.click());
    // The volume is in fsn1, so a hel1 type is visible and refused rather than
    // hidden — a missing option reads as a bug, a disabled one explains itself.
    const options = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const elsewhere = options.find((option) => option.textContent?.includes('Shared x86 large'));
    expect(elsewhere?.disabled).toBe(true);
    expect(elsewhere?.textContent).toContain('the volume is in fsn1');

    // Nothing is written until the confirmation says the disk survives.
    expect(setMachineType).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('lists credential names, never a value, and revokes one', async () => {
    const revokeWorkspaceCredential = vi.fn().mockResolvedValue(undefined);
    const view = await render(dialog({ client: client({ revokeWorkspaceCredential }) }));
    await settle();
    await act(async () => tab(view.container, 'Credentials')?.click());

    expect(view.container.textContent).toContain('STRIPE_API_KEY');
    expect(view.container.textContent).toContain('billing');
    // Write-only: the add field exists, but nothing reads a value back.
    const valueField = view.container.querySelector<HTMLInputElement>('[aria-label="Credential value"]');
    expect(valueField?.type).toBe('password');
    expect(valueField?.value).toBe('');

    const revoke = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke STRIPE_API_KEY"]',
    );
    await act(async () => revoke?.click());
    expect(revokeWorkspaceCredential).toHaveBeenCalledWith(workspace.id, 'STRIPE_API_KEY');
    await view.unmount();
  });

  it('offers clone and delete from Settings, and names the default machine type', async () => {
    const onClone = vi.fn();
    const onDelete = vi.fn();
    const view = await render(dialog({ onClone, onDelete }));
    await settle();
    await act(async () => tab(view.container, 'Settings')?.click());

    expect(view.container.textContent).toContain('Shared x86');
    expect(view.container.textContent).toContain('applies to new machines');

    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>('button')];
    await act(async () => buttons.find((b) => b.textContent === 'New workspace from this one')?.click());
    await act(async () => buttons.find((b) => b.textContent === 'Delete workspace')?.click());
    expect(onClone).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('shows a viewer the rows without any control over them', async () => {
    const view = await render(dialog({
      workspace: { ...workspace, myRole: 'viewer' },
    }));
    await settle();

    expect(view.container.textContent).toContain('Ada Owner');
    expect(view.container.querySelector('[aria-label="Add people"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Role for Ada Owner"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Machine actions for Ada Owner"]')).toBeNull();
    await view.unmount();
  });
});

describe('WorkspaceSessionRail', () => {
  it('opens members and details, and hides members from a non-admin', async () => {
    const onOpenMembers = vi.fn();
    const onOpenDetails = vi.fn();
    const view = await render(
      <WorkspaceSessionRail
        workspace={workspace}
        sessions={[]}
        activeSessionId=""
        onSelectSession={() => undefined}
        onSpawnSession={() => undefined}
        onOpenMembers={onOpenMembers}
        onOpenDetails={onOpenDetails}
      />,
    );

    expect(view.container.querySelector('button[aria-label="Delete Details test"]')).toBeNull();
    const members = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Members of Details test"]',
    );
    const details = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Workspace details for Details test"]',
    );
    await act(async () => members?.click());
    await act(async () => details?.click());
    expect(onOpenMembers).toHaveBeenCalledWith(workspace.id);
    expect(onOpenDetails).toHaveBeenCalledWith(workspace.id);

    // An editor on a shared workspace still opens details; only an owner or an
    // admin administers who else is in it.
    await act(async () => view.root.render(
      <WorkspaceSessionRail
        workspace={{ ...workspace, accessRole: 'editor', shared: true }}
        sessions={[]}
        activeSessionId=""
        onSelectSession={() => undefined}
        onSpawnSession={() => undefined}
        onOpenMembers={onOpenMembers}
        onOpenDetails={onOpenDetails}
      />,
    ));
    expect(view.container.querySelector('button[aria-label="Members of Details test"]')).toBeNull();
    expect(view.container.querySelector(
      'button[aria-label="Workspace details for Details test"]',
    )).not.toBeNull();
    await view.unmount();
  });
});
