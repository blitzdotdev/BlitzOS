import { env } from "cloudflare:test";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { API_PREFIXES, WORKER_SOURCE } from "../scripts/build-blitzdev.mjs";
// The committed template, never the gitignored wrangler.toml: a local copy
// is per-deployment and may have drifted, which would make this gate report
// on a file no other clone has.
import wranglerExample from "../wrangler.toml.example?raw";

// The managed-worker prefix check is vendor-only (blitz.dev deployment);
// the wrangler.toml.example check below always runs.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

const coreSources = import.meta.glob<string>(["../core/**/*.ts", "../core/**/*.js"], {
  eager: true,
  import: "default",
  query: "?raw",
});

const ROUTE_REGISTRATION = /\brouter\.(?:get|post|put|patch|delete)\s*\(/gu;
const LITERAL_ROUTE_PATH = /\brouter\.(?:get|post|put|patch|delete)\s*\(\s*(["'`])(\/[^"'`]+)\1/gu;

// Add a segment here only when its core routes should intentionally remain asset-served.
const INTENTIONALLY_ASSET_SERVED_SEGMENTS = new Set<string>();

interface AssetRoutingConfig {
  run_worker_first?: unknown;
}

function firstSegment(routePath: string): string {
  const segment = /^\/([^/*:]+)/u.exec(routePath)?.[1];
  if (segment === undefined) throw new Error(`route has no static first segment: ${routePath}`);
  return segment;
}

function coreRoutePaths(): string[] {
  const paths: string[] = [];
  for (const [sourcePath, source] of Object.entries(coreSources)) {
    const registrations = [...source.matchAll(ROUTE_REGISTRATION)];
    const literalPaths = [...source.matchAll(LITERAL_ROUTE_PATH)].map((match) => match[2]!);
    expect(literalPaths, `${sourcePath} must use literal core route paths`).toHaveLength(registrations.length);
    paths.push(...literalPaths);
  }
  return paths;
}

function requiredCoreSegments(): string[] {
  const routeSegments = new Set(coreRoutePaths().map(firstSegment));
  expect(
    [...INTENTIONALLY_ASSET_SERVED_SEGMENTS].filter((segment) => !routeSegments.has(segment)),
    "asset-served exclusions must name registered core route segments",
  ).toEqual([]);
  return [...routeSegments]
    .filter((segment) => !INTENTIONALLY_ASSET_SERVED_SEGMENTS.has(segment))
    .sort();
}

describe("core route asset precedence", () => {
  it("runs every core route segment through the standalone Worker", () => {
    const config = parse(wranglerExample);
    // SAFETY: The array and every entry are validated immediately below before use.
    const assets = config.assets as AssetRoutingConfig;
    const runWorkerFirst = assets.run_worker_first;
    if (
      !Array.isArray(runWorkerFirst)
      || !runWorkerFirst.every((prefix) => String(prefix) === prefix)
    ) throw new Error("assets.run_worker_first must be a string array");

    const wranglerSegments = new Set(runWorkerFirst.map((prefix) => firstSegment(String(prefix))));
    expect(
      requiredCoreSegments().filter((segment) => !wranglerSegments.has(segment)),
      "wrangler assets.run_worker_first is missing core route segments",
    ).toEqual([]);
  });

  it.skipIf(!managedToolchainEnabled)("runs every core route segment through the managed Worker [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
    const managedWorkerSegments = new Set(API_PREFIXES.map(firstSegment));
    expect(WORKER_SOURCE).toContain("/^\\/recipes\\/[^/]+\\/fire-token$/u.test(pathname)");
    managedWorkerSegments.add(firstSegment("/recipes/:id/fire-token"));
    expect(
      requiredCoreSegments().filter((segment) => !managedWorkerSegments.has(segment)),
      "managed-worker API_PREFIXES is missing core route segments",
    ).toEqual([]);
  });
});
