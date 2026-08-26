// The one source of truth for "which paths must the Worker handle instead of
// the static asset server".
//
// That fact used to be hand-maintained in four places: assets.run_worker_first
// in wrangler.toml.example, the same array inside the CANARY_WRANGLER_TOML and
// PROD_WRANGLER_TOML deployment secrets, API_PREFIXES in the managed-worker
// emitter, and the dev-proxy list in packages/webapp/vite.config.ts. Adding a
// route and forgetting one of them is silent: a core route absent from
// run_worker_first is served the SPA shell with status 200 instead of the
// route. It shipped twice.
//
// So it is derived instead. Core registers its routes with literal paths, this
// module reads them off disk, and every consumer asks this module:
//
//   - scripts/deploy.mjs patches assets.run_worker_first into the deployment's
//     wrangler.toml right before `wrangler deploy` (so the stored secrets never
//     need the array again — whatever they hold is overwritten),
//   - scripts/lib/worker-source.mjs bakes the managed Worker's routing arrays
//     into the emitted source,
//   - packages/webapp/vite.config.ts imports it for the dev proxy,
//   - wrangler.toml.example keeps a generated copy, because `wrangler types`
//     and the vitest Workers pool read the file rather than this module.
//
// Plain Node with `fs` on purpose: the deploy runs on disk, long before any
// bundler exists. The pure half (everything that takes route paths as an
// argument) is also fed by vite's import.meta.glob from the test suite.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "../..");

/** packages/control-plane/core — the directory route registrations live in. */
export const CORE_DIR = path.join(PACKAGE_DIR, "core");

/** The exact root path. It has no segment, so it is never a prefix. */
export const ROOT_ROUTE_PATH = "/";

// `all` is included: core/connections/proxy.ts and core/workspaces.ts register
// their pass-through routes with router.all, and dropping them from the scan
// would drop /proxy and the workspace webApp paths out of run_worker_first.
export const ROUTE_REGISTRATION = /\brouter\.(?:all|get|post|put|patch|delete)\s*\(/gu;
// The path charset excludes $ { } so an interpolated template literal —
// router.get(`/${prefix}/x`) — fails to match and is reported as a
// registration the scan could not read, instead of being taken at face value
// as the literal route "/${prefix}/x".
export const LITERAL_ROUTE_PATH =
  /\brouter\.(?:all|get|post|put|patch|delete)\s*\(\s*(["'`])(\/[^"'`${}]*)\1/gu;

// Paths the framework mounts, not core. teenybase serves its REST API under
// /api (`_apiBase = "/api"` in teenybase/worker/$Database.js), so no
// router.<method> call in core/ names it and the scan cannot see it. It is
// written as a route path so it flows through exactly the same shaping as a
// core route instead of being special-cased in three consumers.
export const FRAMEWORK_ROUTE_PATHS = Object.freeze(["/api/v1"]);

/**
 * The static first segment of a route path.
 *
 * Throws for the root path: "/" has no segment, and the callers below must
 * decide what an entry with no segment means rather than inherit a guess.
 *
 * @param {string} routePath a literal route path, e.g. "/workspaces/:id"
 * @returns {string} e.g. "workspaces"
 */
export function firstSegment(routePath) {
  const segment = /^\/([^/*:]+)/u.exec(routePath)?.[1];
  if (segment === undefined) throw new Error(`route has no static first segment: ${routePath}`);
  return segment;
}

/**
 * @typedef {{ segment: string, exact: boolean, subtree: boolean }} SegmentRouting
 * @typedef {{ root: boolean, segments: SegmentRouting[] }} RoutingPlan
 * @typedef {{ path: string, source: string }} SourceFile
 */

/**
 * Groups route paths by first segment, recording whether the segment is itself
 * a route ("/me") and whether anything lives under it ("/members/:id").
 *
 * Both are needed. A single per-segment prefix cannot express the list: "/me*"
 * also claims "/members" and "/menu", which is why "/me" was hand-written as
 * the one exact entry. Asking the two questions separately makes every entry
 * fall out of the routes themselves.
 *
 * @param {readonly string[]} routePaths literal route paths
 * @returns {RoutingPlan} the root flag and one record per first segment, sorted
 */
export function routingPlan(routePaths) {
  let root = false;
  /** @type {Map<string, SegmentRouting>} */
  const bySegment = new Map();
  for (const routePath of routePaths) {
    if (routePath === ROOT_ROUTE_PATH) {
      root = true;
      continue;
    }
    const segment = firstSegment(routePath);
    const routing = bySegment.get(segment) ?? { segment, exact: false, subtree: false };
    if (routePath === `/${segment}`) routing.exact = true;
    else routing.subtree = true;
    bySegment.set(segment, routing);
  }
  const segments = [...bySegment.values()].sort((left, right) =>
    left.segment < right.segment ? -1 : 1,
  );
  return { root, segments };
}

/**
 * Entries for `assets.run_worker_first` in a wrangler config.
 *
 * The root entry is exact and stays exact. "/*" there would route every asset
 * request — the SPA bundle, the icons, landing.css — through the Worker, which
 * is the one failure this whole module exists to prevent.
 *
 * @param {readonly string[]} routePaths literal route paths
 * @returns {string[]} run_worker_first entries, deterministic order
 */
export function runWorkerFirstEntries(routePaths) {
  const plan = routingPlan(routePaths);
  const entries = plan.root ? [ROOT_ROUTE_PATH] : [];
  for (const { segment, exact, subtree } of plan.segments) {
    if (exact) entries.push(`/${segment}`);
    if (subtree) entries.push(`/${segment}/*`);
  }
  return entries;
}

/**
 * Paths the managed Worker matches exactly.
 *
 * The managed Worker prefix-matches (`pathname.startsWith(prefix)`), so the
 * root can never be a prefix there: "/" claims every path in the deployment.
 * It is an exact match instead, alongside the segments that are routes in
 * their own right.
 *
 * @param {readonly string[]} routePaths literal route paths
 * @returns {string[]} exact pathnames
 */
export function managedApiExactPaths(routePaths) {
  const plan = routingPlan(routePaths);
  const paths = plan.root ? [ROOT_ROUTE_PATH] : [];
  for (const { segment, exact } of plan.segments) if (exact) paths.push(`/${segment}`);
  return paths;
}

/**
 * Prefixes the managed Worker matches with `startsWith`.
 *
 * Each keeps its trailing slash, so "/members/" claims "/members/self" and
 * leaves "/members-directory" to the asset handler.
 *
 * @param {readonly string[]} routePaths literal route paths
 * @returns {string[]} pathname prefixes
 */
export function managedApiPrefixes(routePaths) {
  return routingPlan(routePaths)
    .segments.filter(({ subtree }) => subtree)
    .map(({ segment }) => `/${segment}/`);
}

const REGEXP_METACHARACTER = /[.*+?^${}()|[\]\\]/gu;

/**
 * Keys for vite's dev-server proxy.
 *
 * Every key is anchored. Vite treats a plain string key as "any URL starting
 * with this", which would proxy /members-directory to the control plane
 * because /members is a route; an anchored pattern matches the route and
 * nothing that merely spells like it. Vite reads a key beginning with "^" as a
 * RegExp, tested against the request URL — query string included, hence the
 * "?" alternative.
 *
 * @param {readonly string[]} routePaths literal route paths
 * @returns {string[]} vite proxy keys, deterministic order
 */
export function devProxyPatterns(routePaths) {
  const plan = routingPlan(routePaths);
  const patterns = plan.root ? ["^/$"] : [];
  for (const { segment, exact } of plan.segments) {
    const literal = segment.replace(REGEXP_METACHARACTER, "\\$&");
    patterns.push(exact ? `^/${literal}(?:$|[/?])` : `^/${literal}/`);
  }
  return patterns;
}

/**
 * Literal route paths found in core sources, and the files that hid one.
 *
 * A registration whose path is not a literal cannot be derived from, and a
 * route nobody can see is exactly the failure mode this replaces, so the count
 * of registrations and the count of literals must agree file by file.
 *
 * @param {readonly SourceFile[]} sources core source files
 * @returns {{paths: string[], nonLiteral: {path: string, registrations: number, literals: number}[]}}
 */
export function coreRoutePaths(sources) {
  const paths = [];
  const nonLiteral = [];
  for (const { path: sourcePath, source } of sources) {
    const registrations = [...source.matchAll(ROUTE_REGISTRATION)].length;
    const literals = [...source.matchAll(LITERAL_ROUTE_PATH)].map((match) => match[2]);
    if (literals.length !== registrations) {
      nonLiteral.push({ path: sourcePath, registrations, literals: literals.length });
    }
    paths.push(...literals);
  }
  return { paths, nonLiteral };
}

/**
 * Reads every core source file off disk, sorted, so the derived lists are
 * stable across machines and filesystems.
 *
 * @param {string} coreDir absolute path to packages/control-plane/core
 * @returns {SourceFile[]} one entry per .ts/.js file under coreDir
 */
export function readCoreSources(coreDir = CORE_DIR) {
  /** @type {SourceFile[]} */
  const sources = [];
  /** @param {string} directory */
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.(?:ts|js)$/u.test(entry.name)) continue;
      sources.push({ path: path.relative(coreDir, absolute), source: readFileSync(absolute, "utf8") });
    }
  };
  walk(coreDir);
  return sources;
}

/**
 * Every path the Worker must answer: the core routes plus the framework's.
 *
 * Fails closed. A core file that registers a route the scan cannot read stops
 * the deploy here, where the message names the file, instead of shipping a
 * route that answers the SPA shell with status 200.
 *
 * @param {string} coreDir absolute path to packages/control-plane/core
 * @returns {string[]} literal route paths
 */
export function deriveCoreRoutePaths(coreDir = CORE_DIR) {
  const { paths, nonLiteral } = coreRoutePaths(readCoreSources(coreDir));
  if (nonLiteral.length > 0) {
    const detail = nonLiteral
      .map(({ path: file, registrations, literals }) => `  ${file}: ${literals} of ${registrations}`);
    throw new Error(
      "core route paths must be string literals so the Worker-first route list can be derived from them:\n" +
        detail.join("\n") +
        "\nWrite the path inline in the router.<method>(...) call, or the route is served the SPA shell with status 200.",
    );
  }
  return [...paths, ...FRAMEWORK_ROUTE_PATHS];
}

/**
 * The generated `assets.run_worker_first` array.
 *
 * @param {string} coreDir absolute path to packages/control-plane/core
 * @returns {string[]} run_worker_first entries
 */
export function deriveRunWorkerFirst(coreDir = CORE_DIR) {
  return runWorkerFirstEntries(deriveCoreRoutePaths(coreDir));
}
