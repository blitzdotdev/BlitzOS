/**
 * Every address the vendored renderer navigates to exists in our route tree
 * (plans/LODY-RUNTIME-DESIGN.md §4.2).
 *
 * `router.navigate({ to })` THROWS on an address the tree does not contain, and
 * their components navigate to twenty settings pages, the task pages and
 * `/workspace/create` from menus a member can reach at any time. The list is
 * generated from the vendor tree at test time rather than copied, so an upstream
 * merge that adds a destination fails here instead of in a member's click.
 *
 * NOT EVERY ADDRESS IS A STUB. Three of them are real pages — the chat landing,
 * the session detail and the archive — and the archive is the one that moved:
 * it was `WORKSPACE_STUB_PATHS`'s only entry until the archive page landed.
 *
 * A source test, deliberately: importing `router.tsx` pulls the whole vendored
 * renderer (Monaco, three.js, the Loro WASM) for a question that is answered by
 * comparing two lists of strings.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR_SRC = join(here, "..", "..", "..", "vendor", "lody", "packages", "components", "src");
const SCANNED_DIRECTORIES = ["components", "hooks", "lib", "routes"];

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) yield path;
  }
}

/** Every `to: '/…'` and `to="/…"` the vendored renderer names. */
function navigationTargets(): string[] {
  const targets = new Set<string>();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(join(VENDOR_SRC, directory))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bto[:=]\s*["'](\/[^"']*)["']/gu)) {
        const target = match[1];
        if (target !== undefined) targets.add(target);
      }
    }
  }
  return [...targets].sort();
}

/**
 * The addresses `createLodySessionRouter` builds, derived from its own source.
 *
 * Read out of the file rather than restated, so this test cannot pass because
 * two copies of the same list agree with each other.
 */
function declaredAddresses(): Set<string> {
  const source = readFileSync(join(here, "..", "src", "lody", "router.tsx"), "utf8");
  const listed = (name: string): string[] => {
    const block = new RegExp(`const ${name} = \\[([^\\]]*)\\]`, "u").exec(source);
    if (block?.[1] === undefined) throw new Error(`${name} not found in router.tsx`);
    return [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1] as string);
  };
  const addresses = new Set<string>(["/"]);
  for (const path of listed("STUB_PATHS")) addresses.add(path === "/" ? "/" : `/${path}`);
  for (const path of listed("SETTINGS_STUB_PATHS")) {
    addresses.add(`/$workspaceName/settings/${path}`);
  }
  for (const path of [
    "/$workspaceName/chat",
    "/$workspaceName/sessions",
    "/$workspaceName/sessions/$sessionId",
    // A real page, not a stub: `archiveRoute` renders `ArchiveView`.
    "/$workspaceName/archive",
    "/$workspaceName/settings",
    "/$workspaceName/tasks",
    "/$workspaceName/tasks/$taskId",
    "/$workspaceName/local/$machineId/$localProjectId",
  ]) {
    addresses.add(path);
  }
  return addresses;
}

describe("the Lody memory router", () => {
  it("declares a route for every address the vendored renderer navigates to", () => {
    const declared = declaredAddresses();
    const missing = navigationTargets().filter((target) => !declared.has(target));
    expect(missing).toEqual([]);
  });

  it("finds targets at all, so an empty scan cannot pass vacuously", () => {
    expect(navigationTargets().length).toBeGreaterThan(15);
  });

  it("gives the archive a component rather than the empty stub", () => {
    // The whole point of the page: `/$workspaceName/archive` used to resolve to
    // `EmptyRoute`, so the rail's Archive entry — once it existed — would have
    // landed on a blank surface instead of the archived-session list.
    const source = readFileSync(join(here, "..", "src", "lody", "router.tsx"), "utf8");
    expect(source).toContain('path: "archive",');
    expect(source).toContain("component: ArchiveRoute,");
    expect(source).not.toContain("WORKSPACE_STUB_PATHS");
  });
});
