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
 * The session surface's address while the rail cannot reach it: `#lody` with
 * the flag on.
 *
 * Phase 4 replaces this with a rail selection, and phase 3 deliberately does not
 * touch the rail. Until then the hash is the whole entry point, and it is a hash
 * rather than a route so nothing in `sessions-page-state.ts` learns about chat
 * sessions before phase 4 decides how they are addressed.
 *
 * Two surfaces read it. `CloudApp` shows the mounted surface over the panes for
 * a real workspace; `main.tsx` mounts it standalone against
 * `VITE_BLITZ_LODY_DEV_ORIGIN` when there is no control plane to log into.
 */
export const LODY_SESSIONS_HASH = "#lody";

export function lodySessionsRequested(hash: string): boolean {
  return LODY_SESSIONS_ENABLED && hash === LODY_SESSIONS_HASH;
}

/**
 * A box origin to drive the surface against with no control plane, for local
 * development: the daemon, `blitz-lody-bridge` and a gateway stand-in on one
 * loopback port, exactly the three processes
 * `packages/webapp/test/lody-daemon-harness.ts` starts.
 *
 * Empty in every build that does not set it, which is every build.
 */
export const LODY_DEV_ORIGIN: string =
  import.meta.env.VITE_BLITZ_LODY_DEV_ORIGIN ?? "";
