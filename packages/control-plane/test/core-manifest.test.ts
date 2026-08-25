import { describe, expect, it } from "vitest";
import { CORE_MANIFEST } from "../scripts/build-blitzdev.mjs";

// CORE_MANIFEST is a hand-typed list of every core/ file the worker build
// bundles. It must mirror the folder exactly. A pull request deleted one core
// file and added another, but left the list alone. All three gates passed. CI
// then failed the managed build with ENOENT on the deleted path. This test is
// the gate that was missing. It also catches the worse direction. A core file
// absent from the list ships a worker without it.
//
// This test stays ungated on purpose. The managed emitter suites are
// vendor-only, but the list is plain repo content. A fork that edits core/
// must see the drift too, so a bare `npm test` runs this check.

// The Worker pool has no disk, so Vite globs the folder at transform time.
const coreFiles = import.meta.glob(["../core/**/*.ts", "../core/**/*.js"]);

describe("managed core manifest", () => {
  it("lists exactly the files in core/", () => {
    const onDisk = new Set(Object.keys(coreFiles).map((key) => key.replace("../", "")));
    const listed = new Set<string>(CORE_MANIFEST);

    // toEqual([]) rather than a count check: a failure prints the paths.
    expect(
      [...listed].filter((uploadPath) => !onDisk.has(uploadPath)).sort(),
      "CORE_MANIFEST names files core/ does not have. Delete them from CORE_MANIFEST in scripts/lib/worker-source.mjs.",
    ).toEqual([]);
    expect(
      [...onDisk].filter((uploadPath) => !listed.has(uploadPath)).sort(),
      "core/ has files CORE_MANIFEST does not name. Add them to CORE_MANIFEST in scripts/lib/worker-source.mjs.",
    ).toEqual([]);
  });
});
