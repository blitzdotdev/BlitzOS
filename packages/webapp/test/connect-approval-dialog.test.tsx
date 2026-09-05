/**
 * The connect ask an agent raises in the workspace
 * (`src/ConnectApprovalDialog.tsx`).
 *
 * It wears `AccessApprovalDialog`'s frame on purpose: one "an agent is asking"
 * shape, whatever is being asked for. What this suite pins is the part that is
 * its own — the ask card built from a `CredentialRequestView`, the three
 * shapes the primary action takes, and that neither the close button nor
 * "Not now" answers the server.
 */
import type { CatalogEntryView, CredentialRequestView, UserGrantView } from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import {
  ConnectApprovalDialog,
  type ConnectDialogWorkspace,
} from '../src/ConnectApprovalDialog.js';
import { render, settle } from './dom.js';

const request: CredentialRequestView = {
  id: 'request-one',
  workspace_id: 'workspace-one',
  connection_name: 'linear',
  requested_scopes: ['issues:read'],
  created_at: 1_787_000_000_000,
  requester: { boxId: 'machine-ada', userId: 'user-ada' },
};

const workspace: ConnectDialogWorkspace = {
  id: 'workspace-one',
  name: 'payments',
  members: [{
    membershipId: 'membership-1',
    name: 'Ada Owner',
    machine: {
      id: 'machine-ada',
      state: 'running',
      machineTypeId: 'cx23@fsn1',
      volumeId: null,
      volumeUsedPercent: null,
      membershipId: 'membership-1',
      error: null,
      createdAt: 1,
      updatedAt: 1,
    },
  }],
};

function entry(overrides: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return {
    id: 'linear',
    title: 'Linear',
    summary: 'Issues for agents',
    custody: 'proxy',
    oauthAvailable: true,
    oauthConfigured: true,
    personalTokenLabel: null,
    personalTokenFallbackOnly: false,
    personalTokenHelp: null,
    personalTokenBaseUrlLabel: null,
    adminForm: null,
    ...overrides,
  };
}

const grant: UserGrantView = {
  provider: 'linear',
  manifestId: 'linear',
  kind: 'oauth',
  label: null,
  scopes: [],
  createdAt: 1,
  updatedAt: 1,
  accessExpiresAt: null,
};

function client(
  providers: CatalogEntryView[],
  grants: UserGrantView[],
  overrides: Partial<ControlPlaneClient> = {},
): ControlPlaneClient {
  return {
    listConnectionCatalog: vi.fn(async () => ({ providers })),
    listConnectionGrants: vi.fn(async () => ({ grants })),
    mintWorkspaceConnection: vi.fn(async () => ({ lease: null })),
    connectStartUrl: (provider: string, workspaceId?: string) =>
      `/connect/${provider}/start?workspaceId=${workspaceId ?? ''}`,
    ...overrides,
    // SAFETY: the dialog reaches for the catalog, the grants and one mint.
  } as unknown as ControlPlaneClient;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label);
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

describe('ConnectApprovalDialog', () => {
  it('renders the ask from one pending request', async () => {
    const view = await render(
      <ConnectApprovalDialog
        client={client([entry()], [])}
        request={request}
        workspace={workspace}
        onDismiss={() => undefined}
        onConnected={() => undefined}
      />,
    );
    await settle();

    expect(view.container.querySelector('h1')?.textContent).toBe('Connect Linear?');
    const card = view.container.querySelector('.ga-req');
    // Whose machine and which workspace, off the request's `requester`.
    expect(card?.textContent).toContain("on Ada Owner's machine");
    expect(card?.textContent).toContain('workspace payments');
    // No `reason` crosses the wire, so the quote is the ask itself.
    expect(card?.querySelector('.ga-req-why')?.textContent).toBe('“issues:read”');
    // The ask card is the whole body: no scopes editor, no workspace picker.
    expect(view.container.querySelector('.ga-body')).toBeNull();
    expect(view.container.textContent).not.toContain('What it gets');
    await view.unmount();
  });

  it('sends a member with no grant through the provider round trip', async () => {
    const view = await render(
      <ConnectApprovalDialog
        client={client([entry()], [])}
        request={request}
        workspace={workspace}
        onDismiss={() => undefined}
        onConnected={() => undefined}
      />,
    );
    await settle();

    const primary = view.container.querySelector('a.webapp-action--primary');
    expect(primary?.textContent).toBe('Connect Linear');
    expect(primary?.getAttribute('href'))
      .toBe('/connect/linear/start?workspaceId=workspace-one');
    expect(view.container.querySelector('.cfg-help')?.textContent)
      .toBe('You sign in at Linear; the agent never sees your password.');
    await view.unmount();
  });

  it('mints in one call when the member already authorized the provider', async () => {
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: null }));
    const onConnected = vi.fn();
    const view = await render(
      <ConnectApprovalDialog
        client={client([entry()], [grant], { mintWorkspaceConnection })}
        request={request}
        workspace={workspace}
        onDismiss={() => undefined}
        onConnected={onConnected}
      />,
    );
    await settle();

    await act(async () => button(view.container, 'Connect Linear').click());
    await settle();
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    expect(onConnected).toHaveBeenCalledWith(request);
    await view.unmount();
  });

  it('offers nothing to press for a provider an admin configures', async () => {
    const view = await render(
      <ConnectApprovalDialog
        client={client([entry({
          oauthAvailable: false,
          oauthConfigured: false,
          adminForm: { rootLabel: 'API key', rootHelp: 'one key for everyone', placements: [] },
        })], [])}
        request={{ ...request, connection_name: 'linear' }}
        workspace={workspace}
        onDismiss={() => undefined}
        onConnected={() => undefined}
      />,
    );
    await settle();

    expect(button(view.container, 'Connect Linear').disabled).toBe(true);
    expect(view.container.querySelector('.cfg-help')?.textContent)
      .toBe('An admin stores one Linear key for the organization.');
    await view.unmount();
  });

  it('waves the ask off without answering the server, from either control', async () => {
    const onDismiss = vi.fn();
    const mintWorkspaceConnection = vi.fn();
    const view = await render(
      <ConnectApprovalDialog
        client={client([entry()], [grant], { mintWorkspaceConnection })}
        request={request}
        workspace={workspace}
        onDismiss={onDismiss}
        onConnected={() => undefined}
      />,
    );
    await settle();

    await act(async () => button(view.container, 'Not now').click());
    const close = view.container.querySelector<HTMLButtonElement>('[aria-label="Close"]');
    await act(async () => close?.click());
    // Two dismissals, and neither approved, denied or minted anything: the
    // request stays pending and the agent asks again.
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(mintWorkspaceConnection).not.toHaveBeenCalled();
    await view.unmount();
  });
});
