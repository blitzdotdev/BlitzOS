/**
 * The Lody sessions kill switch (plans/LODY-SESSIONS.md §9).
 *
 * Default OFF. Every phase of the port ships dark behind this flag until the
 * canary flip in phase 7, so a half-built session plane can never reach a
 * workspace by accident. Turn it on for local work with
 * `VITE_LODY_SESSIONS_ENABLED=true npm run dev -w @blitzos/webapp`.
 */
export const LODY_SESSIONS_ENABLED: boolean =
  import.meta.env.VITE_LODY_SESSIONS_ENABLED === "true";

/**
 * The phase-0 spike surface's address: `#lody-spike` with the flag on.
 *
 * Deliberately a hash and not a route — the spike renders vendored components
 * from fixtures with no daemon and no network, so it must not be reachable
 * from the product's own navigation.
 */
export const LODY_SPIKE_HASH = "#lody-spike";

export function lodySpikeRequested(hash: string): boolean {
  return LODY_SESSIONS_ENABLED && hash === LODY_SPIKE_HASH;
}
