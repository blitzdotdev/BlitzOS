import type { GrantProposalView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient } from './api';

/** The approval feed's poll cadence: the idle cadence of the connect-inbox
 * poll it sits beside, because a proposal waits on a person either way. */
export const ACCESS_PROPOSAL_POLL_MS = 15_000;

export type AccessProposalFeed = {
  /** Every pending proposal addressed to the signed-in member. */
  pending: GrantProposalView[];
  /** The one the dialog shows: the oldest pending proposal not closed
   * without a decision, or null. */
  active: GrantProposalView | null;
  /** Close without deciding: the proposal stays pending on the server and
   * stops popping until the requests feed reopens it. */
  dismiss: (proposalId: string) => void;
  reopen: (proposalId: string) => void;
  /** The server settled it; drop it from the feed at once. */
  settled: (proposal: GrantProposalView) => void;
};

/** Polls the pending-only `GET /orgs/self/grant-proposals` feed on the
 * connect-inbox idiom (plans/ORG-CREDENTIALS.md §7a): one request in flight,
 * only while the tab is visible, aborted on unmount.
 *
 * The route and `GrantProposalView` keep the wire's word; everything a member
 * reads says access. */
export function useAccessProposals(
  client: Pick<ControlPlaneClient, 'listGrantProposals'>,
  enabled: boolean,
  /** The signed-in member. Only a proposal their own agent filed pops the
   * dialog; the rest of the feed (an admin sees the whole org's) waits in
   * Requests, where Review opens it on purpose. */
  viewerMembershipId: string | null,
): AccessProposalFeed {
  const [pending, setPending] = useState<GrantProposalView[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!enabled) {
      setPending([]);
      return;
    }
    let disposed = false;
    let request: AbortController | null = null;
    const poll = async () => {
      if (request || document.visibilityState !== 'visible') return;
      request = new AbortController();
      const current = request;
      try {
        const response = await client.listGrantProposals(current.signal);
        if (!disposed && request === current && !current.signal.aborted) {
          setPending(response.proposals);
        }
      } catch {
        // A failed poll changes nothing; the next tick asks again.
      } finally {
        if (request === current) request = null;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, ACCESS_PROPOSAL_POLL_MS);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
    };
  }, [client, enabled]);

  const dismiss = useCallback((proposalId: string) => {
    setDismissed((current) => new Set([...current, proposalId]));
  }, []);
  const reopen = useCallback((proposalId: string) => {
    setDismissed((current) => {
      const next = new Set(current);
      next.delete(proposalId);
      return next;
    });
  }, []);
  const settled = useCallback((proposal: GrantProposalView) => {
    setPending((current) => current.filter(({ id }) => id !== proposal.id));
  }, []);

  const active = pending
    .filter(({ id, membershipId }) => !dismissed.has(id) && membershipId === viewerMembershipId)
    .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;

  return { pending, active, dismiss, reopen, settled };
}
