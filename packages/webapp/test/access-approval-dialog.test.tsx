import type { GrantProposalView, OrgCredentialView } from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import {
  AccessApprovalDialog,
  proposalOrigin,
  type ApprovalWorkspace,
} from '../src/AccessApprovalDialog.js';
import {
  approvalGroups,
  approvedChanges,
  initialEdits,
  isEdited,
} from '../src/access-approval-model.js';
import { render, settle } from './dom.js';

/** The mock's scenario (plans/mockups/grant-approval.html), on the wire. */
function credential(name: string, comment: string, grants: OrgCredentialView['grants']): OrgCredentialView {
  return {
    id: `cred-${name}`,
    name,
    comment,
    createdByMembershipId: 'me',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    grants,
  };
}

const credentials: OrgCredentialView[] = [
  credential('STRIPE_API_KEY', 'live key; card charges', [
    { subjectKind: 'workspace', subjectId: 'ws-payments', access: 'read' },
    { subjectKind: 'membership', subjectId: 'me', access: 'write' },
  ]),
  credential('STRIPE_WEBHOOK_SECRET', 'endpoint secret for webhook signatures', [
    { subjectKind: 'workspace', subjectId: 'ws-payments', access: 'read' },
    { subjectKind: 'membership', subjectId: 'me', access: 'write' },
    { subjectKind: 'membership', subjectId: 'priya', access: 'write' },
  ]),
  credential('SENTRY_DSN', 'error reporting, all services', [
    { subjectKind: 'org', subjectId: null, access: 'read' },
    { subjectKind: 'membership', subjectId: 'me', access: 'write' },
  ]),
];

const proposal: GrantProposalView = {
  id: 'proposal-1',
  state: 'pending',
  machineId: 'machine-me',
  membershipId: 'me',
  reason: 'api-v2 runs the same Stripe integration tests, and Dana takes over key rotation this sprint.',
  proposed: [
    { name: 'STRIPE_API_KEY', action: 'add', subjectKind: 'workspace', subjectId: 'ws-apiv2', access: 'read' },
    { name: 'STRIPE_API_KEY', action: 'add', subjectKind: 'membership', subjectId: 'dana', access: 'write' },
    { name: 'STRIPE_WEBHOOK_SECRET', action: 'remove', subjectKind: 'membership', subjectId: 'priya', access: 'write' },
    { name: 'SENTRY_DSN', action: 'add', subjectKind: 'workspace', subjectId: 'ws-apiv2', access: 'read' },
  ],
  applied: null,
  createdAt: 1_700_000_000_000,
};

const workspaces: ApprovalWorkspace[] = [
  {
    id: 'ws-payments',
    name: 'payments',
    members: [{
      membershipId: 'me',
      name: 'Ada Owner',
      machine: {
        id: 'machine-me',
        state: 'running',
        machineTypeId: 'cx23@fsn1',
        volumeId: null,
        volumeUsedPercent: null,
        payloadVersion: null,
        daemonVersion: null,
        payloadOutcome: null,
        payloadReportedAt: null,
        membershipId: 'me',
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
    }],
  },
  { id: 'ws-apiv2', name: 'api-v2', members: [] },
];

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listOrgCredentials: vi.fn().mockResolvedValue({ credentials }),
    listMembers: vi.fn().mockResolvedValue({
      members: [
        { id: 'me', email: 'ada@example.com', name: 'Ada Owner', avatarUrl: null, role: 'member', status: 'active' },
        { id: 'dana', email: 'dana@example.com', name: 'Dana Reyes', avatarUrl: null, role: 'member', status: 'active' },
        { id: 'priya', email: 'priya@example.com', name: 'Priya N', avatarUrl: null, role: 'member', status: 'active' },
      ],
    }),
    resolveGrantProposal: vi.fn(async (_id: string, input: { approve: boolean; changes: GrantProposalView['proposed'] }) => ({
      proposal: {
        ...proposal,
        state: input.approve ? 'approved' : 'denied',
        applied: input.approve ? input.changes : [],
      },
    })),
    ...overrides,
    // SAFETY: the dialog reaches for exactly the three methods above.
  } as unknown as ControlPlaneClient;
}

function dialog(overrides: Partial<Parameters<typeof AccessApprovalDialog>[0]> = {}) {
  return (
    <AccessApprovalDialog
      client={client()}
      proposal={proposal}
      viewer={{ membershipId: 'me', orgName: 'acme' }}
      workspaces={workspaces}
      onClose={() => undefined}
      onResolved={() => undefined}
      {...overrides}
    />
  );
}

function group(root: ParentNode, name: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(`[aria-label="Access to ${name}"]`);
  if (found === null) throw new Error(`no group for ${name}`);
  return found;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (found === undefined || found === null) throw new Error(`no button "${label}"`);
  return found;
}

function approveButton(root: ParentNode): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.startsWith('Approve') || candidate.textContent === 'Nothing to approve');
  if (found === undefined) throw new Error('no approve button');
  return found;
}

describe('access-approval model', () => {
  it('merges the access a credential already has with the changes, and flags a redundant addition', () => {
    const groups = approvalGroups(proposal, initialEdits(proposal), credentials);
    expect(groups.map(({ name }) => name)).toEqual(['STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN']);
    expect(groups[0]?.rows.map(({ kind }) => kind)).toEqual(['kept', 'kept', 'addition', 'addition']);
    expect(groups[1]?.rows.map(({ kind }) => kind)).toEqual(['kept', 'kept', 'removal']);
    const sentry = groups[2]?.rows.at(-1);
    expect(sentry?.kind === 'addition' && sentry.hint).toBe('covered by org-wide read');
    expect(isEdited(proposal, initialEdits(proposal))).toBe(false);
  });

  it('shows a removal the viewer cannot see, so nothing proposed is hidden', () => {
    const groups = approvalGroups(proposal, initialEdits(proposal), []);
    expect(groups[1]?.rows).toEqual([{
      kind: 'removal', changeIndex: 2, subjectKind: 'membership', subjectId: 'priya', access: 'write',
    }]);
  });

  it('resolves the origin from the machine that asked', () => {
    expect(proposalOrigin(proposal, workspaces)).toEqual({ workspaceName: 'payments', memberName: 'Ada Owner' });
    expect(proposalOrigin({ machineId: 'nope', membershipId: 'me' }, workspaces))
      .toEqual({ workspaceName: null, memberName: null });
  });
});

describe('AccessApprovalDialog', () => {
  it('draws the request card and one merged list per credential', async () => {
    const view = await render(dialog());
    await settle();

    expect(view.container.querySelector('.ga-req')?.textContent).toContain('workspace payments');
    expect(view.container.querySelector('.ga-req-why')?.textContent).toBe(`“${proposal.reason}”`);
    // Every credential is a plain label with its comment; every row a kind tag.
    expect(view.container.textContent).toContain('live key; card charges');
    const stripe = group(view.container, 'STRIPE_API_KEY');
    expect([...stripe.querySelectorAll('.ga-tag')].map((tag) => tag.textContent))
      .toEqual(['workspace', 'member', 'workspace', 'member']);
    expect(stripe.querySelectorAll('.ga-row--add')).toHaveLength(2);
    expect(group(view.container, 'STRIPE_WEBHOOK_SECRET').querySelectorAll('.ga-row--del')).toHaveLength(1);
    expect(group(view.container, 'SENTRY_DSN').textContent).toContain('covered by org-wide read');
    expect(approveButton(view.container).textContent).toBe('Approve 4 changes');
    expect(approveButton(view.container).disabled).toBe(false);
    expect(view.container.textContent).not.toContain('Restore proposal');
    await view.unmount();
  });

  it('approves exactly the edited set: one row skipped, one write downgraded', async () => {
    const resolveGrantProposal = vi.fn(async () => ({
      proposal: { ...proposal, state: 'approved' as const, applied: proposal.proposed.slice(0, 3) },
    }));
    const onResolved = vi.fn();
    const view = await render(dialog({ client: client({ resolveGrantProposal }), onResolved }));
    await settle();

    // Skip the redundant SENTRY_DSN addition; it fades to an outlined no-op.
    await act(async () => button(group(view.container, 'SENTRY_DSN'), 'Skip the access for api-v2').click());
    expect(group(view.container, 'SENTRY_DSN').querySelector('.ga-row--skip')).not.toBeNull();
    // Dana gets read, not write.
    const dana = group(view.container, 'STRIPE_API_KEY').querySelector('[aria-label="Access for Dana Reyes"]');
    if (dana === null) throw new Error('no access toggle for Dana');
    await act(async () => button(dana, 'read').click());
    expect(approveButton(view.container).textContent).toBe('Approve 3 changes (edited)');
    expect(view.container.textContent).toContain('Restore proposal');

    await act(async () => approveButton(view.container).click());
    expect(resolveGrantProposal).toHaveBeenCalledWith('proposal-1', {
      approve: true,
      changes: [
        { name: 'STRIPE_API_KEY', action: 'add', subjectKind: 'workspace', subjectId: 'ws-apiv2', access: 'read' },
        { name: 'STRIPE_API_KEY', action: 'add', subjectKind: 'membership', subjectId: 'dana', access: 'read' },
        { name: 'STRIPE_WEBHOOK_SECRET', action: 'remove', subjectKind: 'membership', subjectId: 'priya', access: 'write' },
      ],
    });
    await settle();
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ state: 'approved' }));
    expect(view.container.querySelector('.ga-done')).toBeNull();
    await view.unmount();
  });

  it('keeps a removal on skip, restores the proposal, and disables approve at zero', async () => {
    const view = await render(dialog());
    await settle();

    await act(async () => button(group(view.container, 'STRIPE_WEBHOOK_SECRET'), 'Keep the access for Priya N').click());
    // The kept row is plain again, with an undo.
    expect(group(view.container, 'STRIPE_WEBHOOK_SECRET').querySelector('.ga-row--del')).toBeNull();
    expect(group(view.container, 'STRIPE_WEBHOOK_SECRET').querySelector('[aria-label="Re-apply removal of Priya N"]')).not.toBeNull();
    expect(approveButton(view.container).textContent).toBe('Approve 3 changes (edited)');

    await act(async () => button(view.container, 'Restore proposal').click());
    expect(approveButton(view.container).textContent).toBe('Approve 4 changes');

    for (const label of ['Skip the access for api-v2', 'Skip the access for Dana Reyes']) {
      await act(async () => button(group(view.container, 'STRIPE_API_KEY'), label).click());
    }
    await act(async () => button(group(view.container, 'STRIPE_WEBHOOK_SECRET'), 'Keep the access for Priya N').click());
    await act(async () => button(group(view.container, 'SENTRY_DSN'), 'Skip the access for api-v2').click());
    expect(approveButton(view.container).textContent).toBe('Nothing to approve');
    expect(approveButton(view.container).disabled).toBe(true);
    await view.unmount();
  });

  it('rejects all with approve false and no changes', async () => {
    const resolveGrantProposal = vi.fn(async () => ({
      proposal: { ...proposal, state: 'denied' as const, applied: [] },
    }));
    const onResolved = vi.fn();
    const view = await render(dialog({ client: client({ resolveGrantProposal }), onResolved }));
    await settle();

    await act(async () => button(view.container, 'Reject all').click());
    expect(resolveGrantProposal).toHaveBeenCalledWith('proposal-1', { approve: false, changes: [] });
    await settle();
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ state: 'denied' }));
    expect(view.container.querySelector('.ga-done')).toBeNull();
    await view.unmount();
  });

  it('closes without resolving: the proposal stays pending', async () => {
    const resolveGrantProposal = vi.fn();
    const onClose = vi.fn();
    const view = await render(dialog({ client: client({ resolveGrantProposal }), onClose }));
    await settle();

    await act(async () => button(view.container, 'Close').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(resolveGrantProposal).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('derives the resolve payload from the edits alone', () => {
    const edits = initialEdits(proposal);
    edits[0] = { skipped: true, access: 'read' };
    edits[1] = { skipped: false, access: 'read' };
    expect(approvedChanges(proposal, edits)).toEqual([
      { name: 'STRIPE_API_KEY', action: 'add', subjectKind: 'membership', subjectId: 'dana', access: 'read' },
      { name: 'STRIPE_WEBHOOK_SECRET', action: 'remove', subjectKind: 'membership', subjectId: 'priya', access: 'write' },
      { name: 'SENTRY_DSN', action: 'add', subjectKind: 'workspace', subjectId: 'ws-apiv2', access: 'read' },
    ]);
    expect(isEdited(proposal, edits)).toBe(true);
  });
});
