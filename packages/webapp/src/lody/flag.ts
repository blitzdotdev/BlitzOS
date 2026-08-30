/**
 * The Lody sessions kill switch (plans/LODY-SESSIONS.md §9).
 *
 * Default OFF. Every phase of the port ships dark behind this flag until the
 * canary flip in phase 7, so a half-built session plane can never reach a
 * workspace by accident. Off must mean the Lody chunk is never fetched — one
 * static import from `CloudApp.tsx` would silently pull 3.5 MB into the entry
 * graph — so this gates a dynamic import, the `window.ipc` install, and the
 * compensation stylesheet alike.
 *
 * ONE NAME ON BOTH SIDES. The box reads `BLITZ_LODY_SESSIONS` (the s6 run
 * scripts for `lody-daemon` and `lody-bridge`, and `env.defaults`), and phase 1
 * shipped it under that name. The webapp reads `VITE_BLITZ_LODY_SESSIONS`, which
 * is the same name with the prefix Vite requires to expose a variable to the
 * browser. They are deliberately the same word: a member turning sessions on for
 * a workspace should not have to learn that the box and the app disagree about
 * what the feature is called.
 *
 * The two are still SEPARATE switches, and that is correct: the flag on the box
 * decides whether the daemon runs (it costs ~300 MiB resident), the flag in the
 * build decides whether the browser can reach it. Turning the app on against a
 * box with the daemon off gives a surface whose sync socket 502s, which is the
 * honest failure. Phase 7 flips both together on canary.
 *
 * Turn it on for local work with
 * `VITE_BLITZ_LODY_SESSIONS=true npm run dev -w @blitzos/webapp`.
 */
export const LODY_SESSIONS_ENABLED: boolean =
  import.meta.env.VITE_BLITZ_LODY_SESSIONS === "true";

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
