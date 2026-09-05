import { act } from 'react';
import type {
  MachineState,
  MachineType,
  MachineView,
  OrgCredentialView,
  WorkspaceMemberView,
} from '@blitzos/schema';
import type { ControlPlaneClient } from '../src/api.js';
import { WorkspaceDetailsDialog } from '../src/WorkspaceDetailsDialog.js';
import { SessionRail } from '../src/shell/SessionRail.js';
import { machineActionsFor } from '../src/WorkspaceMembersEditor.js';
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
    volumeUsedPercent: 62,
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
});

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listWorkspaceRepos: vi.fn().mockResolvedValue({ repos: [] }),
    listSessionShares: vi.fn().mockResolvedValue({ granted: [], received: [] }),
    grantSessionShare: vi.fn(),
    revokeSessionShare: vi.fn(),
    listAgentRules: vi.fn().mockResolvedValue({ rules: [] }),
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

const listMachineTypesStub = async () => ({ machineTypes, failures: [] });
const noop = () => undefined;

function dialog(overrides: Partial<Parameters<typeof WorkspaceDetailsDialog>[0]> = {}) {
  return (
    <WorkspaceDetailsDialog
      client={client()}
      workspace={workspace}
      listMachineTypes={listMachineTypesStub}
      refreshWorkspaces={noop}
      onClose={noop}
      onClone={noop}
      onDelete={noop}
      {...overrides}
    />
  );
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('provisions a machine for a member row that holds none', async () => {
    const provisionMemberMachine = vi.fn().mockResolvedValue({ member: grace });
    const view = await render(dialog({
      client: client({ provisionMemberMachine }),
      // A viewer never holds a machine, so the row that can be provisioned is
      // a member whose workspace did not auto-provision one.
      workspace: { ...workspace, members: [ada, { ...grace, role: 'member' }] },
    }));
    await settle();

    const menu = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Machine actions for Grace Viewer"]',
    );
    await act(async () => menu?.click());
    const options = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(['Provision']);
    await act(async () => options[0]?.click());

    expect(provisionMemberMachine).toHaveBeenCalledWith(workspace.id, grace.membershipId, {});
    await view.unmount();
  });

  it('provisions without a volume when the row turns the toggle off', async () => {
    const provisionMemberMachine = vi.fn().mockResolvedValue({ member: grace });
    const view = await render(dialog({
      client: client({ provisionMemberMachine }),
      workspace: { ...workspace, members: [ada, { ...grace, role: 'member' }] },
    }));
    await settle();

    // Ada's machine already holds a volume, so her row reports the disk that
    // exists — how full it is — rather than offering a choice this route
    // cannot make.
    expect(view.container.querySelector(
      '[aria-label="Persistent volume for Ada Owner"]',
    )).toBeNull();
    const meter = view.container.querySelector('.workspace-member-row [role="meter"]');
    expect(meter?.getAttribute('aria-valuenow')).toBe('62');
    expect(view.container.textContent).toContain('62% full');
    expect(view.container.textContent).not.toContain('Attached');

    const toggle = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Persistent volume for Grace Viewer"]',
    );
    expect(toggle?.checked).toBe(true);
    await act(async () => toggle?.click());

    const menu = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Machine actions for Grace Viewer"]',
    );
    await act(async () => menu?.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>('[role="option"]')?.click());

    expect(provisionMemberMachine).toHaveBeenCalledWith(
      workspace.id,
      grace.membershipId,
      { persistentVolume: false },
    );
    await view.unmount();
  });

  it('anchors every row popover to the viewport, so the dialog cannot clip it', async () => {
    const view = await render(dialog({
      workspace: { ...workspace, members: [ada, { ...grace, role: 'member' }] },
    }));
    await settle();

    // The three the report named: the role listbox, the machine-type listbox
    // and the lifecycle menu. Each sits inside `.workspace-details-body`,
    // which scrolls, so an absolutely positioned popover was clipped by it.
    // Ada is the workspace owner, so her role is a fact and not a control.
    const labels = [
      'Role for Grace Viewer',
      'Machine type for Ada Owner',
      'Machine actions for Ada Owner',
    ];
    for (const label of labels) {
      const trigger = view.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      if (trigger === null) throw new Error(`no trigger for ${label}`);
      // A row far enough down the viewport that the popover opens upward.
      trigger.getBoundingClientRect = () => ({
        x: 300, y: 500, left: 300, top: 500, right: 420, bottom: 530,
        width: 120, height: 30, toJSON: () => ({}),
      });
      await act(async () => trigger.click());
      const menu = view.container.querySelector<HTMLElement>(`[role="listbox"][aria-label="${label}"]`);
      if (menu === null) throw new Error(`no popover for ${label}`);
      expect(menu.style.left).toBe('300px');
      // Anchored above the trigger, in viewport coordinates rather than in the
      // scrolling body's.
      expect(menu.style.bottom).toBe(`${String(window.innerHeight - 500 + 6)}px`);
      expect(menu.style.top).toBe('');
      await act(async () => trigger.click());
    }
    await view.unmount();
  });

  it('renders the server-scoped workspace credential list, values never shown', async () => {
    const credential = (name: string, grants: OrgCredentialView['grants'], comment: string | null = null): OrgCredentialView => ({
      id: `cred-${name}`, name, comment, createdByMembershipId: 'membership-1',
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, grants,
    });
    const listOrgCredentials = vi.fn().mockResolvedValue({ credentials: [
      credential('STRIPE_API_KEY', [
        { subjectKind: 'workspace', subjectId: workspace.id, access: 'read' },
        { subjectKind: 'membership', subjectId: 'membership-1', access: 'write' },
      ], 'test-mode key, safe for CI'),
      credential('SENTRY_DSN', [{ subjectKind: 'org', subjectId: null, access: 'read' }]),
      credential('MY_TOKEN', [{ subjectKind: 'membership', subjectId: 'membership-1', access: 'write' }]),
      // A plain reader's view: readable, audience withheld.
      credential('READ_ONLY', []),
    ] });
    const view = await render(dialog({
      client: client({ listOrgCredentials }),
      viewerMembershipId: 'membership-1',
    }));
    await settle();
    await act(async () => tab(view.container, 'Credentials')?.click());
    await settle();

    const rows = [...view.container.querySelectorAll('.workspace-credential-row')]
      .map((row) => row.textContent);
    expect(rows).toEqual([
      'STRIPE_API_KEYtest-mode key, safe for CIgranted to this workspaceRotate',
      'SENTRY_DSNorg-wideRotate',
      'MY_TOKENgranted to youRotate',
      'READ_ONLYreadable by you',
    ]);
    expect(listOrgCredentials).toHaveBeenCalledWith(expect.any(AbortSignal), workspace.id);
    // Nothing on the tab reads a value back.
    expect(view.container.querySelector('[aria-label="Credential value"]')).toBeNull();
    await view.unmount();
  });

  it('adds and rotates through the org-level form, a new key granted to this workspace', async () => {
    const putOrgCredential = vi.fn().mockResolvedValue({ credential: null });
    const listOrgCredentials = vi.fn().mockResolvedValue({ credentials: [{
      id: 'cred-1', name: 'STRIPE_API_KEY', comment: null, createdByMembershipId: 'membership-1',
      createdAt: 1, updatedAt: 1,
      grants: [{ subjectKind: 'workspace', subjectId: workspace.id, access: 'read' }],
    }] });
    const view = await render(dialog({ client: client({ listOrgCredentials, putOrgCredential }) }));
    await settle();
    await act(async () => tab(view.container, 'Credentials')?.click());
    await settle();

    const buttonNamed = (text: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === text);
    await act(async () => buttonNamed('Add a credential')?.click());
    const addForm = view.container.querySelector('form[aria-label="Add a credential"]');
    if (addForm === null) throw new Error('no add form');
    // The default audience is this workspace, named, not an id.
    expect(addForm.querySelector('.org-grant-row')?.textContent).toContain('Details test');
    const name = addForm.querySelector<HTMLInputElement>('[aria-label="Credential name"]');
    const value = addForm.querySelector<HTMLInputElement>('[aria-label="Credential value"]');
    if (name === null || value === null) throw new Error('no add fields');
    expect(value.type).toBe('password');
    await act(async () => { typeInto(name, 'DATABASE_URL'); typeInto(value, 'postgres://x'); });
    await act(async () => buttonNamed('Save credential')?.click());
    expect(putOrgCredential).toHaveBeenCalledWith({
      name: 'DATABASE_URL',
      value: 'postgres://x',
      grants: [{ subjectKind: 'workspace', subjectId: workspace.id, access: 'read' }],
    });
    await settle();
    // The tab re-reads after the write rather than inventing a row.
    expect(listOrgCredentials).toHaveBeenCalledTimes(2);

    await act(async () => view.container.querySelector<HTMLButtonElement>('button[aria-label="Rotate STRIPE_API_KEY"]')?.click());
    const rotateForm = view.container.querySelector('form[aria-label="Rotate STRIPE_API_KEY"]');
    if (rotateForm === null) throw new Error('no rotate form');
    const newValue = rotateForm.querySelector<HTMLInputElement>('[aria-label="Credential value"]');
    if (newValue === null) throw new Error('no value field');
    await act(async () => typeInto(newValue, 'sk_new'));
    // The form's own verb, not the row's "Rotate" that opened it.
    await act(async () => rotateForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(putOrgCredential).toHaveBeenLastCalledWith({ name: 'STRIPE_API_KEY', value: 'sk_new' });
    await view.unmount();
  });

  it('offers delete from the footer, not clone, and names the default machine type', async () => {
    const onClone = vi.fn();
    const onDelete = vi.fn();
    const view = await render(dialog({ onClone, onDelete }));
    await settle();

    // The pre-#106 chrome: the header names the workspace and the
    // workspace-wide verbs live in the footer, under every tab.
    expect(view.container.querySelector('.workspace-details-header h1')?.textContent)
      .toBe('Workspace details “Details test”');
    const footer = view.container.querySelector('.workspace-details-footer');
    expect(footer).not.toBeNull();

    await act(async () => tab(view.container, 'Settings')?.click());
    expect(view.container.textContent).toContain('Shared x86');
    expect(view.container.textContent).toContain('Applies to new machines');

    const buttons = [...footer!.querySelectorAll<HTMLButtonElement>('button')];
    // Clone is disabled (2026-09-05): the footer draws Delete alone, and
    // passing `onClone` cannot bring the verb back.
    expect(buttons.map((b) => b.textContent)).toEqual(['Delete workspace']);
    await act(async () => buttons.find((b) => b.textContent === 'Delete workspace')?.click());
    expect(onClone).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('writes only the settings fields that actually changed', async () => {
    const updateWorkspace = vi.fn().mockResolvedValue({ workspace: {} });
    const view = await render(dialog({ client: client({ updateWorkspace }) }));
    await settle();
    await act(async () => tab(view.container, 'Settings')?.click());

    const save = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Save settings');
    // Nothing has moved yet, so there is nothing to say to the server.
    expect(save()?.disabled).toBe(true);

    const name = view.container.querySelector<HTMLInputElement>('[aria-label="Workspace name"]');
    if (name === null) throw new Error('the settings tab has no name field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(name, 'renamed-workspace');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The auto-provision row is a `.cfg-field--inline` checkbox, not a
    // self-saving SettingsSwitch: it flips a draft that the Save below sends,
    // so it keeps its own accessible name.
    const toggle = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Provision a machine when a member is added"]',
    );
    await act(async () => toggle?.click());

    expect(save()?.disabled).toBe(false);
    await act(async () => save()?.click());
    // The default machine type and the agent rule were never touched, so they
    // travel as absent fields rather than as a restatement of what is stored.
    expect(updateWorkspace).toHaveBeenCalledWith(workspace.id, {
      name: 'renamed-workspace',
      autoProvision: false,
    });
    await view.unmount();
  });

  it('adds and removes a repository from Settings', async () => {
    const addWorkspaceRepo = vi.fn().mockResolvedValue({
      repos: [{ repo: 'acme/tools', private: false }],
    });
    const removeWorkspaceRepo = vi.fn().mockResolvedValue(undefined);
    const view = await render(dialog({
      client: client({ addWorkspaceRepo, removeWorkspaceRepo }),
    }));
    await settle();
    await act(async () => tab(view.container, 'Settings')?.click());

    const field = view.container.querySelector<HTMLInputElement>('[aria-label="Repository"]');
    if (field === null) throw new Error('the settings tab has no repository field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(field, 'acme/tools');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = (label: string) =>
      [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent === label);
    await act(async () => button('Add repository')?.click());
    expect(addWorkspaceRepo).toHaveBeenCalledWith(workspace.id, { repo: 'acme/tools' });
    // The answer is the list the server holds, so the row appears without a
    // second read.
    expect(view.container.textContent).toContain('acme/tools');

    const remove = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove acme/tools"]',
    );
    await act(async () => remove?.click());
    expect(removeWorkspaceRepo).toHaveBeenCalledWith(workspace.id, 'acme/tools');
    expect(view.container.querySelector('button[aria-label="Remove acme/tools"]')).toBeNull();
    await view.unmount();
  });

  it('shows a member the settings without the controls that write them', async () => {
    const view = await render(dialog({
      workspace: { ...workspace, myRole: 'member' },
    }));
    await settle();
    await act(async () => tab(view.container, 'Settings')?.click());

    expect(view.container.textContent).toContain('Shared x86');
    expect(view.container.querySelector('[aria-label="Workspace name"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Default machine type"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Repository"]')).toBeNull();
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

describe('SessionRail', () => {
  it('opens members and details, and hides members from a non-admin', async () => {
    const onOpenMembers = vi.fn();
    const onOpenDetails = vi.fn();
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
        onOpenMembers={onOpenMembers}
        onOpenDetails={onOpenDetails}
        onOpenMachine={() => undefined}
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
      <SessionRail
        workspace={{ ...workspace, accessRole: 'editor', shared: true }}
        sessions={[]}
        activeSessionId=""
        livePorts={[]}
        previewLinks={[]}
        onSelectSession={() => undefined}
        onCloseSession={() => undefined}
        onSpawnSession={() => undefined}
        onOpenPreview={() => undefined}
        onOpenPreviewLink={() => undefined}
        onOpenMembers={onOpenMembers}
        onOpenDetails={onOpenDetails}
        onOpenMachine={() => undefined}
      />,
    ));
    expect(view.container.querySelector('button[aria-label="Members of Details test"]')).toBeNull();
    expect(view.container.querySelector(
      'button[aria-label="Workspace details for Details test"]',
    )).not.toBeNull();
    await view.unmount();
  });

  it('opens the same New tab menu the tab strip serves, live ports and all', async () => {
    const onSpawnSession = vi.fn();
    const onOpenPreview = vi.fn();
    const view = await render(
      <SessionRail
        workspace={workspace}
        sessions={[]}
        activeSessionId=""
        livePorts={[{ port: 3000, process: 'vite', firstSeenAt: 1 }]}
        previewLinks={[]}
        onSelectSession={() => undefined}
        onCloseSession={() => undefined}
        onSpawnSession={onSpawnSession}
        onOpenPreview={onOpenPreview}
        onOpenPreviewLink={() => undefined}
        onOpenMembers={() => undefined}
        onOpenDetails={() => undefined}
        onOpenMachine={() => undefined}
      />,
    );

    const pinned = view.container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]');
    expect(pinned?.textContent).toContain('New tab');
    await act(async () => pinned?.click());
    const items = [...view.container.querySelectorAll<HTMLButtonElement>(
      '.webapp-agent-menu.shell-newmenu [role="menuitem"]',
    )];
    expect(items.map((item) => item.textContent?.trim()))
      .toEqual(['Claude', 'Codex', 'Terminal', ':3000vite']);
    await act(async () => items[3]?.click());
    expect(onOpenPreview).toHaveBeenCalledWith(3000);
    expect(view.container.querySelector('.shell-newmenu')).toBeNull();
    await view.unmount();
  });
});

describe('machineActionsFor', () => {
  const machine = (state: MachineState): MachineView => ({
    id: 'machine-one',
    state,
    machineTypeId: 'cx23@fsn1',
    volumeId: 'volume-one',
    volumeUsedPercent: null,
    membershipId: 'membership-1',
    error: null,
    createdAt: 1,
    updatedAt: 1,
  });

  it('offers provision without a machine, which is the one verb that applies', () => {
    // The wire sends null where the workspace does not auto-provision, or
    // where the machine was destroyed. That row is keyed by the membership,
    // not by a machine id, which is why provision took its own route.
    expect(machineActionsFor(null)).toEqual(['provision']);
  });

  it('offers nothing to a machine that is going somewhere', () => {
    expect(machineActionsFor(machine('provisioning'))).toEqual([]);
    expect(machineActionsFor(machine('destroying'))).toEqual([]);
  });

  it('matches each settled state to what it can accept', () => {
    expect(machineActionsFor(machine('running'))).toEqual(['stop', 'recreate', 'destroy']);
    expect(machineActionsFor(machine('stopped'))).toEqual(['start', 'destroy']);
    // Error is the one reachable state whose VM may be missing, so it is the
    // only one that offers a bare provision.
    expect(machineActionsFor(machine('error'))).toEqual(['provision', 'recreate', 'destroy']);
  });
});
