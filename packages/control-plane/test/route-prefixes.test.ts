import { env } from "cloudflare:test";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  coreRoutePaths,
  devProxyPatterns,
  FRAMEWORK_ROUTE_PATHS,
  managedApiExactPaths,
  managedApiPrefixes,
  runWorkerFirstEntries,
} from "../scripts/lib/worker-first-routes.mjs";
// The committed template, never the gitignored wrangler.toml: a local copy
// is per-deployment and may have drifted, which would make this gate report
// on a file no other clone has.
import wranglerExample from "../wrangler.toml.example?raw";

// This suite used to assert that a hand-written run_worker_first array covered
// every core route. The array is generated now, so what needs a gate is the
// generator: does it still claim a request to every path core registers, and is
// the copy in wrangler.toml.example — which `wrangler types` and the vitest
// Workers pool read — the one the generator produces? A core route the
// generator missed would be served the SPA shell with status 200 instead of the
// route, which is how /version reached production unrouted.
//
// The managed-worker check is vendor-only (blitz.dev deployment); everything
// else always runs.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

// The generator reads core/ from disk. A Worker-pool test has no disk, so the
// same bytes arrive through Vite's ?raw glob and go through the same pure
// functions the deploy calls.
const rawCore = import.meta.glob<string>(["../core/**/*.ts", "../core/**/*.js"], {
  eager: true,
  import: "default",
  query: "?raw",
});

interface AssetRoutingConfig {
  run_worker_first?: unknown;
}

/** Every literal route path core registers, plus the framework's own. */
function routePaths(): string[] {
  const sources = Object.entries(rawCore).map(([sourcePath, source]) => ({ path: sourcePath, source }));
  const { paths, nonLiteral } = coreRoutePaths(sources);
  expect(nonLiteral, "core routes must be registered with literal paths").toEqual([]);
  expect(paths.length, "no core route registrations were found at all").toBeGreaterThan(0);
  return [...paths, ...FRAMEWORK_ROUTE_PATHS];
}

/**
 * One concrete request path per route: parameters and trailing wildcards filled
 * in, so the entries are checked the way a request meets them.
 */
function sampleRequestPath(routePath: string): string {
  if (routePath === "/") return "/";
  return routePath
    .split("/")
    .map((segment) => (segment.startsWith(":") || segment === "*" ? "sample" : segment))
    .join("/");
}

/** A run_worker_first entry as the asset router reads it: `*` matches anything. */
function matchesEntry(entry: string, pathname: string): boolean {
  const pattern = entry
    .split("*")
    .map((literal) => literal.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join(".*");
  return new RegExp(`^${pattern}$`, "u").test(pathname);
}

function runWorkerFirstFromExample(): string[] {
  const config = parse(wranglerExample);
  // SAFETY: The array and every entry are validated immediately below before use.
  const assets = config.assets as AssetRoutingConfig;
  const runWorkerFirst = assets.run_worker_first;
  if (
    !Array.isArray(runWorkerFirst)
    || !runWorkerFirst.every((prefix) => String(prefix) === prefix)
  ) throw new Error("assets.run_worker_first must be a string array");
  return runWorkerFirst.map((prefix) => String(prefix));
}

// Paths the SPA owns. The last two only start like a route: "/me*" would claim
// "/members" and "/menu", which is why the generator emits an exact entry for a
// segment that has no children.
const SPA_PATHS = [
  "/index.html",
  "/assets/index-abcd1234.js",
  "/landing.css",
  "/members-directory",
  "/menu",
];

describe("core route asset precedence", () => {
  it("claims a request to every route core registers", () => {
    const entries = runWorkerFirstEntries(routePaths());
    const unclaimed = routePaths()
      .map(sampleRequestPath)
      .filter((pathname) => !entries.some((entry) => matchesEntry(entry, pathname)));
    expect(unclaimed, "the derived run_worker_first list lets the asset handler answer these").toEqual([]);
  });

  it("leaves the SPA's own paths to the asset handler", () => {
    const entries = runWorkerFirstEntries(routePaths());
    const claimed = SPA_PATHS.filter((pathname) => entries.some((entry) => matchesEntry(entry, pathname)));
    expect(claimed, "these would be routed through the Worker and answered as a JSON 404").toEqual([]);
  });

  it("keeps wrangler.toml.example in step with the generator", () => {
    expect(
      runWorkerFirstFromExample(),
      "wrangler.toml.example is stale — run `npm run routes:sync -w packages/control-plane`",
    ).toEqual(runWorkerFirstEntries(routePaths()));
  });

  it("routes the root exactly, and never as a prefix", () => {
    // The marketing home. "/*" here would send every asset request — the SPA
    // bundle, the icons, landing.css — through the Worker.
    const withRoot = ["/", "/version", "/workspaces/:id"];
    expect(runWorkerFirstEntries(withRoot)).toContain("/");
    expect(runWorkerFirstEntries(withRoot)).not.toContain("/*");
    expect(SPA_PATHS.filter((pathname) =>
      runWorkerFirstEntries(withRoot).some((entry) => matchesEntry(entry, pathname)),
    )).toEqual([]);
    expect(devProxyPatterns(withRoot)).toContain("^/$");
    // The managed Worker prefix-matches, so the root can only ever be an exact
    // path there: startsWith("/") is true of every request in the deployment.
    expect(managedApiExactPaths(withRoot)).toContain("/");
    expect(managedApiPrefixes(withRoot)).not.toContain("/");
  });

  it("proxies a request to every route in dev, and nothing that merely looks like one", () => {
    const patterns = devProxyPatterns(routePaths()).map((pattern) => new RegExp(pattern, "u"));
    const unproxied = routePaths()
      .map(sampleRequestPath)
      .filter((pathname) => !patterns.some((pattern) => pattern.test(pathname)));
    expect(unproxied, "vite dev would answer these with the SPA shell").toEqual([]);
    expect(SPA_PATHS.filter((pathname) => patterns.some((pattern) => pattern.test(pathname)))).toEqual([]);
  });

  it.skipIf(!managedToolchainEnabled)("runs every core route through the managed Worker [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
    const exactPaths = managedApiExactPaths(routePaths());
    const prefixes = managedApiPrefixes(routePaths());
    // The predicate the emitted worker.ts uses, verbatim.
    const isApiPath = (pathname: string) =>
      exactPaths.includes(pathname) || prefixes.some((prefix) => pathname.startsWith(prefix));
    expect(routePaths().map(sampleRequestPath).filter((pathname) => !isApiPath(pathname))).toEqual([]);
    expect(SPA_PATHS.filter(isApiPath)).toEqual([]);
  });
});
