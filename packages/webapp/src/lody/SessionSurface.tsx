/**
 * `SessionSurface` — the vendored Lody chat surface, mounted for real
 * (plans/LODY-SESSIONS.md §7.1, plans/LODY-RUNTIME-DESIGN.md §4).
 *
 * Phase 0 rendered three leaves from fixtures. Phase 2 drove a runtime with no
 * UI. This is both halves joined: their chat landing and their session detail,
 * inside our shell, against the box daemon.
 *
 * WHAT THIS FILE OWNS: the memory router and the identity seeding that stands in
 * for the parts of their root route we do not mount, composed with the provider
 * stack `surface-providers.tsx` holds. It owns no session logic at all —
 * `ChatLanding` and `SessionDetail` are theirs, unmodified, and every send /
 * steer / cancel / permission path inside them runs their code (§0.2's
 * vendor-wholesale rule).
 *
 * WHAT WE DO NOT MOUNT, AND WHY IT IS SAFE. Their `__root.tsx` builds the Convex
 * and better-auth stack; their `$workspaceName/_auth.tsx` runs the organization
 * guard, `ElectronMenuHandler`, OneSignal, PostHog and the command palette. None
 * of those has a local-platform meaning, and `_auth.tsx`'s own local branch
 * (`isLocalAppPlatform()`) already skips the cloud half. What those routes DO
 * contribute that the pages need is three pieces of state, and each is seeded
 * here instead:
 *
 * - `userAtom` — `__root.tsx:157` fills it from the better-auth session. Every
 *   authored write reads its `id`, and `buildVisibleMachineIndex`
 *   (`lib/visible-machine-index.ts:47`) makes the box machine visible only when
 *   the machine doc's `ownerUserId` matches it. It must be the DAEMON's
 *   `local:<uuid>`, never a BlitzOS membership id.
 * - `localProbeResultAtom` — Electron's CLI-state bridge fills it. See
 *   `seedLocalMachineIdentity` for why a plain write loses a race.
 * - the workspace-context atoms — their `$workspaceName` route fills them, and
 *   our route tree calls the same vendored hook (`router.tsx`, `WorkspaceRoute`)
 *   with the daemon's own workspace id. They are ALSO seeded above the router by
 *   `seedWorkspaceContext`, because the runtime is built from them and something
 *   above the router now waits for the runtime. The owner also repairs the pair
 *   when Activity runs the hidden route's cleanup.
 *
 * IT STAYS MOUNTED. The bridge/store/runtime/provider tree remains live; React
 * Activity hides the route DOM and disconnects route effects until reveal.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import { RouterProvider } from "@tanstack/react-router";
import { RuntimeProvider } from "@lody/components/providers/runtime-provider";
import { IpcClientProvider } from "@lody/components/providers/ipc-client-provider";
import { userAtom } from "@lody/components/atoms";
import { localProbeResultAtom } from "@lody/components/atoms/local-probe";
import { LodyAgentAuthNotice } from "./agent-auth-notice.js";
import { LodyAgentConfigGate } from "./agent-config-gate.js";
import { useLodyRuntimeBootRetry } from "./use-runtime-boot-retry.js";
import { BlitzPlatformProviders, useLodyPlatformSnapshot, type BlitzViewer } from "./platform.js";
import {
  fetchLodyPlatformSnapshot,
  type LodyPlatformFetchOptions,
  type LodyPlatformSnapshot,
} from "./platform-snapshot.js";
import {
  activeSessionIdFromPathname,
  createLodySessionRouter,
  isArchivePathname,
  type LodyRouter,
  type LodySessionRouterOptions,
} from "./router.js";
import type { LodyAtomStore, LodyRuntimeEndpoints } from "./runtime.js";
import { SessionRailSidebar } from "./SessionRailSidebar.js";
import type { SharedSessionRow } from "./shared-sessions.js";
import { SurfaceTabsContext, type SurfaceTabsBinding } from "./surface-tabs.js";
import { useDefaultSessionProjectBackfill } from "./use-session-project-backfill.js";
import { LODY_SURFACE_CLASS } from "./surface-class.js";
import { useLodySurfaceIpc, useLodySurfaceIpcLifecycle } from "./surface-ipc.js";
import { SurfaceUnavailableNotice } from "./SurfaceLoadBoundary.js";
import type { DriveRailSession } from "../shell/rail-sessions.js";
import { LodySurfaceProviders, LodySurfaceThemeRoot } from "./surface-providers.js";
import { LodyRouteActivity, LodySurfaceVisibilityRoot } from "./surface-activity.js";
import type { LodySurfaceIdentity } from "./keepalive-pool.js";
import { useTrackLodyRuntimeRepo } from "./surface-runtime-stats.js";
import { seedLodySurfaceWorkspaceContext } from "./surface-workspace-context.js";
import "./lody-surface.css";
import "./lody-surface-shell.css";
import "./blitz-skin.css";

/** A value that differs from the last one, for `resetDraftKey`. The clock alone
 * is not enough: two presses inside one millisecond would produce the same key
 * and the second reset would be dropped as a repeat. */
let draftKeySequence = 0;
function nextDraftKey(): string {
  draftKeySequence += 1;
  return `${Date.now()}-${draftKeySequence}`;
}

/** Everything the rail's Terminals section needs, and nothing else. */
export interface LodyRailBinding {
  terminals: DriveRailSession[];
  activeTerminalId: string;
  onSelectTerminal: (tabId: string) => void;
  /** Close one terminal tab from its rail row — the deleted native strip's
   * close, moved (`SessionRailSidebar`'s `TerminalRows`). */
  onCloseTerminal?: (tabId: string) => void;
  /**
   * THE SHELL'S OWN NAVIGATORS, and the reason they exist rather than the
   * surface routing itself.
   *
   * A rail click is an ADDRESS change, not a surface navigation. The surface is
   * hidden whenever the panes own the view (`ChatAddress` is `null`), and a
   * navigation inside a hidden surface changes nothing a member can see: the
   * mirror back to the address deliberately does nothing while the panes own it
   * (`use-lody-rail.ts`), so the surface would move and the shell would not.
   * That is the whole of the third canary dogfood's first three reports — a
   * session row, "New session", and "New session" with a terminal tab open all
   * did nothing at all.
   *
   * Absent, the portal falls back to the surface's own router, which is what a
   * headless mount with no shell around it wants.
   */
  onOpenSession?: (sessionId: string) => void;
  onOpenLanding?: () => void;
  /** The `+ New tab` control, rendered in the Terminals section header. */
  terminalsAction?: ReactNode;
  /** The rail footer's Archive entry (seam patch 13). Absent, the portal falls
   * back to the surface's own router, exactly as `onOpenSession` does. */
  onOpenArchive?: () => void;
  /** Right-click Share on a session row. Absent leaves the row's menu exactly
   * as phase 4 shipped it (plans/LODY-SHARING.md §8). */
  onShareSession?: (sessionId: string) => void;
  /** The "Shared with you" section: sessions on other members' boxes. */
  sharedSessions?: SharedSessionRow[];
  activeSharedSessionId?: string | null;
  onSelectSharedSession?: (row: SharedSessionRow) => void;
}

/** What `CloudApp` drives the surface with. Imperative on purpose: the router's
 * address stays the surface's own state, and phase 4's rail reads it back
 * through `onActiveSessionChange` rather than owning it. */
export interface LodySessionSurfaceApi {
  /** Show the session detail page for `sessionId`. */
  openSession: (sessionId: string) => void;
  /**
   * Show the chat landing — the create surface, with no session selected.
   *
   * `resetDraft` is what "New session" means when the landing is ALREADY the
   * address: the shell's own navigation is a no-op there (`useLodyRail.go`
   * refuses to push the path it is on), and the button read as dead. It is
   * upstream's own mechanism — a fresh `?resetDraftKey` clears the prompt, the
   * attachments and the draft session id (`chat-landing.tsx:1331`) — so the
   * member gets an empty composer instead of the one they left.
   */
  openLanding: (options?: { resetDraft?: boolean }) => void;
  /** The session the surface is currently showing, or `null` on the landing and
   * on the archive. */
  activeSessionId: () => string | null;
  /** Show the archived-session list. */
  openArchive: () => void;
  /** `true` while the archive page is the surface's address. Asked BESIDE
   * `activeSessionId`, because the archive names no session and would otherwise
   * be indistinguishable from the landing. */
  isArchiveOpen: () => boolean;
  /** Every `window.ipc` channel the vendored renderer asked for that the bridge
   * does not serve (design-doc risk 10). Empty is the healthy answer, and the
   * phase-3 exit test asserts it after a full round trip: an upstream call site
   * that appears at the next merge shows up here instead of as a rejected
   * promise nobody awaits. */
  unsupportedIpcChannels: () => readonly string[];
}

export interface LodySessionSurfaceProps {
  endpoints: LodyRuntimeEndpoints;
  viewer: BlitzViewer;
  /** The BlitzOS workspace title. Replaces the daemon's own "Lody". */
  workspaceTitle: string;
  /** Hidden route DOM over a still-mounted runtime provider stack. */
  hidden?: boolean;
  /**
   * Owns page-global compatibility, shell callbacks, rail and toast rendering.
   * Future retained surfaces pass false while inactive. Defaults to true for
   * the current single-surface and standalone compositions.
   */
  active?: boolean;
  /**
   * The rail's list region (`div.session-list--vendor`), if the shell offers
   * one. Lody's sidebar body is PORTALLED there rather than rendered by the
   * rail, because everything it reads — the session mirror, the runtime, the
   * jotai store, i18n — lives in the provider stack below, and a second stack
   * around the rail would be a second runtime, a second WebSocket and a second
   * IndexedDB repo. A portal keeps one runtime and puts the DOM where §0.3
   * wants it. React context follows the RENDER tree, so the sidebar sits below
   * `RuntimeProvider` and outside the memory router — which is what makes
   * `useResolvedWorkspaceScope` take its `currentWorkspaceIdAtom` branch there.
   */
  railHost?: HTMLElement | null;
  /** What the rail's Terminals section draws, and what a click on one does.
   * Terminal tabs are `webapp_state`, never sessions — the daemon never sees
   * them — so they arrive as props and leave through this callback. */
  rail?: LodyRailBinding;
  /**
   * The workspace's own tabs, drawn as tabs of Lody's session tab strip
   * (plans/LODY-TERMINAL-TABS.md §3.5).
   *
   * A SIBLING of `rail`, and for the same reason: a terminal is `webapp_state`,
   * never a session, so the list arrives as props and every verb leaves through
   * a callback. Absent leaves both hosts drawing exactly what phase 4 shipped —
   * which is what a grantee's surface gets, because a terminal is an arbitrary
   * shell on the owner's box and no share level grants that (§5.1).
   */
  surfaceTabs?: SurfaceTabsBinding;
  /** Handed the imperative API once the daemon's identity settles, and `null`
   * on teardown. */
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  /** Fires on every resolved navigation inside the surface. */
  onActiveSessionChange?: (sessionId: string | null) => void;
  /** Authoritative daemon identity, reported after every validation read. */
  onIdentity?: (identity: LodySurfaceIdentity) => void;
  /** The captured bridge lost socket or daemon continuity. */
  onContinuityLost?: () => void;
  /** Non-zero generations request a fresh concurrent platform snapshot. */
  identityValidationGeneration?: number;
  /**
   * This surface is mounted against ANOTHER member's box, for one session they
   * shared (plans/LODY-SHARING.md §10.2).
   *
   * Two things follow, and both are about writing to somebody else's machine:
   * the agent-config bootstrap does not run — it writes to the owner's machine
   * Flock, which the relay refuses — and the router opens on the session rather
   * than on the chat landing, because the landing creates sessions and a
   * grantee may not create one there.
   */
  shared?: { sessionId: string };
  /** Follow the session without driving it. Suppresses the composer and the
   * permission card's answer buttons (seam patch 4). */
  readOnly?: boolean;
  /**
   * The session the shell's address named on THIS box at mount, so the memory
   * router opens on it instead of the chat landing.
   *
   * Read ONCE, at the mount this surface is keyed to (a workspace switch mounts
   * a fresh surface per box), and never again: later selections drive the
   * router imperatively through `openSession`, and re-reading this would rebuild
   * the router under the member's cursor. Without it the own-box router starts
   * at `/chat`, whose first resolved address is `null`; that null is mirrored
   * back to the shell as `openLanding()` and erases the restored selection —
   * the "goes back to new session" half of the workspace-switch report. The
   * `shared` branch already opens on its own session, so this is the own-box
   * counterpart of that.
   */
  initialSessionId?: string;
}

/**
 * Teaches the renderer that the box IS the local machine.
 *
 * `localProbeEffectAtom` (`atoms/local-probe.ts:113`) is an `atomEffect` mounted
 * by `RuntimeProvider`. Outside Electron its FIRST action is to write
 * `localProbeResultAtom = null` and `localProbeAttemptedAtom = true`, and
 * `RuntimeProvider` then calls `runtime.setLocalMachineId(null)` — undoing the
 * machine id and leaving `localMachineIdAtom` empty for the eleven components
 * that read it, `session-chat-interface` and `session-detail` among them.
 *
 * A plain write cannot reliably win that race: the effect mounts when
 * `RuntimeProvider` subscribes, and React runs child effects before parent
 * effects, so neither position is safe in both mount orders (StrictMode
 * remounts included). So this SUBSCRIBES: whenever the atom lands on `null`, the
 * box's identity is put back. It converges after at most one extra write and is
 * ordering-independent, which a `useEffect` placed just so is not.
 *
 * Note what it does NOT touch: `localAgentEnabledAtom` stays `false`, because
 * that is Electron's "run a local agent" SETTING and we have no such setting;
 * nothing on the local sync mode reads it (`runtime-provider.tsx:117` gates on
 * `syncMode === 'dual'`).
 */
function seedLocalMachineIdentity(store: LodyAtomStore, snapshot: LodyPlatformSnapshot): () => void {
  const identity = {
    ok: true,
    machineId: snapshot.machineId,
    workspaceId: snapshot.workspace.workspaceId,
  };
  const assert = (): void => {
    if (store.get(localProbeResultAtom) === null) store.set(localProbeResultAtom, identity);
  };
  assert();
  return store.sub(localProbeResultAtom, assert);
}

/**
 * Seeds `userAtom` with the daemon's own identity, decorated by our auth.
 *
 * The `id` is the daemon's and must stay so: `createLocalCloudPort`'s access
 * oracle (`vendor/lody/packages/platform/src/local.ts:103`) allows exactly that
 * id, so a BlitzOS membership id here is refused at dispatch. `email` satisfies
 * `CurrentUserSchema`'s `z.string().email()` and is never sent anywhere — the
 * local composition has no mail path. The value mirrors the one their own local
 * auth provider computes (`providers/local-platform-auth-provider.tsx:47`).
 */
function seedCurrentUser(
  store: LodyAtomStore,
  snapshot: LodyPlatformSnapshot,
  viewer: BlitzViewer,
): void {
  store.set(userAtom, {
    id: snapshot.userId,
    email: "local@lody.local",
    name: viewer.name,
    image: viewer.avatarUrl,
  });
}

function SessionSurfaceContent(props: LodySessionSurfaceProps) {
  const { endpoints, viewer, workspaceTitle, onApiReady, onActiveSessionChange } = props;
  const active = props.active !== false;
  const localBridge = useLodySurfaceIpc(endpoints, props.onContinuityLost);
  const { bridge, ipcClient } = localBridge;
  useLodySurfaceIpcLifecycle(localBridge, active);
  const { snapshot, error } = useLodyPlatformSnapshot(endpoints.platformUrl, endpoints.fetchImpl);
  const store = useMemo(() => createStore(), []);
  useTrackLodyRuntimeRepo(store);

  const onIdentityRef = useRef(props.onIdentity);
  onIdentityRef.current = props.onIdentity;
  useEffect(() => {
    if (snapshot === null) return;
    onIdentityRef.current?.({
      machineId: snapshot.machineId,
      lwWorkspaceId: snapshot.workspace.workspaceId,
    });
  }, [snapshot]);

  const validationGeneration = props.identityValidationGeneration ?? 0;
  useEffect(() => {
    if (!active || validationGeneration === 0) return undefined;
    const controller = new AbortController();
    const options: LodyPlatformFetchOptions = { signal: controller.signal };
    if (endpoints.fetchImpl !== undefined) options.fetchImpl = endpoints.fetchImpl;
    void fetchLodyPlatformSnapshot(endpoints.platformUrl, options)
      .then((validated) => {
        if (validated === null || controller.signal.aborted) return;
        onIdentityRef.current?.({
          machineId: validated.machineId,
          lwWorkspaceId: validated.workspace.workspaceId,
        });
      })
      .catch(() => {
        // The continuity flag stays false. If the member leaves before a later
        // successful validation, the pool evicts this entry instead of reusing it.
      });
    return () => controller.abort();
  }, [active, endpoints.fetchImpl, endpoints.platformUrl, validationGeneration]);

  const slug = snapshot?.workspace.slug ?? null;
  const readOnly = props.readOnly === true;
  const isShared = props.shared !== undefined;
  // Keyed on the primitive and not on the object: `shared` is a fresh literal
  // on every render of the host, and rebuilding the router would rebuild the
  // page under the member's cursor.
  const sharedSessionId = props.shared?.sessionId ?? null;
  const workspaceId = snapshot?.workspace.workspaceId ?? null;
  // The own-box initial address, frozen at mount: the router builds once, after
  // the snapshot settles the slug, and later selections drive it imperatively.
  // A ref, not a dep, so a selection change never rebuilds the router. See the
  // prop's comment for why the address has to arrive with the router rather than
  // after it.
  const initialOwnSessionIdRef = useRef(props.initialSessionId);
  const router = useMemo<LodyRouter | null>(() => {
    if (slug === null) return null;
    const routerOptions: LodySessionRouterOptions = { readOnly };
    // The daemon's own id, into `currentWorkspaceIdAtom` through their
    // `$workspaceName` route. Without it every consumer that reads the id
    // directly — the ACP sign-in panel first among them — sees `null` and
    // refuses with "Workspace context is missing". See `router.tsx`.
    if (workspaceId !== null) routerOptions.workspaceId = workspaceId;
    // A shared surface opens on the shared session; an own surface opens on the
    // selection the shell restored. Shared wins because the two never coexist on
    // one surface, and a shared mount is never handed an own-box initial id.
    if (sharedSessionId !== null) routerOptions.initialSessionId = sharedSessionId;
    else if (initialOwnSessionIdRef.current !== undefined) {
      routerOptions.initialSessionId = initialOwnSessionIdRef.current;
    }
    return createLodySessionRouter(slug, routerOptions);
  }, [slug, workspaceId, readOnly, sharedSessionId]);

  // Both seeds are effects, so the first render below sees a null user and no
  // visible machine; both atoms are jotai state, so the surface converges on
  // the next tick. Only the machine-id seed has an ordering hazard, and it is a
  // subscription rather than a write for exactly that reason.
  useEffect(() => {
    if (snapshot === null) return undefined;
    seedCurrentUser(store, snapshot, viewer);
    return undefined;
  }, [store, snapshot, viewer]);

  useEffect(() => {
    if (snapshot === null) return undefined;
    const releaseContext = seedLodySurfaceWorkspaceContext(store, snapshot);
    const releaseIdentity = seedLocalMachineIdentity(store, snapshot);
    return () => {
      releaseContext();
      releaseIdentity();
    };
  }, [store, snapshot]);

  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  onActiveSessionChangeRef.current = onActiveSessionChange;
  useEffect(() => {
    if (!active || router === null) return undefined;
    return router.subscribe("onResolved", () => {
      onActiveSessionChangeRef.current?.(
        activeSessionIdFromPathname(router.state.location.pathname),
      );
    });
  }, [active, router]);

  const openSession = useCallback(
    (sessionId: string) => {
      if (router === null || slug === null) return;
      void router.navigate({
        to: "/$workspaceName/sessions/$sessionId",
        params: { workspaceName: slug, sessionId },
      });
    },
    [router, slug],
  );
  const openLanding = useCallback(
    (options?: { resetDraft?: boolean }) => {
      if (router === null || slug === null) return;
      const chat = { to: "/$workspaceName/chat", params: { workspaceName: slug } };
      if (options?.resetDraft !== true) {
        void router.navigate(chat);
        return;
      }
      // Their own key, and it has to be NEW every press: the landing compares
      // it against the last one it applied and does nothing when it repeats.
      void router.navigate({ ...chat, search: { resetDraftKey: nextDraftKey() } });
    },
    [router, slug],
  );

  const openArchive = useCallback(() => {
    if (router === null || slug === null) return;
    void router.navigate({ to: "/$workspaceName/archive", params: { workspaceName: slug } });
  }, [router, slug]);

  const onApiReadyRef = useRef(onApiReady);
  onApiReadyRef.current = onApiReady;
  useEffect(() => {
    if (!active || router === null || slug === null) return undefined;
    const api: LodySessionSurfaceApi = {
      openSession,
      openLanding,
      openArchive,
      activeSessionId: () => activeSessionIdFromPathname(router.state.location.pathname),
      isArchiveOpen: () => isArchivePathname(router.state.location.pathname),
      unsupportedIpcChannels: () => bridge.unsupportedChannels(),
    };
    onApiReadyRef.current?.(api);
    return () => onApiReadyRef.current?.(null);
  }, [active, router, slug, bridge, openSession, openLanding, openArchive]);

  // The rail's own copy of the address. `onActiveSessionChange` tells `CloudApp`
  // (which drives routing and persistence); this drives the highlight inside the
  // portal, where a prop round-trip through `CloudApp` would render one frame
  // late on every click.
  const activeSessionId = useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        router === null ? () => undefined : router.subscribe("onResolved", notify),
      [router],
    ),
    () => (router === null ? null : activeSessionIdFromPathname(router.state.location.pathname)),
    () => null,
  );

  // The rail's own copy of the OTHER half of the address, out of the same
  // subscription and for the same reason: the footer's Archive entry draws its
  // active state from it, and a prop round-trip through `CloudApp` would render
  // one frame late on every click.
  const archiveOpen = useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        router === null ? () => undefined : router.subscribe("onResolved", notify),
      [router],
    ),
    () => (router === null ? false : isArchivePathname(router.state.location.pathname)),
    () => false,
  );

  // A SESSION CREATED BEFORE THE DEFAULT PROJECT EXISTED IS REPAIRED ON OPEN
  // (`workdir-default.ts` §3). Without it, every session a member started before
  // that fix keeps answering "Session has no local project or GitHub repository
  // workspace" for the Files tab, All Changes and every file chip — and the only
  // way out would be to abandon the conversation and start a new one.
  //
  // Driven from the address above because an open is not a write, so the writer
  // seam that carries the same default at creation cannot see it. The hook reads
  // the runtime off the atom `RuntimeProvider` writes, which is why nothing here
  // waits for the render tree below.
  useDefaultSessionProjectBackfill({
    store,
    endpoints,
    machineId: snapshot?.machineId ?? null,
    sessionId: activeSessionId,
    shared: isShared,
  });

  // THE RUNTIME BOOT IS ONE-SHOT AND THE BOX MAY NOT BE READY FOR IT YET.
  // `RuntimeProvider` creates the runtime once and, on failure, leaves
  // `runtimeAtom` null with nothing left in its dependency list that can
  // change — so on a freshly provisioned workspace, where the gateway answers
  // long before the session daemon does, the gate below never opens. This
  // counter rebuilds the provider when that specific failure is on the atoms.
  // See `use-runtime-boot-retry.ts` for why it is a remount and not a patch.
  const runtimeGeneration = useLodyRuntimeBootRetry(store, snapshot?.machineId ?? null);

  // THE AGENT-AUTH BANNER BELONGS TO SESSION CONTENT, NOT TO THE PANE
  // (plans/LODY-TERMINAL-TABS.md wave 3, F8).
  //
  // It says a CONVERSATION's agent is signed out and it carries that
  // conversation's sign-in panel. Drawn above the strip while a TERMINAL tab
  // owns the pane, it is a band about something the member is not looking at,
  // sitting on top of the tab they chose. A host tab owning the pane is exactly
  // `activeTabId !== null` — the same address the strip draws its selection
  // from — so the banner is scoped to the chat surfaces and nothing else.
  const hostTabOwnsPane =
    props.surfaceTabs !== undefined && props.surfaceTabs.activeTabId !== null;
  const agentAuthNotice = (machineId: string): ReactNode => hostTabOwnsPane
    ? null
    : (
      <LodyAgentAuthNotice
        store={store}
        sessionId={activeSessionId}
        // A GRANTEE gets the explanation and no sign-in button. The machine is
        // somebody else's, and the bridge refuses `/session-control` for a
        // shared request outright (`blitz-lody-bridge`,
        // plans/LODY-SHARING.md §2.2) — so the panel could only ever answer
        // `share_forbidden`.
        {...(isShared ? {} : { machineId })}
      />
    );

  const { railHost, rail } = props;
  const railSidebar =
    !active || railHost === null || railHost === undefined || rail === undefined
      ? null
      : createPortal(
          <SessionRailSidebar
            terminals={rail.terminals}
            activeTerminalId={rail.activeTerminalId}
            activeSessionId={activeSessionId}
            archiveActive={archiveOpen}
            surfaceVisible={props.hidden !== true}
            onSelectTerminal={rail.onSelectTerminal}
            {...(rail.onCloseTerminal === undefined
              ? {}
              : { onCloseTerminal: rail.onCloseTerminal })}
            onSelectSession={rail.onOpenSession ?? openSession}
            onOpenLanding={rail.onOpenLanding ?? openLanding}
            onOpenArchive={rail.onOpenArchive ?? openArchive}
            {...(rail.terminalsAction === undefined
              ? {}
              : { terminalsAction: rail.terminalsAction })}
            {...(rail.onShareSession === undefined
              ? {}
              : { onShareSession: rail.onShareSession })}
            {...(rail.sharedSessions === undefined
              ? {}
              : { sharedSessions: rail.sharedSessions })}
            {...(rail.activeSharedSessionId === undefined
              ? {}
              : { activeSharedSessionId: rail.activeSharedSessionId })}
            {...(rail.onSelectSharedSession === undefined
              ? {}
              : { onSelectSharedSession: rail.onSelectSharedSession })}
          />,
          railHost,
        );

  const routeActive = active && props.hidden !== true;
  const routeTree = router === null
    ? null
    : (
      <LodyRouteActivity active={routeActive}>
        <SurfaceTabsContext.Provider value={props.surfaceTabs ?? null}>
          <RouterProvider router={router} />
        </SurfaceTabsContext.Provider>
      </LodyRouteActivity>
    );

  return (
    <LodySurfaceVisibilityRoot hidden={props.hidden === true} className={LODY_SURFACE_CLASS}>
      {/* The same notice the load boundary renders, out of the same module, so
          "the chunk never arrived" and "the box never answered" read alike. */}
      {error !== null && <SurfaceUnavailableNotice reason={error} />}
      {snapshot !== null && router !== null && error === null && (
        <JotaiProvider store={store}>
          <IpcClientProvider client={ipcClient} localIpcHost>
            <BlitzPlatformProviders
              snapshot={snapshot}
              viewer={viewer}
              workspaceTitle={workspaceTitle}
            >
              <LodySurfaceProviders active={active}>
                <RuntimeProvider key={runtimeGeneration}>
                  {railSidebar}
                  {agentAuthNotice(snapshot.machineId)}
                  {isShared ? (
                    // A grantee's surface writes no agent configs at all — the
                    // rows belong to the owner's machine Flock, which the relay
                    // refuses — so there is nothing to gate on.
                    routeTree
                  ) : (
                    // The gate stays live above Activity: its successful
                    // bootstrap is part of the retained provider state.
                    <LodyAgentConfigGate
                      store={store}
                      machineId={snapshot.machineId}
                      endpoints={endpoints}
                    >
                      {routeTree}
                    </LodyAgentConfigGate>
                  )}
                </RuntimeProvider>
              </LodySurfaceProviders>
            </BlitzPlatformProviders>
          </IpcClientProvider>
        </JotaiProvider>
      )}
    </LodySurfaceVisibilityRoot>
  );
}

export function SessionSurface(props: LodySessionSurfaceProps) {
  return (
    <LodySurfaceThemeRoot>
      <SessionSurfaceContent {...props} />
    </LodySurfaceThemeRoot>
  );
}

export interface LodySessionSurfaceHostProps extends LodySessionSurfaceProps {
  /** React identity for the per-box surface below the page-global theme owner. */
  surfaceKey: string;
}

export interface LodySessionSurfacePoolHostProps {
  surfaces: readonly LodySessionSurfaceHostProps[];
}

function LodySessionSurfacePoolHost({ surfaces }: LodySessionSurfacePoolHostProps) {
  return (
    <LodySurfaceThemeRoot>
      {surfaces.map(({ surfaceKey, ...props }) => (
        <SessionSurfaceContent key={surfaceKey} {...props} />
      ))}
    </LodySurfaceThemeRoot>
  );
}

export { LodySurfaceProviders };

export default LodySessionSurfacePoolHost;
