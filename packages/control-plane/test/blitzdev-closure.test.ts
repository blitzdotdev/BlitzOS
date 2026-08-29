import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  UPLOAD_ENTRY_POINTS,
  assertClosedUploadSet,
  closureReport,
  moduleClosure,
  resolveUploadPath,
} from "../scripts/build-blitzdev.mjs";
import { managedUploadSet } from "./managed-upload-set.js";

// Vendor-only: the closure gate for the blitz.dev managed upload set, which
// forks do not deploy. Skipped unless BLITZDEV_MANAGED=1.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

// Why this suite exists. The managed platform ships source files, not a
// bundle. Every relative import in the upload set must resolve to another
// uploaded file; when one does not, the platform's bundler silently marks it
// external, still answers `bundle.ok: true`, and the deployed Worker throws
// WORKER_RUNTIME_ERROR on every route. Run 2 lost a deploy to exactly that:
// core/compute/aws.ts joined the graph at #11 and nothing added it to
// CORE_MANIFEST, so 10 modules were missing and no gate noticed. #13 then
// added two more catalog providers. A hand-maintained manifest rots silently
// unless something walks the graph — this is that something.

interface UploadEntry {
  path: string;
  source: string;
}

function entriesOf(uploadSet: ReturnType<typeof managedUploadSet>): UploadEntry[] {
  return uploadSet.files.map((file) => ({ path: file.path, source: file.source }));
}

function without(entries: UploadEntry[], dropped: string): UploadEntry[] {
  return entries.filter((entry) => entry.path !== dropped);
}

describe.skipIf(!managedToolchainEnabled)("blitz.dev managed module closure [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
  it("resolves every relative import in the upload set to an uploaded file", () => {
    const closure = moduleClosure(entriesOf(managedUploadSet()));

    // toEqual([]) rather than a length check: a failure prints the missing
    // files and their importers, which is the whole point of the gate.
    expect(closure.missing).toEqual([]);
  });

  it("ships no file the entry points cannot reach", () => {
    const closure = moduleClosure(entriesOf(managedUploadSet()));

    expect(closure.unreachable).toEqual([]);
    expect(closure.reachable).toHaveLength(managedUploadSet().files.length);
  });

  it("walks from both platform entry points", () => {
    expect(UPLOAD_ENTRY_POINTS).toEqual(["worker.ts", "teenybase.ts"]);
    // teenybase.ts is loaded by the platform, never imported. Dropping it from
    // the entry points would make it read as dead weight.
    const workerOnly = moduleClosure(entriesOf(managedUploadSet()), ["worker.ts"]);
    expect(workerOnly.unreachable).toEqual(["teenybase.ts"]);
  });

  it("names the missing file and every importer that wanted it", () => {
    // The exact regression run 2 hit: a module in the graph, absent from the
    // manifest. core/webapp-tickets.ts had five importers there.
    const broken = without(entriesOf(managedUploadSet()), "core/webapp-tickets.ts");
    const closure = moduleClosure(broken);
    const report = closureReport(closure);

    expect(closure.missing.length).toBeGreaterThan(0);
    expect(closure.missing.every((miss) => miss.target === "core/webapp-tickets")).toBe(true);
    expect(report).toContain("MISSING core/webapp-tickets");
    expect(report).toContain("<- core/index.ts");
    expect(report).toContain("<- core/workspace-tunnels.ts");
    // Both spellings reach the same file from different depths.
    expect(report).toContain("(./webapp-tickets)");
    expect(report).toContain("(../webapp-tickets)");
  });

  it("names dead weight when a file stops being reachable", () => {
    // Credential validation imports SigV4 and XML parsing directly now, so
    // dropping aws.ts strands only its price catalog.
    const broken = without(entriesOf(managedUploadSet()), "core/compute/aws.ts");
    const report = closureReport(moduleClosure(broken));

    expect(report).toContain("MISSING core/compute/aws");
    expect(report).toContain("UNREACHABLE core/compute/aws-prices.ts");
  });

  it("fails the emitter, not just the suite, on an unclosed graph", () => {
    const closed = entriesOf(managedUploadSet());
    expect(() => assertClosedUploadSet(closed)).not.toThrow();
    expect(() => assertClosedUploadSet(without(closed, "core/preview.ts")))
      .toThrow(/upload set is not a closed module graph[\s\S]*MISSING core\/preview\t\(\.\/preview\)\t<- core\/webapp-state\.ts/u);
  });

  it("resolves extensionless specifiers onto the extension actually uploaded", () => {
    const uploaded = new Set(["core/http.ts", "core/signup-config.js", "core/connections/catalog/index.ts"]);

    // The .ts case: what the emitter's normalization produces everywhere.
    expect(resolveUploadPath("core/runtime.ts", "./http", uploaded)).toBe("core/http.ts");
    // The genuine .js case: two core modules really are plain JS, and dropping
    // the extension must still land on them.
    expect(resolveUploadPath("core/runtime.ts", "./signup-config", uploaded)).toBe("core/signup-config.js");
    // Directory index, and the miss that must stay a miss.
    expect(resolveUploadPath("core/connections/mint.ts", "./catalog", uploaded)).toBe("core/connections/catalog/index.ts");
    expect(resolveUploadPath("core/runtime.ts", "./nope", uploaded)).toBeNull();
  });
});
