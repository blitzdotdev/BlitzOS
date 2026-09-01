import { act } from 'react';
import type {
  ListMachineTypesResponse,
  MachineType,
  WorkspaceMemberView,
} from '@blitzos/schema';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { MyMachineDialog } from '../src/MyMachineDialog.js';
import { SessionRail } from '../src/shell/SessionRail.js';
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

/**
 * `GET /machine-types` as `core/app.ts` serves it: the registry's
 * `{ machineTypes, failures }` — each entry decorated with `providerId` and
 * `supportsVolumes` by `core/compute/registry.ts` — spread beside
 * `providerStatuses`. The suite fixture above predates the third field.
 */
const catalogResponse: ListMachineTypesResponse = {
  machineTypes: [{
    id: 'cx33@hel1',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'cx33',
    cpuCores: 4,
    memGb: 8,
    diskGb: 80,
    arch: 'x86',
    location: 'hel1',
    monthlyPrice: { amount: 9.99, currency: 'USD' },
  }],
  failures: [],
  providerStatuses: [{ providerId: 'hetzner', access: 'deployment' }],
};

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
    volumeUsedPercent: 62,
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
  // The lifecycle verbs sit in the settings-surface actions row
  // (src/settings-surface.css); it is the only one in this dialog.
  return [...container.querySelectorAll<HTMLButtonElement>('.cfg-actions button')];
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
    // The volume row is a meter, never the bare word "Attached": what a member
    // needs from it is how much room is left.
    expect(view.container.textContent).toContain('62% full');

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

  it('reads the size out of the response the control plane actually serves', async () => {
    const view = await render(dialog({
      workspace: {
        ...workspace,
        members: [ada, { ...me, machine: { ...me.machine!, machineTypeId: 'cx33@hel1' } }],
      },
      listMachineTypes: async () => catalogResponse,
    }));
    await settle();

    expect(view.container.textContent).toContain('4 vCPU');
    expect(view.container.textContent).toContain('8 GB');
    expect(view.container.textContent).toContain('80 GB');
    expect(view.container.textContent).toContain('$9.99/mo');
    expect(view.container.textContent).not.toContain('Unavailable');
    await view.unmount();
  });

  /**
   * The canary defect. The catalog is what an organization may create NOW:
   * the Hetzner adapter drops deprecated types, drops locations reporting no
   * availability, and keeps only the allowlisted ids, so a live machine's type
   * can be absent from a catalog that is otherwise healthy. The panel used to
   * answer that with four bare "Unavailable" rows and no reason at all.
   */
  it('says why a size is missing instead of printing “Unavailable” four times', async () => {
    const view = await render(dialog({
      workspace: {
        ...workspace,
        members: [ada, { ...me, machine: { ...me.machine!, machineTypeId: 'cx33@hel1' } }],
      },
      // A healthy catalog that no longer offers this machine's type.
      listMachineTypes: async () => ({ machineTypes, failures: [] }),
    }));
    await settle();

    expect(view.container.textContent).toContain('The catalog no longer offers cx33@hel1');
    expect(view.container.textContent).not.toContain('Unavailable');
    // The type id stays readable, because it is the one fact that is known.
    expect(view.container.textContent).toContain('cx33@hel1');
    await view.unmount();
  });

  it('names the provider whose credential emptied the catalog', async () => {
    const view = await render(dialog({
      listMachineTypes: async () => ({
        machineTypes: [],
        failures: [],
        providerStatuses: [{ providerId: 'hetzner', access: 'credential-required' }],
      }),
    }));
    await settle();

    expect(view.container.textContent).toContain('hetzner needs an organization compute credential');
    await view.unmount();
  });

  it('reports a provider failure the catalog answered 200 with', async () => {
    const view = await render(dialog({
      listMachineTypes: async () => ({
        machineTypes: [],
        failures: [{ providerId: 'hetzner', error: 'rate limited' }],
      }),
    }));
    await settle();

    expect(view.container.textContent).toContain('hetzner: rate limited');
    await view.unmount();
  });

  it('shows a message when the catalog rejects with something that is not an Error', async () => {
    const view = await render(dialog({
      // A rejection that is not an Error, which is what a stray throw produces.
      listMachineTypes: () => Promise.reject('boom'),
    }));
    await settle();

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('The machine catalog could not be loaded.');
    await view.unmount();
  });

  it('reports the volume as a meter, a pending state, or nothing at all', async () => {
    const withMachine = (machine: WorkspaceMemberView['machine']) => ({
      ...workspace,
      members: [ada, { ...me, machine }],
    });

    const reported = await render(dialog({ workspace: withMachine(me.machine) }));
    await settle();
    expect(reported.container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow'))
      .toBe('62');
    expect(reported.container.querySelector('.volume-meter-fill')?.getAttribute('style'))
      .toContain('62%');
    await reported.unmount();

    // A guest from before the reporter shipped. The track is there and empty;
    // 0% would claim a measurement nobody made.
    const pending = await render(dialog({
      workspace: withMachine({ ...me.machine!, volumeUsedPercent: null }),
    }));
    await settle();
    expect(pending.container.textContent).toContain('usage not reported yet');
    expect(pending.container.querySelector('[role="meter"]')).toBeNull();
    expect(pending.container.querySelector('.volume-meter-track')).not.toBeNull();
    await pending.unmount();

    const none = await render(dialog({
      workspace: withMachine({ ...me.machine!, volumeId: null, volumeUsedPercent: null }),
    }));
    await settle();
    expect(none.container.textContent).toContain('Not attached');
    expect(none.container.querySelector('.volume-meter-track')).toBeNull();
    await none.unmount();
  });

  it('warns on its own colour once the volume is nearly full', async () => {
    const view = await render(dialog({
      workspace: {
        ...workspace,
        members: [ada, { ...me, machine: { ...me.machine!, volumeUsedPercent: 94 } }],
      },
    }));
    await settle();

    expect(view.container.querySelector('.volume-meter--warn')).not.toBeNull();
    expect(view.container.textContent).toContain('94% full');
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
      <SessionRail
        workspace={workspace}
        sessions={[]}
        activeSessionId=""
        livePorts={[]}
        previewLinks={[]}
        onSelectSession={() => undefined}
        onCloseSession={() => undefined}
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
