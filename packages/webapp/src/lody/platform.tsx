/**
 * The phase-0 platform composition root for the vendored Lody renderer.
 *
 * `PlatformContext` deliberately has no default value upstream, so every
 * surface that mounts their components has to supply one explicitly; their own
 * tests do it through `vendor/lody/packages/components/tests/test-platform.tsx`.
 * This is the same pattern with the composition plans/LODY-SESSIONS.md §3 picks
 * for BlitzOS: the `local` provider, capabilities from their local set, and
 * `cloudApi: null` — Lody cloud (Convex, better-auth, billing, telemetry) is
 * capability-gated off and stays off.
 *
 * Phase 2 replaces this with the real `BlitzPlatformProvider` fed by our auth.
 */
import type { ReactNode } from "react";
import { createLocalPlatformProvider, createStaticStore } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { AuthenticatedConvexContext } from "@lody/components/hooks/use-authenticated-convex";
import type { AuthenticatedConvexValue } from "./spike-types";

const SPIKE_USER_ID = "local:blitz-phase0";
const SPIKE_WORKSPACE_ID = "lw_blitz_phase0";

const spikePlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: "authenticated",
    user: { id: SPIKE_USER_ID, name: "Phase 0 spike", image: null },
  }),
  workspaces: createStaticStore({
    status: "ready",
    workspaces: [
      { id: SPIKE_WORKSPACE_ID, name: "Phase 0 spike", slug: "phase0", role: "owner" },
    ],
    activeWorkspaceId: SPIKE_WORKSPACE_ID,
  }),
});

/**
 * A settled signed-out Convex auth state.
 *
 * `useAuthenticatedConvex` throws without a provider, and the mention sources
 * behind the composer read it even though `cloudApi` is null — capability
 * gating does not reach that far. Their Storybook preview
 * (`vendor/lody/packages/components/.storybook/preview.tsx`) supplies exactly
 * this value so those hooks take their offline path instead of throwing, and
 * the real `BlitzPlatformProvider` will have to keep supplying it in phase 2.
 */
const signedOutConvex: AuthenticatedConvexValue = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: true,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

export function LodySpikePlatformProvider({ children }: { children: ReactNode }) {
  return (
    <PlatformContext.Provider value={spikePlatform}>
      <AuthenticatedConvexContext.Provider value={signedOutConvex}>
        {children}
      </AuthenticatedConvexContext.Provider>
    </PlatformContext.Provider>
  );
}
