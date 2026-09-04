/**
 * The memory-history route tree the vendored Lody pages mount in
 * (plans/LODY-RUNTIME-DESIGN.md §4.2).
 *
 * WHY OUR OWN TREE AND NOT THEIRS. Their pages are TanStack FILE routes
 * (`vendor/lody/packages/components/src/routes/**`), generated into a
 * `routeTree.gen.ts` that only exists inside their app builds, and the tree's
 * roots are cloud surfaces we do not mount: `__root.tsx` builds the Convex/
 * better-auth stack, and `$workspaceName/_auth.tsx` runs the organization and
 * session guards. What we want out of that tree is exactly three leaves — the
 * chat landing, the session detail and the archive — so this file declares those
 * three with their real components and stubs every other address their code
 * navigates to.
 *
 * ROUTE IDS ARE UPSTREAM'S, DELIBERATELY. `_auth` is reproduced as a PATHLESS
 * layout route so a leaf's id is `/$workspaceName/_auth/chat`, byte-for-byte
 * the id their own components look sessions up by
 * (`components/mobile/mobile-workspace-stack.tsx:14`,
 * `components/tasks/task-routes.ts:6`). Those lookups all pass
 * `shouldThrow: false`, so a mismatch would not crash — it would silently
 * return `undefined` and a mobile drawer or a task deep-link would quietly stop
 * working. Matching the ids keeps that class of failure out of the tree.
 *
 * THE STUBS ARE NOT OPTIONAL. `router.navigate({ to })` throws on an address
 * the tree does not contain, and their components navigate to twenty settings
 * pages, the task pages and `/workspace/create` from menus a member can reach at
 * any time. The list is generated, not guessed:
 *
 *     cd vendor/lody/packages/components/src
 *     grep -rho "to: '/[^']*'" components hooks lib routes | sort -u
 *     grep -rho 'to="/[^"]*"' components hooks lib routes | sort -u
 *
 * Re-run both at every upstream merge; `packages/webapp/test/lody-router.test.tsx`
 * pins the current answer so a new address fails a test instead of a member's
 * click.
 */
import {
  Outlet,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useMatchRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { isJsonNumber, isJsonString, type JsonValue } from "@blitzos/schema";
import { ChatLanding } from "@lody/components/components/chat/chat-landing";
import { parseChatLandingSearch } from "@lody/components/components/chat/chat-landing-derived";
import SessionDetail from "@lody/components/components/sessions/session-detail";
import { ArchiveView } from "@lody/components/components/archive/archive-view";
import { AppThemeShell } from "@lody/components/components/app-theme-shell";
import { mobileWorkspaceBaseContextAtom } from "@lody/components/atoms";
import { useIsMobile } from "@lody/components/hooks/use-mobile";
import { useWorkspaceContextAtoms } from "@lody/components/hooks/use-workspace-context-atoms";
import { WorkspaceRouteTargetProvider } from "@lody/components/providers/workspace-route-target";
import { MobileSessionStack } from "./MobileSessionStack.js";
import { LODY_ARCHIVE_ROUTE, LODY_CHAT_ROUTE, LODY_SESSION_ROUTE } from "./route-ids.js";
import { TerminalTabsHost } from "./TerminalTabsStrip.js";
import { useSidePanel } from "./side-panel.js";
import { useSurfaceTabs } from "./surface-tabs.js";
import { lodyV1SuppressionProps } from "./v1-scope.js";

/** Seam patch 7's props, built once from `LODY_V1_SCOPE`. A constant per module
 * load, not per render: the scope is a build-time decision, and rebuilding the
 * object every render would re-run every memo that depends on it. */
const V1 = lodyV1SuppressionProps();

/** Every address their components navigate to that we render as nothing.
 *
 * The archive left this list when it got its own page; the settings pages have
 * their own reason below. A click on one of these lands on a blank surface
 * rather than throwing, and the surface is never the one a member is looking at
 * — the rail owns what is visible. */
const STUB_PATHS = [
  "/",
  "login",
  "complete-email",
  "workspace/create",
] as const;

/** Every settings page upstream declares, stubbed.
 *
 * X8 WAS A LATENT THROW. This list held the thirteen addresses
 * `use-open-settings.ts` navigates to on mobile, and upstream declares TWENTY
 * pages under `routes/$workspaceName/_auth/settings/`. `router.navigate({ to })`
 * throws on an address the tree does not hold, so the seven that were missing —
 * `agent-config`, `agent-roles`, `devices`, `general`, `mcp`, `my-machines`,
 * `stats` — were one upstream `<Link>` away from crashing the surface.
 *
 * The list is now upstream's own directory listing, so it cannot drift the
 * unsafe way: adding a page upstream and not here is the only remaining gap, and
 * `packages/webapp/test/lody-v1-scope-sources.test.ts` compares the two.
 *
 * NONE OF THEM RENDERS ANYTHING, AND THAT IS THE DECISION. BlitzOS serves its
 * own settings from its own chrome; the vendored affordances that pointed here
 * are deleted rather than wired up (see `v1-scope.ts`). What is left is an
 * address that resolves, which is what stops the throw. */
const SETTINGS_STUB_PATHS = [
  "about",
  "account",
  "agent-config",
  "agent-roles",
  "agents",
  "ai-usage",
  "appearance",
  "billing",
  "devices",
  "general",
  "github",
  "keyboard-shortcuts",
  "machines",
  "mcp",
  "my-machines",
  "people",
  "preferences",
  "projects",
  "stats",
  "workspace",
] as const;

function RouteOutlet() {
  return <Outlet />;
}

function EmptyRoute() {
  return null;
}

/**
 * The `$workspaceName` guard, reduced to the two things the local platform's
 * own guard does (`routes/$workspaceName.tsx`, `LocalWorkspaceGuardRoute`):
 * publish the URL target for descendants, and drive the workspace-context atoms
 * the runtime keys off.
 *
 * The vendored hook does the atom write, not a hand-rolled `setWorkspaceContextAtom`
 * call: it publishes slug and id as ONE transaction and clears only its own
 * scope on unmount, and reproducing that by hand is how the two fall out of step.
 * The slug redirect their guard performs is dropped — our slug comes from the
 * daemon's catalog, so it is canonical by construction.
 *
 * THE SECOND ARGUMENT IS NOT OPTIONAL, AND PHASE 3 PASSED `undefined`.
 *
 * `useWorkspaceContextAtoms` publishes `{ slug, workspaceId: null }` in a
 * layout effect and fills the id in only from its `access` argument
 * (`hooks/use-workspace-context-atoms.ts:34`, gated on
 * `access?.status === 'member' && access.organizationId`). With `undefined`
 * there, `currentWorkspaceIdAtom` stays NULL for the whole life of the surface.
 *
 * That is a silent hole, because `activeWorkspaceRuntimeAtom` resolves from the
 * SLUG (`atoms/runtime.ts:485`) and so still answers `ready` — everything the
 * member normally touches keeps working, and only the consumers that read the
 * id directly break. `useMachineAcpAuthentication` is one of them: both of its
 * entry points guard on `workspaceId == null` and throw
 * `chat.validation.missingContext` — "Workspace context is missing" — which is
 * exactly what the canary box showed when Retry was pressed. Eleven more
 * consumers read the same atom (`use-machine-actions`, `use-remove-local-project`,
 * `use-local-projects-admin`, `sidebar-state`, `settings-machine-tab`, …).
 *
 * The id we pass is the daemon's own `lw_<uuid>` — the same value
 * `useImplicitLocalWorkspace()` hands `RuntimeProvider`, out of the same
 * `/lody/platform` catalog — so `resolveWorkspaceDataScope`'s id check
 * (`lib/workspace-data-scope.ts:32`) agrees rather than flipping every scoped
 * consumer to `switching`. `status: 'member'` is the hook's own gate value; a
 * local workspace has exactly one member and no other role to report.
 */
function workspaceRouteComponent(workspaceId: string) {
  // The shape `useWorkspaceContextAtoms` reads, built once: a fresh object per
  // render would re-run its `access` effect on every render of the route.
  const access = { status: "member", organizationId: workspaceId };
  return function WorkspaceRoute() {
    // SAFETY: `strict: false` returns the params of every active match, and this
    // component is only ever the `$workspaceName` route's own component, so
    // `workspaceName` is the parameter that route declares. The `null` branch
    // below covers the render that happens before a match resolves.
    const params = useParams({ strict: false }) as { workspaceName?: string };
    const slug = params.workspaceName ?? null;
    useWorkspaceContextAtoms(slug, access);
    if (slug === null) return null;
    return (
      <WorkspaceRouteTargetProvider slug={slug}>
        <Outlet />
      </WorkspaceRouteTargetProvider>
    );
  };
}

/**
 * Their `routes/$workspaceName/_auth/_layout`, in the one job BlitzOS needs it
 * for: on a phone the landing and the session are ONE navigation stack, and the
 * stack has to outlive the route change between them.
 *
 * WHY IT HANGS OFF `_auth` AND NOT OFF EITHER LEAF. `MobileSessionStack` keeps
 * `ChatLanding` mounted underneath an open session — that is the whole point of
 * it — so it must live above both addresses. `_auth` is the nearest route both
 * leaves share, which is exactly where upstream puts it: their
 * `MobileWorkspaceLayout` wraps the whole `_auth` subtree and renders the stack
 * beside the `<Outlet/>` (`components/mobile/mobile-workspace-layout.tsx:83-88`).
 *
 * WHY THE OUTLET STILL RENDERS ON A PHONE. Their comment on the same lines says
 * it, and it is not decoration: the leaf components return `null` on mobile but
 * still RUN, and `ChatRoute`'s effect is what publishes the base context the
 * stack reads to keep the right page under an open session.
 *
 * `matchRoute` is asked with the PATH form, `/$workspaceName/chat`, because that
 * is what upstream asks and `_auth` contributes no URL segment.
 */
function authRouteComponent(readOnly: boolean) {
  return function AuthRoute() {
    const isMobile = useIsMobile();
    // SAFETY: `strict: false` returns the params of every active match; this
    // component is a descendant of the `$workspaceName` route, which declares
    // the parameter. `undefined` covers the render before a match resolves.
    const params = useParams({ strict: false }) as { workspaceName?: string };
    const matchRoute = useMatchRoute();
    const workspaceName = params.workspaceName;
    const onStackRoute =
      workspaceName !== undefined
      && (matchRoute({ to: "/$workspaceName/chat" }) !== false
        || matchRoute({ to: "/$workspaceName/sessions/$sessionId" }) !== false);
    return (
      <>
        {isMobile && onStackRoute && workspaceName !== undefined ? (
          <MobileSessionStack workspaceName={workspaceName} readOnly={readOnly} />
        ) : null}
        <Outlet />
      </>
    );
  };
}

/** Their `routes/$workspaceName/_auth/chat.tsx`, mobile branch and all.
 *
 * ON A PHONE THIS ROUTE DRAWS NOTHING AND IS STILL LOAD-BEARING. The landing a
 * phone sees is the stack's, so this component returns `null` — but its effect
 * publishes the machine/project/repo the member was looking at, and the stack
 * reads that atom to keep the right page beneath an open session. Their route
 * does the same thing in the same place (`routes/$workspaceName/_auth/chat.tsx:39`).
 */
function ChatRoute() {
  const { workspaceName } = useParams({ from: "/$workspaceName" });
  const search = useSearch({ from: LODY_CHAT_ROUTE });
  const navigate = useNavigate();
  const surfaceTabs = useSurfaceTabs();
  const isMobile = useIsMobile();
  const setMobileBaseContext = useSetAtom(mobileWorkspaceBaseContextAtom);
  // Selection steering corrects the current address in place; it is not a visit
  // to a new page, so the mirror always replaces (their comment, their rule).
  const onSelectionUrlSync = useCallback(
    (selection: ReturnType<typeof parseChatLandingSearch>) => {
      void navigate({ search: selection, replace: true });
    },
    [navigate],
  );
  useEffect(() => {
    if (!isMobile) return;
    setMobileBaseContext({
      context: search.context,
      machine: search.machine,
      project: search.project,
      repo: search.repo,
    });
  }, [isMobile, search.context, search.machine, search.project, search.repo, setMobileBaseContext]);
  if (isMobile) return null;
  const landing = (
    <ChatLanding
      workspaceSlug={workspaceName}
      preSelectedContext={search.context}
      preSelectedMachine={search.machine}
      preSelectedProject={search.project}
      preSelectedRepo={search.repo}
      resetDraftKey={search.resetDraftKey}
      onSelectionUrlSync={onSelectionUrlSync}
      // Seam patch 7. `hideProductHints` takes the whole hint band, which in a
      // browser always resolves `download-client` and tells a BlitzOS member to
      // install the Lody desktop app (S7), beside a Report-a-bug button that
      // uploads to Lody cloud (S8), a Discord link (S10) and a Go-to-settings
      // button that flips an atom nothing renders (S9).
      hideProductHints={V1.hideProductHints}
      hideAgentRoles={V1.hideAgentRoles}
      // Seam patch 15. On a narrow viewport this landing renders Lody's mobile
      // home, whose connection banner mirrors the desktop `ConnectionPill`:
      // "Connecting… / Reconnecting… / Offline". The BlitzOS footer already says
      // whether the box is reachable, for the whole workspace rather than for
      // this surface.
      hideConnectionStatus={V1.hideConnectionStatus}
    />
  );
  // No shell around this mount contributes tabs — a headless render, a router
  // unit test, a surface mounted against another member's box (§5.1) — so the
  // landing is exactly what phase 4 shipped.
  if (surfaceTabs === null) return landing;
  return <TerminalTabsHost surfaceTabs={surfaceTabs} landing={landing} />;
}

/** Their `routes/$workspaceName/_auth/sessions/$sessionId.tsx`, mobile branch
 * and all.
 *
 * `SessionDetail` is deliberately NOT wrapped in `useDeferredValue`: it IS the
 * session identity boundary, and deferring it lets a message typed during a
 * switch be written to the session the member just left. Their comment on that
 * route says so at length; this mount inherits the rule.
 *
 * ON A PHONE IT RENDERS NOTHING. `MobileSessionStack` draws the session as a
 * drawer over the landing, from this route's own params and search, so drawing
 * it here as well would mount `SessionDetail` twice. Their route returns `null`
 * for the same reason (`:36`). */
function sessionDetailRouteComponent(readOnly: boolean) {
  return function SessionDetailRoute() {
    const { sessionId } = useParams({ from: LODY_SESSION_ROUTE });
    const search = useSearch({ from: LODY_SESSION_ROUTE });
    const surfaceTabs = useSurfaceTabs();
    const isMobile = useIsMobile();
    // The six props of seam patch 5. Absent when no shell contributes tabs,
    // which is the render every upstream call site does and the one the
    // inertness test pins.
    //
    // `onSessionTabSelect` is the RETURN direction and the only one of the five
    // that carries information out of the page. Selecting one of our tabs is an
    // address change we make; selecting a conversation tab is the page's own
    // state, so without this the address would keep naming a terminal that has
    // just been covered over — and hunk 15 would keep drawing it.
    //
    // `onSessionMissing` is the OTHER way the strip can vanish, and the only
    // one the page cannot recover from: it returns above the strip, so no host
    // tab is drawn at all. The host moves its selection to the landing's strip
    // rather than leaving the member on a card with nothing around it.
    const hostTabs = surfaceTabs === null
      ? {}
      : {
          surfaceTabs: surfaceTabs.tabs,
          activeSurfaceTabId: surfaceTabs.activeTabId,
          onSurfaceTabSelect: surfaceTabs.onSelect,
          onSurfaceTabClose: surfaceTabs.onClose,
          onSessionTabSelect: surfaceTabs.onDeselect,
          onSessionMissing: surfaceTabs.onSessionMissing,
        };
    // Seam patches 19 and 20: the right icon strip drives the side panel and
    // our Connections panel lives in it; loopback addresses in the Browser
    // panel resolve through the box gateway. Absent when no shell drives the
    // panel, for the same inertness reason as the six above.
    //
    // The state report goes through a ref so the page's effect reads the
    // latest shell closure without re-running on every render of ours, and
    // `null` on unmount is OURS to send: the page cannot announce that it is
    // gone, and a strip left holding the last state would draw a pressed icon
    // for a panel nobody can see.
    const sidePanel = useSidePanel();
    const onSidePanelStateChange = useRef(sidePanel?.onStateChange ?? null);
    onSidePanelStateChange.current = sidePanel?.onStateChange ?? null;
    useEffect(() => () => {
      onSidePanelStateChange.current?.(null);
    }, []);
    const sidePanelProps = sidePanel === null
      ? {}
      : {
          hostSidePanelTabs: sidePanel.hostTabs,
          sidePanelRequest: sidePanel.request,
          onSidePanelStateChange: sidePanel.onStateChange,
          resolveManagedPreviewViewerUrl: sidePanel.resolveManagedPreviewViewerUrl,
        };
    // Hooks above, the mobile early return below: the phone branch draws the
    // session as a drawer over the landing (see the doc comment).
    if (isMobile) return null;
    return (
      <AppThemeShell>
        <SessionDetail
          sessionId={sessionId}
          urlTab={search.tab}
          urlPrNumber={search.pr}
          urlBrowser={search.browser}
          readOnly={readOnly}
          // Seam patch 6. In a session the agent has not answered yet there is
          // nothing to fork, so the Side Chat launcher takes the `disabled`
          // state it already has for an offline machine instead of accepting a
          // click and answering with an error toast.
          sideChatRequiresAssistantTurn
          // Seam patch 7. `hideCloudMenuItems` takes the header menu's "Change
          // owner" (IC83), "Share with team" (IC84) and "Copy URL" (IC88);
          // `hideNotificationPrompt` takes the OneSignal prompt (IC60);
          // `keyboardShortcutsAvailable` stops `session.focusInput` registering,
          // which is what the composer's ⌘L chip reads (C100) for a chord no
          // dispatcher answers (C102).
          hideCloudMenuItems={V1.hideCloudMenuItems}
          hideNotificationPrompt={V1.hideNotificationPrompt}
          hideAgentRoles={V1.hideAgentRoles}
          keyboardShortcutsAvailable={V1.keyboardShortcutsAvailable}
          // Seam patch 10. `hideLanguageServiceActions` takes Go to Definition
          // and Find References off the editor (SP26): the box runs no language
          // service, so both answered every identifier with "Host language
          // service does not support this file".
          hideLanguageServiceActions={V1.hideLanguageServiceActions}
          // Seam patch 15. The page's own connection story goes dark: the
          // composer status chip's offline states (IC64, "You are offline.
          // Reconnect to sync."), the catch-up spinners in the info bar and the
          // mobile header (IC65), and the file viewer's offline glyph. The
          // footer's `workspace running · box unreachable` covers all of it, and
          // covers the terminal and the files with it. The chip's
          // "machine removed" state is NOT taken: it blocks sending, and the
          // footer says nothing about it.
          hideConnectionStatus={V1.hideConnectionStatus}
          {...hostTabs}
          {...sidePanelProps}
        />
      </AppThemeShell>
    );
  };
}

/**
 * Their `routes/$workspaceName/_auth/archive.tsx`, minus the lazy boundary.
 *
 * The route file wraps `ArchiveView` in `RouteSuspense` and a `lazy()`, because
 * upstream splits it out of an app bundle a member loads on sign-in. This whole
 * surface is already one lazy chunk (`LodySessionsRegion`), so a second boundary
 * inside it would buy a spinner and nothing else.
 *
 * `AppThemeShell` is the session page's own wrapper, and the archive needs it
 * for the same reason: the page paints `bg-background`, which resolves from the
 * theme variables that shell publishes.
 */
function ArchiveRoute() {
  return (
    <AppThemeShell>
      <ArchiveView
        // Seam patch 14. `hideTeamScope` takes the My Tasks / All Tasks control
        // (T25): a local workspace has exactly one member, so both entries list
        // the same sessions. The row's pull-request badge is NOT a prop — it
        // answers `useAppCapability('githubIntegration')`, which the local
        // platform already declines.
        hideTeamScope={V1.hideTeamScope}
      />
    </AppThemeShell>
  );
}

export interface LodySessionDetailSearch {
  tab?: string;
  pr?: number;
  browser?: boolean;
}

/** A positive integer PR number, from either spelling a URL can carry. */
function prNumber(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (isJsonNumber(value)) return Number.isInteger(value) && value > 0 ? value : undefined;
  if (!isJsonString(value) || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

/** Their `browser` flag, which a URL spells `1` or `true` and a state object
 * spells with the boolean. */
function browserFlag(value: JsonValue | undefined): true | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === 1) return true;
  if (isJsonString(value) && (value === "1" || value.toLowerCase() === "true")) return true;
  return undefined;
}

/** Their parser, reproduced because the route file is not importable (it calls
 * `createFileRoute`, which needs their generated tree). */
export function parseSessionDetailSearch(
  search: Record<string, JsonValue>,
): LodySessionDetailSearch {
  const parsed: LodySessionDetailSearch = {};
  const tab = search.tab;
  if (tab !== undefined && isJsonString(tab)) parsed.tab = tab;
  const pr = prNumber(search.pr);
  if (pr !== undefined) parsed.pr = pr;
  const browser = browserFlag(search.browser);
  if (browser !== undefined) parsed.browser = browser;
  return parsed;
}

export { LODY_ARCHIVE_ROUTE, LODY_CHAT_ROUTE, LODY_SESSION_ROUTE } from "./route-ids.js";

/** The router type, stated on our side: `createRouter` is generic over the
 * route tree and the vendor seam erases the component types, so naming the
 * return type is the only way to talk about it. */
export type LodyRouter = ReturnType<typeof createLodySessionRouter>;

export interface LodySessionRouterOptions {
  /** The daemon's own `lw_<uuid>`, published into `currentWorkspaceIdAtom` by
   * the `$workspaceName` route. See `workspaceRouteComponent` for what reads it
   * and what a missing id costs. Absent leaves phase 3's behaviour, and is used
   * only by the router unit tests that mount no runtime. */
  workspaceId?: string;
  /** Every session page this tree renders follows without driving (seam patch
   * 4). Fixed per router, because it is a property of WHOSE box the surface is
   * mounted against, and that never changes under one router. */
  readOnly?: boolean;
  /**
   * Open here instead of on the chat landing.
   *
   * A surface mounted against another member's box has exactly one address it
   * may show: the session that was shared. The landing is the CREATE surface,
   * and creating a session on somebody else's box is not something a share
   * carries (`plans/LODY-SHARING.md` §4.3 — `/control` is refused outright).
   */
  initialSessionId?: string;
}

/**
 * Builds the tree and the router.
 *
 * `initialEntries` opens on the chat landing, which is the address a member
 * with no session selected should see. Phase 4 replaces this with the rail's
 * own selection; phase 3 keeps it because the landing IS the create surface the
 * exit test drives.
 */
export function createLodySessionRouter(
  workspaceSlug: string,
  options: LodySessionRouterOptions = {},
) {
  const rootRoute = createRootRoute({ component: RouteOutlet });

  const topStubs = STUB_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: EmptyRoute }),
  );

  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$workspaceName",
    component: workspaceRouteComponent(options.workspaceId ?? ""),
  });

  // Pathless: it contributes an id segment and no URL segment, exactly as their
  // `_auth.tsx` does. Ours carries no guard at all — the guard it replaces is
  // the cloud organization check, and the local platform has none.
  const authRoute = createRoute({
    getParentRoute: () => workspaceRoute,
    id: "_auth",
    component: authRouteComponent(options.readOnly === true),
  });

  const chatRoute = createRoute({
    getParentRoute: () => authRoute,
    path: "chat",
    component: ChatRoute,
    validateSearch: parseChatLandingSearch,
  });

  const sessionsRoute = createRoute({
    getParentRoute: () => authRoute,
    path: "sessions",
    component: RouteOutlet,
  });

  const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: "$sessionId",
    component: sessionDetailRouteComponent(options.readOnly === true),
    validateSearch: parseSessionDetailSearch,
  });

  const tasksRoute = createRoute({
    getParentRoute: () => authRoute,
    path: "tasks",
    component: RouteOutlet,
  });
  const tasksIndexRoute = createRoute({
    getParentRoute: () => tasksRoute,
    path: "/",
    component: EmptyRoute,
  });
  const taskDetailRoute = createRoute({
    getParentRoute: () => tasksRoute,
    path: "$taskId",
    component: EmptyRoute,
  });

  const settingsRoute = createRoute({
    getParentRoute: () => authRoute,
    path: "settings",
    component: RouteOutlet,
  });
  const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "/",
    component: EmptyRoute,
  });
  const settingsStubs = SETTINGS_STUB_PATHS.map((path) =>
    createRoute({ getParentRoute: () => settingsRoute, path, component: EmptyRoute }),
  );

  // The archive is a real page, not a stub: it is the only surface that lists
  // an archived session, and the only one that can restore or delete one.
  const archiveRoute = createRoute({
    getParentRoute: () => authRoute,
    path: "archive",
    component: ArchiveRoute,
  });

  // `local/$machineId/$localProjectId` is their local-project page. Phase 5
  // gives it a destination; until then it is an address, not a screen.
  const localProjectRoute = createRoute({
    getParentRoute: () => authRoute,
    path: "local/$machineId/$localProjectId",
    component: EmptyRoute,
  });

  const routeTree = rootRoute.addChildren([
    ...topStubs,
    workspaceRoute.addChildren([
      authRoute.addChildren([
        chatRoute,
        sessionsRoute.addChildren([sessionDetailRoute]),
        tasksRoute.addChildren([tasksIndexRoute, taskDetailRoute]),
        settingsRoute.addChildren([settingsIndexRoute, ...settingsStubs]),
        localProjectRoute,
        archiveRoute,
      ]),
    ]),
  ]);

  const initialEntry =
    options.initialSessionId === undefined
      ? `/${workspaceSlug}/chat`
      : `/${workspaceSlug}/sessions/${encodeURIComponent(options.initialSessionId)}`;

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: {},
    // A memory router in a panel has no document to scroll and no address bar.
    scrollRestoration: false,
    defaultPreload: false,
  });
}

/** The session id the router's current address names, or `null` on the landing.
 *
 * Read off the location rather than off a match, because `CloudApp` reads it
 * from a `router.subscribe('onResolved')` callback where no React context is
 * available. */
export function activeSessionIdFromPathname(pathname: string): string | null {
  const match = /^\/[^/]+\/sessions\/([^/?#]+)/u.exec(pathname);
  return match?.[1] ?? null;
}

/** Whether the router's current address is the archive page.
 *
 * Read off the location for the reason `activeSessionIdFromPathname` is: both
 * answers are wanted from a `router.subscribe('onResolved')` callback, where no
 * React context is available. */
export function isArchivePathname(pathname: string): boolean {
  return /^\/[^/]+\/archive\/?(?:[?#]|$)/u.test(pathname);
}
