/**
 * `SessionSurface` — the vendored Lody chat surface, mounted for real
 * (plans/LODY-SESSIONS.md §7.1, plans/LODY-RUNTIME-DESIGN.md §4).
 *
 * Phase 0 rendered three leaves from fixtures. Phase 2 drove a runtime with no
 * UI. This is both halves joined: their chat landing and their session detail,
 * inside our shell, against the box daemon.
 *
 * WHAT THIS FILE OWNS: the provider stack, the memory router, and the identity
 * seeding that stands in for the parts of their root route we do not mount. It
 * owns no session logic at all — `ChatLanding` and `SessionDetail` are theirs,
 * unmodified, and every send / steer / cancel / permission path inside them runs
 * their code (§0.2's vendor-wholesale rule).
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
 * - the workspace-context atoms — their `$workspaceName` route fills them; our
 *   route tree calls the same vendored hook (`router.tsx`, `WorkspaceRoute`).
 *
 * IT STAYS MOUNTED. The runtime owns a WebSocket, an IndexedDB repo and a WASM
 * instance, so the surface is hidden with the `hidden` attribute rather than
 * unmounted — the same rule `shell/WorkPanes.tsx` applies to ttyd sessions.
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
import { I18nextProvider } from "react-i18next";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "@lody/components/theme-provider";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { RuntimeProvider } from "@lody/components/providers/runtime-provider";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { userAtom } from "@lody/components/atoms";
import { localProbeResultAtom } from "@lody/components/atoms/local-probe";
import { bootstrapLodyAgentConfigs, refreshLodyAcpCapabilities } from "./agent-configs.js";
import { createLodyLocalBridge, installLodyLocalBridge, type LodyLocalBridge } from "./local-bridge.js";
import {
  mirrorLocalProjectsToMachineMeta,
  publishBoxReposAsWorkspaceRepos,
} from "./local-projects.js";
import { BlitzPlatformProviders, useLodyPlatformSnapshot, type BlitzViewer } from "./platform.js";
import type { LodyPlatformSnapshot } from "./platform-snapshot.js";
import {
  activeSessionIdFromPathname,
  createLodySessionRouter,
  type LodyRouter,
} from "./router.js";
import type { LodyAtomStore, LodyRuntimeEndpoints, LodyWorkspaceRuntime } from "./runtime.js";
import { initLodyI18n } from "./i18n.js";
import { SessionRailSidebar } from "./SessionRailSidebar.js";
import type { SharedSessionRow } from "./shared-sessions.js";
import { LODY_SURFACE_CLASS } from "./surface-class.js";
import { seedWorktreeWorkdirDefault } from "./workdir-default.js";
import type { DriveRailSession } from "../shell/rail-sessions.js";
import { appliedTheme } from "../theme.js";
import "./lody-surface.css";
import "./lody-surface-shell.css";

/** next-themes persists under its own key. Ours is namespaced so the surface's
 * light/dark choice can never be confused with `blitz-theme`, which is the
 * shell's and is stored as a `data-theme` attribute rather than a class. */
const LODY_THEME_STORAGE_KEY = "blitz-lody-theme";

/**
 * Forces their theme engine onto the shell's current choice, and returns it.
 *
 * This is not cosmetic. `LodyThemeProvider` (`theme-provider.tsx:149`) writes
 * `document.documentElement.style.colorScheme` on every resolved theme — an
 * INLINE style on the html element, which beats our `:root { color-scheme }`
 * from any stylesheet. So a surface that resolved `light` while the shell is
 * dark would repaint our scrollbars and form controls, everywhere, not just
 * inside the surface. The phase-0 containment test cannot see this: it is a
 * runtime DOM write, not a CSS rule.
 *
 * `defaultTheme` alone is not enough, because next-themes prefers its stored
 * value on every later boot. Writing the key first makes the stored value ours,
 * every mount. `'system'` is deliberately never handed over: our own default,
 * with no `data-theme` attribute, is DARK (`tokens.css` sets
 * `color-scheme: dark` on `:root` unconditionally), so mapping it to `system`
 * would let the OS disagree with the shell.
 */
function adoptShellTheme(): "dark" | "light" {
  const choice = appliedTheme() === "light" ? "light" : "dark";
  try {
    window.localStorage.setItem(LODY_THEME_STORAGE_KEY, choice);
  } catch {
    // Sandboxed storage: `defaultTheme` still applies for this mount.
  }
  return choice;
}

/** Everything the rail's Terminals section needs, and nothing else. */
export interface LodyRailBinding {
  terminals: DriveRailSession[];
  activeTerminalId: string;
  onSelectTerminal: (tabId: string) => void;
  /** The `+ New tab` control, rendered in the Terminals section header. */
  terminalsAction?: ReactNode;
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
  /** Show the chat landing — the create surface, with no session selected. */
  openLanding: () => void;
  /** The session the surface is currently showing, or `null` on the landing. */
  activeSessionId: () => string | null;
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
  /** Hidden, not unmounted: the runtime must survive a rail click. */
  hidden?: boolean;
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
  /** Handed the imperative API once the daemon's identity settles, and `null`
   * on teardown. */
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  /** Fires on every resolved navigation inside the surface. */
  onActiveSessionChange?: (sessionId: string | null) => void;
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
}

/**
 * Installs `window.ipc` for the lifetime of the surface.
 *
 * Installed during the FIRST RENDER, not in an effect: `useImplicitLocalWorkspace`
 * polls `localPlatform.getSnapshot` off a module-level singleton that starts on
 * its first read (`providers/local-platform-provider.ts:110`), and that read
 * happens while `RuntimeProvider` renders. An effect would run after it.
 */
function useLodyLocalBridge(endpoints: LodyRuntimeEndpoints): LodyLocalBridge {
  const held = useRef<LodyLocalBridge | null>(null);
  held.current ??= createLodyLocalBridge(endpoints);
  const bridge = held.current;
  // Two property assignments, so repeating it per render costs nothing.
  installLodyLocalBridge(bridge);
  useEffect(() => {
    // Re-asserted here because React can run the cleanup below and then mount
    // again WITHOUT re-rendering — StrictMode's double-invoke does exactly
    // that — which would otherwise leave `window.ipc` removed for good.
    const uninstall = installLodyLocalBridge(bridge);
    return uninstall;
  }, [bridge]);
  return bridge;
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

/**
 * Runs the agent-config bootstrap once the runtime is live.
 *
 * Keyed on the runtime instance rather than run at mount: `RuntimeProvider`
 * creates the runtime asynchronously and re-creates it whenever the workspace
 * changes, and the configs live in that runtime's machine Flock room. It is
 * cheap to repeat and idempotent by construction (`agent-configs.ts`), so a
 * re-run after a reconnect is a no-op rather than a duplicate row.
 */
function LodyAgentConfigBootstrap(props: {
  store: LodyAtomStore;
  machineId: string;
  endpoints: LodyRuntimeEndpoints;
}) {
  const { store, machineId, endpoints } = props;
  useEffect(() => {
    let cancelled = false;
    let started: LodyWorkspaceRuntime | null = null;
    const aborter = new AbortController();
    const run = (): void => {
      const runtime = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      if (runtime === null || cancelled || runtime === started) return;
      started = runtime;
      void (async () => {
        await bootstrapLodyAgentConfigs(store, runtime, machineId);
        // Before anything can be archived: the daemon's archive path reads the
        // legacy `machineMeta.localProjects` field and the box's registrar only
        // ever writes the Flock row, so without this mirror a worktree session
        // archives into nothing and leaves the member's uncommitted work on
        // disk. See `local-projects.ts` for the upstream anchor.
        await mirrorLocalProjectsToMachineMeta(runtime, machineId);
        // And before a worktree session can be created at all: the landing
        // drops `githubRepoFullName` from a session's ProjectRef unless the
        // name is in the workspace's connected-repo list, and without that
        // field the session is a chat to the rail and to the daemon's diff
        // stats alike. See `local-projects.ts`.
        await publishBoxReposAsWorkspaceRepos(store, endpoints, runtime, machineId);
        // Second, and only after the rows exist: the capabilities pass keys off
        // them. A config that fails to report costs the composer that agent's
        // selectors and nothing else, so it is warned about rather than raised
        // — the same call upstream's own pass makes (`:2477`).
        await refreshLodyAcpCapabilities(runtime, machineId, {
          signal: aborter.signal,
          onError: (cause, configId) => {
            console.warn("lody: ACP capability refresh failed", { configId, cause });
          },
        });
      })().catch((cause: unknown) => {
        // Warned, not raised. A member whose agent configs failed to seed can
        // still open a session against a config the daemon already has; blanking
        // the surface would take that away too.
        if (!cancelled) console.warn("lody: agent-config bootstrap failed", cause);
      });
    };
    const unsubscribe = store.sub(runtimeAtom, run);
    run();
    return () => {
      cancelled = true;
      aborter.abort();
      unsubscribe();
    };
  }, [store, machineId, endpoints]);
  return null;
}

/** The stack below the platform providers, in the order design doc §1.4 fixes. */
function LodySurfaceProviders(props: { children: ReactNode }) {
  const i18n = useMemo(() => initLodyI18n(), []);
  const theme = useMemo(() => adoptShellTheme(), []);
  // Beside the theme adoption for the same reason: both write a key their own
  // code reads on first render, so both have to happen before that render.
  useMemo(() => seedWorktreeWorkdirDefault(), []);
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider defaultTheme={theme} storageKey={LODY_THEME_STORAGE_KEY}>
        <TooltipProvider>{props.children}</TooltipProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}

export function SessionSurface(props: LodySessionSurfaceProps) {
  const { endpoints, viewer, workspaceTitle, onApiReady, onActiveSessionChange } = props;
  // Installed before anything below renders; see the hook's comment.
  const bridge = useLodyLocalBridge(endpoints);
  const { snapshot, error } = useLodyPlatformSnapshot(endpoints.platformUrl, endpoints.fetchImpl);
  const store = useMemo(() => createStore(), []);

  const slug = snapshot?.workspace.slug ?? null;
  const readOnly = props.readOnly === true;
  const isShared = props.shared !== undefined;
  // Keyed on the primitive and not on the object: `shared` is a fresh literal
  // on every render of the host, and rebuilding the router would rebuild the
  // page under the member's cursor.
  const sharedSessionId = props.shared?.sessionId ?? null;
  const router = useMemo<LodyRouter | null>(
    () =>
      slug === null
        ? null
        : createLodySessionRouter(slug, {
            readOnly,
            ...(sharedSessionId === null ? {} : { initialSessionId: sharedSessionId }),
          }),
    [slug, readOnly, sharedSessionId],
  );

  // Both seeds are effects, so the first render below sees a null user and no
  // visible machine; both atoms are jotai state, so the surface converges on
  // the next tick. Only the machine-id seed has an ordering hazard, and it is a
  // subscription rather than a write for exactly that reason.
  useEffect(() => {
    if (snapshot === null) return undefined;
    seedCurrentUser(store, snapshot, viewer);
    return seedLocalMachineIdentity(store, snapshot);
  }, [store, snapshot, viewer]);

  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  onActiveSessionChangeRef.current = onActiveSessionChange;
  useEffect(() => {
    if (router === null) return undefined;
    return router.subscribe("onResolved", () => {
      onActiveSessionChangeRef.current?.(
        activeSessionIdFromPathname(router.state.location.pathname),
      );
    });
  }, [router]);

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
  const openLanding = useCallback(() => {
    if (router === null || slug === null) return;
    void router.navigate({ to: "/$workspaceName/chat", params: { workspaceName: slug } });
  }, [router, slug]);

  const onApiReadyRef = useRef(onApiReady);
  onApiReadyRef.current = onApiReady;
  useEffect(() => {
    if (router === null || slug === null) return undefined;
    const api: LodySessionSurfaceApi = {
      openSession,
      openLanding,
      activeSessionId: () => activeSessionIdFromPathname(router.state.location.pathname),
      unsupportedIpcChannels: () => bridge.unsupportedChannels(),
    };
    onApiReadyRef.current?.(api);
    return () => onApiReadyRef.current?.(null);
  }, [router, slug, bridge, openSession, openLanding]);

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

  const { railHost, rail } = props;
  const railSidebar =
    railHost === null || railHost === undefined || rail === undefined
      ? null
      : createPortal(
          <SessionRailSidebar
            terminals={rail.terminals}
            activeTerminalId={rail.activeTerminalId}
            activeSessionId={activeSessionId}
            surfaceVisible={props.hidden !== true}
            onSelectTerminal={rail.onSelectTerminal}
            onSelectSession={openSession}
            onOpenLanding={openLanding}
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

  return (
    <div className={LODY_SURFACE_CLASS} hidden={props.hidden === true}>
      {error !== null && (
        <div className="lody-surface__notice" role="alert">
          Sessions are unavailable on this workspace: {error}
        </div>
      )}
      {snapshot !== null && router !== null && error === null && (
        <JotaiProvider store={store}>
          <BlitzPlatformProviders
            snapshot={snapshot}
            viewer={viewer}
            workspaceTitle={workspaceTitle}
          >
            <LodySurfaceProviders>
              <RuntimeProvider>
                {!isShared && (
                  <LodyAgentConfigBootstrap
                    store={store}
                    machineId={snapshot.machineId}
                    endpoints={endpoints}
                  />
                )}
                {railSidebar}
                <RouterProvider router={router} />
              </RuntimeProvider>
            </LodySurfaceProviders>
          </BlitzPlatformProviders>
        </JotaiProvider>
      )}
    </div>
  );
}

export default SessionSurface;
