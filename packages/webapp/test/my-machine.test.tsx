import { act } from 'react';
import type { MachineType, WorkspaceMemberView } from '@blitzos/schema';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { MyMachineDialog } from '../src/MyMachineDialog.js';
import { WorkspaceSessionRail } from '../src/shell/WorkspaceSessionRail.js';
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
    monthlyPrice: { amount: 6.49, currency: 'USD' },
  },
];

const ada: WorkspaceMemberView = {
  membershipId: 'membership-1',
  name: 'Ada Owner',
  avatarUrl: null,
  role: 'admin',
  machine: null,
};

const me: WorkspaceMemberView = {
  membershipId: 'membership-2',
  name: 'Mo Member',
  avatarUrl: null,
  role: 'member',
  machine: {
    id: 'machine-mo',
    state: 'running',
    machineTypeId: 'cx23@fsn1',
    volumeId: 'volume-one',
    membershipId: 'membership-2',
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
};

const workspace = workspaceModelFixture({
  title: 'design-team',
  members: [ada, me],
  myRole: 'member',
});

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  // SAFETY: the dialog reaches only for the writes each test names.
  return { ...overrides } as unknown as ControlPlaneClient;
}

function dialog(overrides: Partial<Parameters<typeof MyMachineDialog>[0]> = {}) {
  return (
    <MyMachineDialog
      client={client()}
      workspace={workspace}
      membershipId="membership-2"
      listMachineTypes={async () => ({ machineTypes, failures: [] })}
      onClose={() => undefined}
      {...overrides}
    />
  );
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.my-machine-actions button')];
}

describe('MyMachineDialog', () => {
  it('describes the member’s own machine and stops it', async () => {
    const stopMachine = vi.fn().mockResolvedValue({ machine: me.machine });
    const view = await render(dialog({ client: client({ stopMachine }) }));
    await settle();

    // One view, no tab row: there is one thing to read here.
    expect(view.container.querySelector('.workspace-details-tabs')).toBeNull();
    expect(view.container.textContent).toContain('Shared x86');
    expect(view.container.textContent).toContain('2 vCPU');
    expect(view.container.textContent).toContain('4 GB');
    expect(view.container.textContent).toContain('$6.49/mo');
    expect(view.container.textContent).toContain('Attached');

    const stop = buttons(view.container).find((button) => button.textContent === 'Stop');
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(stopMachine).toHaveBeenCalledWith('machine-mo');
    await view.unmount();
  });

  it('names the admins to ask for a verb a member may not run', async () => {
    const view = await render(dialog());
    await settle();

    const recreate = buttons(view.container).find((button) => button.textContent === 'Recreate');
    const destroy = buttons(view.container).find((button) => button.textContent === 'Destroy');
    expect(recreate?.disabled).toBe(true);
    expect(destroy?.disabled).toBe(true);
    expect(recreate?.title).toBe('Ask a workspace admin: Ada Owner');
    // Re-typing a machine is admin work too, so the select is copy instead.
    expect(view.container.querySelector('[aria-label="Change my machine type"]')).toBeNull();
    expect(view.container.textContent).toContain('Ask a workspace admin: Ada Owner');
    await view.unmount();
  });

  it('gives a workspace admin every verb, and confirms a type change keeps the disk', async () => {
    const setMachineType = vi.fn().mockResolvedValue({ machine: me.machine });
    const view = await render(dialog({
      client: client({ setMachineType }),
      workspace: { ...workspace, myRole: 'admin' },
    }));
    await settle();

    expect(buttons(view.container).every((button) => !button.disabled)).toBe(true);
    expect(view.container.querySelector('[aria-label="Change my machine type"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Ask a workspace admin');
    await view.unmount();
  });

  it('tells a viewer they hold no machine', async () => {
    const view = await render(dialog({
      workspace: {
        ...workspace,
        myRole: 'viewer',
        members: [ada, { ...me, role: 'viewer', machine: null }],
      },
    }));
    await settle();

    expect(view.container.textContent).toContain('A viewer holds no machine');
    expect(buttons(view.container)).toHaveLength(0);
    await view.unmount();
  });
});

describe('the rail header', () => {
  it('opens my machine from its own button', async () => {
    const onOpenMachine = vi.fn();
    const view = await render(
      <WorkspaceSessionRail
        workspace={workspace}
        sessions={[]}
        activeSessionId=""
        livePorts={[]}
        previewLinks={[]}
        onSelectSession={() => undefined}
        onSpawnSession={() => undefined}
        onOpenPreview={() => undefined}
        onOpenPreviewLink={() => undefined}
        onOpenMembers={() => undefined}
        onOpenDetails={() => undefined}
        onOpenMachine={onOpenMachine}
      />,
    );

    const machine = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="My machine in design-team"]',
    );
    await act(async () => machine?.click());
    expect(onOpenMachine).toHaveBeenCalledWith(workspace.id);
    // Members wears the Drive page's share icon, which is a 24-grid glyph;
    // the strip's own three-node one is gone.
    const members = view.container.querySelector(
      'button[aria-label="Members of design-team"] svg',
    );
    expect(members?.getAttribute('viewBox')).toBe('0 0 24 24');
    await view.unmount();
  });
});
