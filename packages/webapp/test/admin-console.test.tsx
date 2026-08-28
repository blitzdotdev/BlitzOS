import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdminClient,
  AdminOrgView,
  CreateTrialOrgInput,
} from '../src/admin-api.js';
import { AdminPage, planState } from '../src/admin/AdminPage.js';
import { ApiRequestError } from '../src/api.js';
import { DriveRail } from '../src/files/DriveRail.js';
import { render, settle } from './dom.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function client(overrides: Partial<AdminClient> = {}): AdminClient {
  return {
    adminOrgs: vi.fn(async () => ({ orgs: [] })),
    createTrialOrg: vi.fn(async () => { throw new Error('unused'); }),
    ...overrides,
  };
}

function org(overrides: Partial<AdminOrgView> = {}): AdminOrgView {
  return {
    id: 'org-one',
    slug: 'acme',
    name: 'Acme',
    createdAt: NOW - 30 * DAY_MS,
    createdBy: 'founder@example.com',
    vmLimit: 2,
    seatLimit: 5,
    platformCompute: true,
    trialExpiresAt: null,
    members: [
      { email: 'founder@example.com', name: 'Founder', role: 'admin', status: 'active' },
      { email: 'gone@example.com', name: 'Gone', role: 'member', status: 'disabled' },
    ],
    invites: [{
      id: 'invite-one',
      email: null,
      role: 'member',
      state: 'ready',
      createdAt: NOW - DAY_MS,
      expiresAt: NOW + 6 * DAY_MS,
      redeemedAt: null,
    }],
    workspaces: [{
      id: 'workspace-one',
      name: 'dev box',
      phase: 'ready',
      machineTypeId: 'cx23@fsn1',
      credentialSource: 'deployment',
      createdAt: NOW - DAY_MS,
    }],
    ...overrides,
  };
}

const setInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;

function typeInto(input: HTMLInputElement, value: string): void {
  if (setInputValue === undefined) throw new Error('input value setter is unavailable');
  setInputValue.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function fieldByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const field = [...container.querySelectorAll('label.settings-field')]
    .find((candidate) => candidate.querySelector('span')?.textContent === label);
  const input = field?.querySelector('input');
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input;
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

describe('the plan state read', () => {
  const base = { trialExpiresAt: null, platformCompute: false, seatLimit: null };

  it('reads a billing-less organization as the free tier', () => {
    expect(planState(base, NOW)).toBe('Free');
  });

  it('reads a seat limit as a paid plan', () => {
    expect(planState({ ...base, seatLimit: 12 }, NOW)).toBe('Paid · 12 seats');
    expect(planState({ ...base, seatLimit: 1 }, NOW)).toBe('Paid · 1 seat');
  });

  it('reads a live trial from its clock', () => {
    const state = planState(
      { trialExpiresAt: NOW + DAY_MS, platformCompute: true, seatLimit: 5 },
      NOW,
    );
    expect(state).toMatch(/^Trial until /u);
  });

  it('reads a swept trial as ended', () => {
    const state = planState(
      { trialExpiresAt: NOW - DAY_MS, platformCompute: false, seatLimit: 5 },
      NOW,
    );
    expect(state).toMatch(/^Trial ended /u);
  });

  it('keeps an expired clock live until the sweep drops platform compute', () => {
    const state = planState(
      { trialExpiresAt: NOW - DAY_MS, platformCompute: true, seatLimit: 5 },
      NOW,
    );
    expect(state).toMatch(/^Trial until /u);
  });
});

describe('the admin console page', () => {
  it('renders every organization the control plane reports', async () => {
    const view = await render(<AdminPage client={client({
      adminOrgs: vi.fn(async () => ({ orgs: [org()] })),
    })} />);
    await settle();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Acme');
    expect(text).toContain('/acme');
    expect(text).toContain('founder@example.com');
    expect(text).toContain('Paid · 5 seats');
    expect(text).toContain('platform cloud');
    // One of the two members is active, so one seat of five is in use, and
    // the single live workspace fills one of two VM slots.
    expect(text).toContain('1 / 5 seats');
    expect(text).toContain('1 / 2 VMs');
    expect(text).toContain('admin · active');
    expect(text).toContain('member · disabled');
    expect(text).toContain('Anyone with the link');
    expect(text).toContain('member · ready');
    expect(text).toContain('dev box');
    expect(text).toContain('cx23@fsn1');
    await view.unmount();
  });

  it('posts the trial form and shows the invite link exactly once', async () => {
    const inputs: CreateTrialOrgInput[] = [];
    const createTrialOrg = vi.fn(async (input: CreateTrialOrgInput) => {
      inputs.push(input);
      return {
        org: { id: 'org-two', slug: 'trial-co', name: 'Trial Co', vmLimit: 2 },
        invite: {
          id: 'invite-two',
          email: null,
          role: 'admin' as const,
          state: 'ready' as const,
          createdAt: NOW,
          expiresAt: NOW + 7 * DAY_MS,
        },
        code: 'trial-code-123',
        ttlDays: 7,
        trialExpiresAt: NOW + 14 * DAY_MS,
      };
    });
    const view = await render(<AdminPage client={client({ createTrialOrg })} />);
    await settle();
    expect(view.container.querySelector('.settings-onetime')).toBeNull();

    typeInto(fieldByLabel(view.container, 'Organization name'), 'Trial Co');
    await submit(view.container);

    expect(inputs).toEqual([{
      name: 'Trial Co',
      email: undefined,
      trialDays: 14,
      seatLimit: 5,
      vmLimit: 2,
    }]);
    const link = view.container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]');
    expect(link?.value).toBe(`${window.location.origin}/invite/trial-code-123`);
    const onetime = view.container.querySelector('.settings-onetime');
    expect(onetime?.textContent).toContain('shown once');
    expect(onetime?.textContent).toContain('trial ends');
    expect([...(onetime?.querySelectorAll('button') ?? [])]
      .some((button) => button.textContent === 'Copy')).toBe(true);
    await view.unmount();
  });

  it('renders the refusal in place when the control plane answers 403', async () => {
    const view = await render(<AdminPage client={client({
      adminOrgs: vi.fn(async () => {
        throw new ApiRequestError('platform operator required', 403, null);
      }),
    })} />);
    await settle();
    const refusal = view.container.querySelector('[role="alert"]');
    expect(refusal?.textContent).toContain('platform operator');
    expect(view.container.querySelector('form')).toBeNull();
    await view.unmount();
  });
});

describe('the rail admin entry', () => {
  function rail(platformOperator: boolean) {
    return (
      <DriveRail
        workspaces={[]}
        activeWorkspaceId=""
        nav="drive"
        identity={{
          id: 'user-one',
          email: 'op@example.com',
          name: 'Op',
          avatarUrl: null,
          platformOperator,
        }}
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
        onOpenWorkspaceShare={() => undefined}
        onOpenWorkspaceDetails={() => undefined}
        drawerOpen={false}
        onCloseDrawer={() => undefined}
      />
    );
  }

  function adminButton(container: HTMLElement): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Admin');
  }

  it('shows the entry to a platform operator and to nobody else', async () => {
    const asOperator = await render(rail(true));
    expect(adminButton(asOperator.container)).not.toBeUndefined();
    await asOperator.unmount();

    const asMember = await render(rail(false));
    expect(adminButton(asMember.container)).toBeUndefined();
    await asMember.unmount();
  });
});
