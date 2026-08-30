/**
 * The memory-history route tree the vendored Lody pages mount in
 * (plans/LODY-RUNTIME-DESIGN.md §4.2).
 *
 * WHY OUR OWN TREE AND NOT THEIRS. Their pages are TanStack FILE routes
 * (`vendor/lody/packages/components/src/routes/**`), generated into a
 * `routeTree.gen.ts` that only exists inside their app builds, and the tree's
 * roots are cloud surfaces we do not mount: `__root.tsx` builds the Convex/
 * better-auth stack, and `$workspaceName/_auth.tsx` runs the organization and
 * session guards. What we want out of that tree is exactly two leaves — the
 * chat landing and the session detail — so this file declares those two with
 * their real components and stubs every other address their code navigates to.
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
 * the tree does not contain, and their components navigate to fourteen settings
 * pages, the archive, the task pages and `/workspace/create` from menus a
 * member can reach at any time. The list is generated, not guessed:
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
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { isJsonNumber, isJsonString, type JsonValue } from "@blitzos/schema";
import { ChatLanding } from "@lody/components/components/chat/chat-landing";
import { parseChatLandingSearch } from "@lody/components/components/chat/chat-landing-derived";
import SessionDetail from "@lody/components/components/sessions/session-detail";
import { AppThemeShell } from "@lody/components/components/app-theme-shell";
import { useWorkspaceContextAtoms } from "@lody/components/hooks/use-workspace-context-atoms";
import { WorkspaceRouteTargetProvider } from "@lody/components/providers/workspace-route-target";

/** Every address their components navigate to that we render as nothing.
 *
 * Phase 4 gives some of these real destinations (the archive and the settings
 * pages are products in their own right). Until then a click lands on a blank
 * surface rather than throwing, and the surface is never the one a member is
 * looking at — the rail owns what is visible. */
const STUB_PATHS = [
  "/",
  "login",
  "complete-email",
  "workspace/create",
] as const;

const WORKSPACE_STUB_PATHS = ["archive"] as const;

const SETTINGS_STUB_PATHS = [
  "about",
  "account",
  "agents",
  "ai-usage",
  "appearance",
  "billing",
  "github",
  "keyboard-shortcuts",
  "machines",
  "people",
  "preferences",
  "projects",
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
 */
function WorkspaceRoute() {
  // SAFETY: `strict: false` returns the params of every active match, and this
  // component is only ever the `$workspaceName` route's own component, so
  // `workspaceName` is the parameter that route declares. The `null` branch
  // below covers the render that happens before a match resolves.
  const params = useParams({ strict: false }) as { workspaceName?: string };
  const slug = params.workspaceName ?? null;
  useWorkspaceContextAtoms(slug, undefined);
  if (slug === null) return null;
  return (
    <WorkspaceRouteTargetProvider slug={slug}>
      <Outlet />
    </WorkspaceRouteTargetProvider>
  );
}

/** Their `routes/$workspaceName/_auth/chat.tsx`, minus the mobile branch. */
function ChatRoute() {
  const { workspaceName } = useParams({ from: "/$workspaceName" });
  const search = useSearch({ from: "/$workspaceName/_auth/chat" });
  const navigate = useNavigate();
  // Selection steering corrects the current address in place; it is not a visit
  // to a new page, so the mirror always replaces (their comment, their rule).
  const onSelectionUrlSync = useCallback(
    (selection: ReturnType<typeof parseChatLandingSearch>) => {
      void navigate({ search: selection, replace: true });
    },
    [navigate],
  );
  return (
    <ChatLanding
      workspaceSlug={workspaceName}
      preSelectedContext={search.context}
      preSelectedMachine={search.machine}
      preSelectedProject={search.project}
      preSelectedRepo={search.repo}
      resetDraftKey={search.resetDraftKey}
      onSelectionUrlSync={onSelectionUrlSync}
    />
  );
}

/** Their `routes/$workspaceName/_auth/sessions/$sessionId.tsx`, minus mobile.
 *
 * `SessionDetail` is deliberately NOT wrapped in `useDeferredValue`: it IS the
 * session identity boundary, and deferring it lets a message typed during a
 * switch be written to the session the member just left. Their comment on that
 * route says so at length; this mount inherits the rule. */
function sessionDetailRouteComponent(readOnly: boolean) {
  return function SessionDetailRoute() {
    const { sessionId } = useParams({ from: "/$workspaceName/_auth/sessions/$sessionId" });
    const search = useSearch({ from: "/$workspaceName/_auth/sessions/$sessionId" });
    return (
      <AppThemeShell>
        <SessionDetail
          sessionId={sessionId}
          urlTab={search.tab}
          urlPrNumber={search.pr}
          urlBrowser={search.browser}
          readOnly={readOnly}
        />
      </AppThemeShell>
    );
  };
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

export const LODY_CHAT_ROUTE = "/$workspaceName/_auth/chat";
export const LODY_SESSION_ROUTE = "/$workspaceName/_auth/sessions/$sessionId";

/** The router type, stated on our side: `createRouter` is generic over the
 * route tree and the vendor seam erases the component types, so naming the
 * return type is the only way to talk about it. */
export type LodyRouter = ReturnType<typeof createLodySessionRouter>;

export interface LodySessionRouterOptions {
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
    component: WorkspaceRoute,
  });

  // Pathless: it contributes an id segment and no URL segment, exactly as their
  // `_auth.tsx` does. Ours carries no guard at all — the guard it replaces is
  // the cloud organization check, and the local platform has none.
  const authRoute = createRoute({
    getParentRoute: () => workspaceRoute,
    id: "_auth",
    component: RouteOutlet,
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

  const workspaceStubs = WORKSPACE_STUB_PATHS.map((path) =>
    createRoute({ getParentRoute: () => authRoute, path, component: EmptyRoute }),
  );

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
        ...workspaceStubs,
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
