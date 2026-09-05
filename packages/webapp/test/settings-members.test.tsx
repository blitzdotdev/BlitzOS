import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient, InviteView, MemberView } from '../src/api.js';
import type { TenantMe } from '../src/api-adapter.js';
import { SettingsPage } from '../src/SettingsPage.js';
import { MembersPanel } from '../src/settings/MembersPanel.js';
import { render, settle } from './dom.js';

const DAY = 24 * 60 * 60 * 1000;

const people: MemberView[] = [
  { id: 'm-1', email: 'ada@example.com', name: 'Ada Park', avatarUrl: null, role: 'admin', status: 'active' },
  { id: 'm-2', email: 'dana@example.com', name: 'Dana Reyes', avatarUrl: null, role: 'member', status: 'active' },
];

function invite(overrides: Partial<InviteView> = {}): InviteView {
  return {
    id: 'inv-1',
    email: 'alex@example.com',
    role: 'member',
    state: 'ready',
    createdAt: Date.now(),
    expiresAt: Date.now() + 6 * DAY,
    redeemedAt: null,
    ...overrides,
  };
}

/** Only what the panel calls. */
function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listMembers: vi.fn(async () => ({ members: people })),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error('unused'); }),
    revokeInvite: vi.fn(async () => undefined),
    updateMember: vi.fn(async () => { throw new Error('unused'); }),
    leaveOrg: vi.fn(async () => undefined),
    orgUsage: vi.fn(async () => ({
      seatsUsed: 2,
      seatLimit: null,
      vmsUsed: 0,
      vmLimit: 10,
      platformCompute: false,
    })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
    ...overrides,
  } as unknown as ControlPlaneClient;
}

function viewer(role: 'admin' | 'member'): TenantMe {
  const membership = { id: 'm-1', role };
  const org = { id: 'org-1', slug: 'acme', name: 'Acme', vmLimit: 10 };
  return {
    identity: { id: 'u-1', email: 'ada@example.com', name: 'Ada Park', avatarUrl: null },
    membership,
    org,
    organizations: [{ membership, org }],
  };
}

function headings(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.cfg-title')].map((node) => node.textContent ?? '');
}

describe('the members panel', () => {
  it('reveals the invite fields as the last row of the members list', async () => {
    const view = await render(<MembersPanel client={client()} admin orgName="Acme" onLeft={() => undefined} />);
    await settle();

    // The list is the surface: no form is drawn until somebody asks for one.
    expect(view.container.querySelector('form')).toBeNull();
    const open = view.container.querySelector<HTMLButtonElement>('.settings-people > .settings-person-open');
    expect(open?.textContent).toBe('+ Invite someone');

    await act(async () => open?.click());
    const form = view.container.querySelector<HTMLFormElement>('.settings-people > .settings-person-add');
    expect(form).not.toBeNull();
    expect(form?.querySelector('input[type="email"]')).not.toBeNull();
    expect(form?.querySelector('select')).not.toBeNull();
    // The `+` became the row being added, rather than sitting above it.
    expect(view.container.querySelector('.settings-person-open')).toBeNull();
    await view.unmount();
  });

  it('counts the members and hides the invites section until one is pending', async () => {
    const empty = await render(<MembersPanel client={client()} admin orgName="Acme" onLeft={() => undefined} />);
    await settle();
    expect(headings(empty.container)).toEqual(['Members · 2', 'Danger zone']);
    await empty.unmount();

    // Only a `ready` invite is pending: a redeemed one is a member above, and
    // a revoked one is nothing at all.
    const listInvites = vi.fn(async () => ({
      invites: [
        invite(),
        invite({ id: 'inv-2', email: null, role: 'admin' as const }),
        invite({ id: 'inv-3', state: 'revoked' as const }),
      ],
      ttlDays: 7,
    }));
    const view = await render(<MembersPanel client={client({ listInvites })} admin orgName="Acme" onLeft={() => undefined} />);
    await settle();
    expect(headings(view.container)).toEqual(['Members · 2', 'Pending invites · 2', 'Danger zone']);
    const rows = view.container.querySelectorAll('[aria-label="Pending invites"] .settings-person');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('alex@example.com');
    expect(rows[0]?.textContent).toContain('expires in 6 days');
    // An invite with no address is a link anybody may redeem.
    expect(rows[1]?.textContent).toContain('Anyone with the link');
    await view.unmount();
  });

  it('gives a member the list and the danger zone, and nothing to write with', async () => {
    const listInvites = vi.fn(async () => ({ invites: [invite()], ttlDays: 7 }));
    const view = await render(<MembersPanel client={client({ listInvites })} admin={false} orgName="Acme" onLeft={() => undefined} />);
    await settle();

    // Every write here is refused for a member, so nothing offers one.
    expect(listInvites).not.toHaveBeenCalled();
    expect(headings(view.container)).toEqual(['Members · 2', 'Danger zone']);
    expect(view.container.querySelector('.settings-person-open')).toBeNull();
    expect(view.container.querySelector('.settings-person-actions')).toBeNull();
    expect(view.container.querySelectorAll('.settings-person-role')).toHaveLength(2);
    expect(view.container.querySelector('.cfg-danger-action')).not.toBeNull();
    await view.unmount();
  });
});

describe('the settings navigation', () => {
  function page(role: 'admin' | 'member', section: 'members' | 'profile') {
    return (
      <SettingsPage
        client={client()}
        viewer={viewer(role)}
        section={section}
        onNavigate={() => undefined}
        onSignOut={async () => undefined}
        onLeftOrg={() => undefined}
        onSwitchOrg={() => undefined}
        onCreateOrg={() => undefined}
      />
    );
  }

  function labels(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.settings-side-nav .settings-nav-button')]
      .map((node) => node.textContent ?? '');
  }

  it('carries five entries for an admin and mounts Members on the members address', async () => {
    const view = await render(page('admin', 'members'));
    await settle();
    expect(labels(view.container)).toEqual([
      'Profile', 'Members', 'Connections', 'Credentials', 'Compute',
    ]);
    expect(view.container.querySelector('[aria-label="Members"]')).not.toBeNull();
    // The four sections this page absorbed or retired name nothing here.
    for (const gone of ['Members', 'Invites', 'Requests', 'Usage']) {
      expect(labels(view.container)).not.toContain(gone);
    }
    await view.unmount();
  });

  it('drops Compute for a member and keeps Members', async () => {
    const view = await render(page('member', 'profile'));
    await settle();
    expect(labels(view.container)).toEqual(['Profile', 'Members', 'Connections', 'Credentials']);
    await view.unmount();
  });
});
