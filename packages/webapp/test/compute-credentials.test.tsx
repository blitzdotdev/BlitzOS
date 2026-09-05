import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../src/api.js';
import { createControlPlaneClient } from '../src/api.js';
import type { TenantMe } from '../src/api-adapter.js';
import type {
  ComputeCredentialMetadata,
  ComputeCredentialProvider,
  ComputeCredentialsClient,
} from '../src/compute-credentials-api.js';
import { ComputeCredentialsPanel } from '../src/settings/ComputeCredentialsPanel.js';
import { SettingsPage } from '../src/SettingsPage.js';
import { render, settle } from './dom.js';

function missing(): ApiRequestError {
  return new ApiRequestError('compute credential not found', 404, null);
}

function client(overrides: Partial<ComputeCredentialsClient> = {}): ComputeCredentialsClient {
  return {
    getComputeCredential: vi.fn(async () => { throw missing(); }),
    putComputeCredential: vi.fn(async () => { throw new Error('unused'); }),
    deleteComputeCredential: vi.fn(async () => undefined),
    ...overrides,
  };
}

function providerCard(container: HTMLElement, label: string): HTMLElement {
  const card = Array.from(container.querySelectorAll<HTMLElement>('.settings-compute-card'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (card === undefined) throw new Error(`missing provider card: ${label}`);
  return card;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === label);
  if (match === undefined) throw new Error(`missing button: ${label}`);
  return match;
}

describe('compute credential settings', () => {
  it('exposes the settings section only to organization admins', async () => {
    const getComputeCredential = vi.fn(async () => { throw missing(); });
    const wire = {
      ...createControlPlaneClient('https://control.example'),
      getComputeCredential,
    };
    const identity = {
        id: 'user-one',
        email: 'admin@example.com',
        name: 'Admin',
        avatarUrl: null,
    };
    const membership = { id: 'membership-one', role: 'member' as const };
    const org = { id: 'org-one', slug: 'org-one', name: 'Org One', vmLimit: 2 };
    const viewer: TenantMe = {
      identity,
      membership,
      org,
      organizations: [{ membership, org }],
    };
    const common = {
      client: wire,
      onNavigate: () => undefined,
      onSignOut: async () => undefined,
      onLeftOrg: () => undefined,
      onSwitchOrg: () => undefined,
      onCreateOrg: () => undefined,
    };
    const memberView = await render(
      <SettingsPage {...common} viewer={viewer} section="profile" />,
    );
    expect(memberView.container.textContent).not.toContain('Compute');
    // The Discord link left the strip's account menu; settings navigation
    // carries it now.
    const discord = memberView.container.querySelector<HTMLAnchorElement>(
      '.settings-side a[href^="https://discord.gg/"]',
    );
    expect(discord?.textContent).toBe('Ask us on Discord');
    await memberView.unmount();

    const adminView = await render(
      <SettingsPage
        {...common}
        viewer={{ ...viewer, membership: { ...viewer.membership, role: 'admin' } }}
        section="compute"
      />,
    );
    await settle();
    expect(adminView.container.querySelector('[aria-label="Compute credentials"]')).not.toBeNull();
    expect(getComputeCredential).toHaveBeenCalledTimes(2);
    await adminView.unmount();
  });

  it('passes a pasted Hetzner token once and shows validation errors verbatim', async () => {
    const putComputeCredential = vi.fn(async () => {
      throw new ApiRequestError('Hetzner says this token is invalid', 400, null);
    });
    const wire = client({ putComputeCredential });
    const view = await render(<ComputeCredentialsPanel client={wire} orgId="org one" />);
    await settle();

    const card = providerCard(view.container, 'Hetzner Cloud');
    await act(async () => button(card, 'Add key').click());
    const input = card.querySelector<HTMLInputElement>('input[name="token"]')!;
    input.value = 'one-use-secret';
    await act(async () => {
      card.querySelector('form')?.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true,
      }));
    });
    await settle();

    expect(putComputeCredential).toHaveBeenCalledWith(
      'org one',
      'hetzner',
      { token: 'one-use-secret' },
    );
    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('Hetzner says this token is invalid');
    await view.unmount();
  });

  it('replaces the paste form with metadata and never renders the saved key', async () => {
    const metadata: ComputeCredentialMetadata = {
      provider: 'hetzner',
      validated_at: 1_700_000_000_000,
      created_by: 'membership-one',
    };
    const putComputeCredential = vi.fn(async () => metadata);
    const wire = client({ putComputeCredential });
    const view = await render(<ComputeCredentialsPanel client={wire} orgId="org-one" />);
    await settle();

    const card = providerCard(view.container, 'Hetzner Cloud');
    await act(async () => button(card, 'Add key').click());
    card.querySelector<HTMLInputElement>('input[name="token"]')!.value = 'never-render-this-key';
    await act(async () => {
      card.querySelector('form')?.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true,
      }));
    });
    await settle();

    expect(card.textContent).toContain('validated');
    expect(card.querySelector('time')?.dateTime).toBe('2023-11-14T22:13:20.000Z');
    expect(card.querySelector('form')).toBeNull();
    expect(view.container.textContent).not.toContain('never-render-this-key');
    await view.unmount();
  });

  it('submits the AWS key fields without inventing an absent session token', async () => {
    const metadata: ComputeCredentialMetadata = {
      provider: 'aws',
      validated_at: 1_700_000_000_000,
      created_by: 'membership-one',
    };
    const putComputeCredential = vi.fn(async () => metadata);
    const wire = client({ putComputeCredential });
    const view = await render(<ComputeCredentialsPanel client={wire} orgId="org-one" />);
    await settle();

    const card = providerCard(view.container, 'Amazon Web Services');
    await act(async () => button(card, 'Add key').click());
    card.querySelector<HTMLInputElement>('input[name="accessKeyId"]')!.value = 'access-key-id';
    card.querySelector<HTMLInputElement>('input[name="secretAccessKey"]')!.value = 'secret-key';
    await act(async () => {
      card.querySelector('form')?.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true,
      }));
    });
    await settle();

    expect(putComputeCredential).toHaveBeenCalledWith('org-one', 'aws', {
      accessKeyId: 'access-key-id',
      secretAccessKey: 'secret-key',
    });
    expect(view.container.textContent).not.toContain('secret-key');
    await view.unmount();
  });

  it('loads metadata and deletes only after confirmation', async () => {
    const stored: ComputeCredentialMetadata = {
      provider: 'aws',
      validated_at: 1_700_000_000_000,
      created_by: 'membership-one',
    };
    const getComputeCredential = vi.fn(async (
      _orgId: string,
      provider: ComputeCredentialProvider,
    ) => {
      if (provider === 'aws') return stored;
      throw missing();
    });
    const deleteComputeCredential = vi.fn(async () => undefined);
    const wire = client({ getComputeCredential, deleteComputeCredential });
    const view = await render(<ComputeCredentialsPanel client={wire} orgId="org-one" />);
    await settle();

    const card = providerCard(view.container, 'Amazon Web Services');
    await act(async () => button(card, 'Delete').click());
    expect(document.querySelector('[role="dialog"]')?.textContent)
      .toContain('Existing machines keep running');
    await act(async () => button(document.body, 'Delete credential').click());
    await settle();

    expect(deleteComputeCredential).toHaveBeenCalledWith('org-one', 'aws');
    expect(button(card, 'Add key')).not.toBeNull();
    await view.unmount();
  });
});
