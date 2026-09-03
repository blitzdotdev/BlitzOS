/**
 * `BlitzPlatformProvider` — the platform composition root for the vendored Lody
 * renderer (plans/LODY-RUNTIME-DESIGN.md §1).
 *
 * `PlatformContext` deliberately has no default upstream, so every surface that
 * mounts their components supplies one. Ours is the LOCAL composition, because
 * the box daemon runs the local composition too (`LODY_PLATFORM=local`), and the
 * two must agree: `createLocalCloudPort`'s access oracle only ever allows the
 * daemon's own `local:<uuid>` owner.
 *
 * WHAT OUR AUTH CONTRIBUTES: a display name, an avatar and a workspace title.
 * Nothing else. `PlatformUser.id` is the daemon's id, not a BlitzOS membership
 * id — membership, roles and sharing stay in D1 and reach Lody in phase 6
 * through the gateway ticket, never through `PlatformProvider`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { createCapabilitySet, createLocalPlatformProvider, createStore } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { boxGatewayHealth, boxGatewayPollIntervalMs } from "../box-gateway-health.js";
import { lodyExtraCapabilities } from "./v1-scope.js";
import { AuthenticatedConvexContext } from "@lody/components/hooks/use-authenticated-convex";
import { AuthProvider } from "@lody/components/providers/convex-provider";
import { createInertConvexClient } from "./inert-convex.js";
import { createInertLodyAuthClient, type LodyInertAuthClient } from "./inert-auth-client.js";
import {
  fetchLodyPlatformSnapshot,
  LodyPlatformCatalogError,
  type LodyPlatformFetchOptions,
  type LodyPlatformSnapshot,
} from "./platform-snapshot.js";

/** The poll cadence upstream uses for the same snapshot
 * (`providers/local-platform-provider.ts:29`). The daemon writes its catalog
 * only after it provisions the implicit workspace, so the first read of a cold
 * box misses. */
const SNAPSHOT_POLL_INTERVAL_MS = 500;

/**
 * A settled signed-out Convex auth state, byte-for-byte their Storybook preview
 * (`vendor/lody/packages/components/.storybook/preview.tsx:108`).
 *
 * `useAuthenticatedConvex` throws without a provider and capability gating does
 * not reach it: the composer's mention sources read it even though `cloudApi` is
 * null. `isAuthenticated: false` makes `useRecoverableConvexQuery` take `skip`;
 * `confirmedUnauthenticated: true` stops anything that would otherwise wait for
 * an auth transition that is never coming.
 */
const SIGNED_OUT_CONVEX = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: true,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

export interface BlitzViewer {
  /** The member's display name, from our auth. */
  name: string;
  /** The member's avatar, from our auth. `null` is fine. */
  avatarUrl: string | null;
}

export interface BlitzPlatformProviderProps {
  /** `BoxEndpoints.lodyPlatformUrl`. */
  platformUrl: string;
  viewer: BlitzViewer;
  /** The BlitzOS workspace title. Replaces the daemon's own "Lody". */
  workspaceTitle: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Called once the daemon's identity settles, so the runtime can mount. */
  onSnapshot?: (snapshot: LodyPlatformSnapshot) => void;
  children: ReactNode;
}

export interface LodyPlatformSnapshotState {
  /** `null` while the daemon has not provisioned its workspace yet. */
  snapshot: LodyPlatformSnapshot | null;
  /** A malformed catalog, which is a different fact from "not ready". */
  error: string | null;
}

/** Polls `/lody/platform` until the daemon's identity settles. */
export function useLodyPlatformSnapshot(
  platformUrl: string,
  fetchImpl?: typeof fetch,
): LodyPlatformSnapshotState {
  const [snapshot, setSnapshot] = useState<LodyPlatformSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const options: LodyPlatformFetchOptions = { signal: controller.signal };
    if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;
    // ONE READ IN FLIGHT AT A TIME, AND THE NEXT ONE SCHEDULED WHEN IT LANDS
    // (BUG-CV-01). This was a `setInterval`, which fires on the clock whether
    // or not the previous read has answered. Against a box whose tunnel was
    // down, every tick added a request that would never come back, the browser
    // ran out of sockets, and the lazy `SessionSurface` chunk lost the race
    // with `ERR_INSUFFICIENT_RESOURCES` — which blanked the whole document.
    const poll = async (): Promise<void> => {
      if (settled) return;
      try {
        const next = await fetchLodyPlatformSnapshot(platformUrl, options);
        if (settled) return;
        if (next !== null) {
          settled = true;
          setSnapshot(next);
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted || settled) return;
        // ONLY A MALFORMED CATALOG SETTLES. Retrying one forever would hide the
        // cause behind a spinner, and no amount of asking will make the box
        // serve a catalog this shell can read.
        //
        // A TRANSPORT FAILURE DOES NOT, and this is the fix. It used to settle
        // here too — "and always has", said the comment that stood here — which
        // is how a workspace whose tunnel was seconds from coming up got the
        // degraded notice for the lifetime of the tab. On a freshly provisioned
        // box that is not an edge case, it is the normal first read. Falling
        // through to the schedule below asks again, at the interval the
        // reachability signal already picks: 500 ms for a cold daemon, 30 s for
        // a tunnel that is genuinely dead.
        if (cause instanceof LodyPlatformCatalogError) {
          settled = true;
          setError(cause.message);
          return;
        }
      }
      // A NOT-OK ANSWER IS THE UNBOUNDED CASE, AND THIS IS ITS BRAKE. A cold
      // daemon answers 503 in a millisecond and deserves 500 ms; a dead tunnel
      // answers 530 forever and deserves 30 s. The reachability signal already
      // knows which one this is, so no second probe decides it.
      timer = setTimeout(
        () => void poll(),
        boxGatewayPollIntervalMs(boxGatewayHealth(), SNAPSHOT_POLL_INTERVAL_MS),
      );
    };
    void poll();
    return () => {
      settled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [platformUrl, fetchImpl]);

  return { snapshot, error };
}

export interface BlitzPlatformInput {
  snapshot: LodyPlatformSnapshot;
  viewer: BlitzViewer;
  workspaceTitle: string;
}

/**
 * Builds the provider object. Exported separately from the component so a test
 * can assemble it without React.
 *
 * `capabilities` is the EMPTY local set supplied by
 * `createLocalPlatformProvider`, plus whatever `lodyExtraCapabilities()` grants
 * — nothing, in v1. §7.2 of `plans/LODY-SESSIONS.md` asked for `remoteMachines`;
 * that is wrong and is not taken. The box IS the local machine, and that
 * capability means "dispatch to a machine other than the local one", which has
 * no transport here — claiming it with `cloudApi: null` is an invalid assembly
 * by their own contract (`vendor/lody/packages/platform/src/provider.ts:98`).
 * The same caveat governs `githubIntegration`; `v1-scope.ts` states it.
 */
export function createBlitzPlatformProvider(input: BlitzPlatformInput) {
  const { snapshot, viewer, workspaceTitle } = input;
  // Both stores settle in the same tick, as upstream requires: renderer writes
  // and CLI access checks must use one identity, never a half-settled pair.
  const local = createLocalPlatformProvider({
    session: createStore({
      status: "authenticated",
      user: { id: snapshot.userId, name: viewer.name, image: viewer.avatarUrl },
    }),
    workspaces: createStore({
      status: "ready",
      workspaces: [
        {
          id: snapshot.workspace.workspaceId,
          name: workspaceTitle,
          slug: snapshot.workspace.slug ?? "local",
          role: snapshot.workspace.role,
        },
      ],
      activeWorkspaceId: snapshot.workspace.workspaceId,
    }),
  });
  const extra = lodyExtraCapabilities();
  if (extra.length === 0) return local;
  return { ...local, capabilities: createCapabilitySet([...local.capabilities.list(), ...extra]) };
}

export interface BlitzPlatformProvidersProps extends BlitzPlatformInput {
  children: ReactNode;
}

/**
 * The provider stack, outermost first (design doc §1.4), for a snapshot the
 * caller already holds. `I18nextProvider`, `ThemeProvider`, `TooltipProvider`,
 * the memory router and `RuntimeProvider` mount INSIDE this, in
 * `SessionSurface` — they are surface concerns and phase 3 owns them. What lives
 * here is everything the runtime itself needs.
 *
 * Separate from `BlitzPlatformProvider` because `SessionSurface` needs the
 * snapshot BEFORE the stack renders — the workspace slug in it is what the
 * memory router's initial address is built from — and polling `/lody/platform`
 * twice for one surface would be two pollers racing to settle one identity.
 */
export function BlitzPlatformProviders(props: BlitzPlatformProvidersProps) {
  const convex = useRef<ConvexReactClient | null>(null);
  convex.current ??= createInertConvexClient();
  // `AuthProvider` memoizes on the client's identity, so it is built once.
  const authClient = useRef<LodyInertAuthClient | null>(null);
  authClient.current ??= createInertLodyAuthClient();

  const platform = useMemo(
    () =>
      createBlitzPlatformProvider({
        snapshot: props.snapshot,
        viewer: props.viewer,
        workspaceTitle: props.workspaceTitle,
      }),
    [props.snapshot, props.viewer, props.workspaceTitle],
  );

  return (
    <ConvexProvider client={convex.current}>
      {/* `useAuthClient` has no local-platform branch, and `SessionDetail`
          reaches it through `useWorkspaceMembers`. See `inert-auth-client.ts`
          for why the client is ours rather than better-auth's. */}
      <AuthProvider authClient={authClient.current}>
        <AuthenticatedConvexContext.Provider value={SIGNED_OUT_CONVEX}>
          <PlatformContext.Provider value={platform}>{props.children}</PlatformContext.Provider>
        </AuthenticatedConvexContext.Provider>
      </AuthProvider>
    </ConvexProvider>
  );
}

/**
 * The stack plus the poll that settles the identity it needs.
 *
 * Renders nothing until the daemon's identity settles: a `PlatformContext`
 * carrying a placeholder user would let a write reach the daemon under an id its
 * access oracle rejects, and the failure would surface at dispatch time.
 */
export function BlitzPlatformProvider(props: BlitzPlatformProviderProps) {
  const { snapshot, error } = useLodyPlatformSnapshot(props.platformUrl, props.fetchImpl);

  const notified = useRef(false);
  const onSnapshot = props.onSnapshot;
  useEffect(() => {
    if (snapshot === null || notified.current) return;
    notified.current = true;
    onSnapshot?.(snapshot);
  }, [snapshot, onSnapshot]);

  if (error !== null) throw new Error(`lody platform snapshot failed: ${error}`);
  if (snapshot === null) return null;

  return (
    <BlitzPlatformProviders
      snapshot={snapshot}
      viewer={props.viewer}
      workspaceTitle={props.workspaceTitle}
    >
      {props.children}
    </BlitzPlatformProviders>
  );
}
