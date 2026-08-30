/**
 * The phase-0 spike's platform composition root.
 *
 * Split out of `platform.tsx` in phase 2, where that file became the real
 * `BlitzPlatformProvider` fed by the daemon's own identity. This one exists only
 * for `SessionSurfaceSpike.tsx`, which renders vendored leaves from fixtures
 * with no daemon and no network. Both go away when `SessionSurface` lands
 * (plans/LODY-RUNTIME-DESIGN.md §4.5) and the spike's fixtures move to
 * `packages/webapp/test/` as render fixtures.
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

/** The settled signed-out Convex value their Storybook preview supplies. The
 * real provider keeps supplying it; see `platform.tsx`. */
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
