import type { GrantProposalView } from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { useGrantProposals } from '../src/use-grant-proposals.js';
import { render, settle } from './dom.js';

function proposal(id: string, membershipId: string, createdAt: number): GrantProposalView {
  return {
    id,
    state: 'pending',
    machineId: `machine-${id}`,
    membershipId,
    reason: 'because',
    proposed: [{ name: 'KEY', action: 'add', subjectKind: 'org', subjectId: null, access: 'read' }],
    applied: null,
    createdAt,
  };
}

/** The feed as an org admin receives it: their own agent's ask beside one
 * from another member's agent, the other one older. */
const FEED = [proposal('theirs', 'm-other', 1), proposal('mine', 'm-me', 2)];

let latest: ReturnType<typeof useGrantProposals> | null = null;

function Probe({ client, viewer }: { client: Pick<ControlPlaneClient, 'listGrantProposals'>; viewer: string | null }) {
  const feed = useGrantProposals(client, true, viewer);
  latest = feed;
  return (
    <p>
      pending={feed.pending.length};active={feed.active?.id ?? 'none'}
    </p>
  );
}

describe('useGrantProposals (plans/ORG-CREDENTIALS.md §7a: the pop-up is for the acting member)', () => {
  it('pops only the proposal the viewer\'s own agent filed, and keeps the whole feed for Requests', async () => {
    const client = { listGrantProposals: vi.fn(async () => ({ proposals: FEED })) };
    const view = await render(<Probe client={client} viewer="m-me" />);
    await settle();
    // The other member's proposal is older, and would have popped first
    // under "oldest pending wins"; it now waits in Requests instead.
    expect(view.container.textContent).toBe('pending=2;active=mine');

    // Dismissing leaves nothing to pop; the feed is untouched.
    await act(async () => latest?.dismiss('mine'));
    expect(view.container.textContent).toBe('pending=2;active=none');
    await view.unmount();
  });

  it('pops nothing for a viewer whose agent filed none of them', async () => {
    const client = { listGrantProposals: vi.fn(async () => ({ proposals: FEED })) };
    const view = await render(<Probe client={client} viewer="m-admin" />);
    await settle();
    expect(view.container.textContent).toBe('pending=2;active=none');
    await view.unmount();
  });
});
