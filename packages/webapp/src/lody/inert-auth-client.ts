/**
 * A `LodyAuthClient` that answers "signed out" and never reaches the network.
 *
 * WHY IT EXISTS. `SessionDetail` calls `useWorkspaceMembers`
 * (`session-detail.tsx:1674`), which calls `useAuthClient()`
 * (`hooks/use-workspace-members.ts:26`) with no local-platform branch, so their
 * `AuthProvider` context is mandatory for the session page — the chat landing
 * gets away without it, the session page does not. This was risk 2 in
 * `plans/LODY-RUNTIME-DESIGN.md`, and it is the only provider the phase-3 mount
 * needed beyond what phase 2 already supplied.
 *
 * WHY NOT A REAL CLIENT. `createLodyAuthClient` (`lib/auth.ts:24`) is
 * better-auth pointed at `VITE_CONVEX_SITE_URL`, and its read hooks FETCH on
 * subscribe: `authClient.useActiveOrganization()` would issue a cloud request
 * from a composition whose whole contract is zero cloud I/O.
 *
 * WHAT "SIGNED OUT" MEANS HERE. Lody's cloud identity is genuinely absent: the
 * daemon owns the identity (`platform.tsx`), membership and roles stay in D1,
 * and session sharing reaches Lody in phase 6 through the gateway ticket rather
 * than through better-auth. A settled `null` is therefore the truth, not a
 * placeholder — the same reason the Convex context is the settled signed-out
 * value from their own Storybook preview.
 *
 * WHAT HAPPENS TO EVERYTHING ELSE. Only the four reads the mounted surface
 * performs exist. Any other member — `organization.*`, `signIn`, `linkSocial`,
 * the fourteen more their settings pages use — is simply absent, so an upstream
 * call site that appears at the next merge throws a TypeError naming the
 * property it wanted. That is deliberate, and it is the same rule the
 * `window.ipc` allowlist follows: fail loudly rather than answer a fabrication.
 */

/** A settled better-auth query result with no data. */
export interface LodyEmptyAuthQuery {
  data: null;
  error: null;
  isPending: false;
  isRefetching: false;
}

/** The four reads the mounted session surface performs, and nothing else. */
export interface LodyInertAuthClient {
  useSession: () => LodyEmptyAuthQuery & { refetch: () => Promise<void> };
  useActiveOrganization: () => LodyEmptyAuthQuery;
  useListOrganizations: () => Omit<LodyEmptyAuthQuery, "data"> & { data: readonly never[] };
  getSession: () => Promise<{ data: null; error: null }>;
}

const EMPTY_QUERY: LodyEmptyAuthQuery = {
  data: null,
  error: null,
  isPending: false,
  isRefetching: false,
};

/**
 * Builds the client. One per surface; it holds no state, so the instance
 * identity only matters because `AuthProvider` memoizes on it.
 */
export function createInertLodyAuthClient(): LodyInertAuthClient {
  return {
    useSession: () => ({ ...EMPTY_QUERY, refetch: () => Promise.resolve() }),
    useActiveOrganization: () => EMPTY_QUERY,
    useListOrganizations: () => ({ ...EMPTY_QUERY, data: [] }),
    getSession: () => Promise.resolve({ data: null, error: null }),
  };
}
