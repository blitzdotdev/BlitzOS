import { describe, expect, it } from "vitest";
import type { VersionReport } from "../core/version.js";
import { appRequest, harness } from "./helpers.js";

// The workers pool sandboxes the filesystem, so fixtures load the way every
// other conformance suite here loads them: as raw modules at build time.
const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/version/*.json",
  { eager: true, import: "default", query: "?raw" },
);

describe("GET /version", () => {
  it("answers without a session", async () => {
    const { app } = harness();
    const response = await appRequest(app, "/version");
    expect(response.status).toBe(200);
  });

  it("reports the commit, the box image, and the applied migration", async () => {
    const { app } = harness();
    const body = (await (await appRequest(app, "/version")).json()) as VersionReport;
    expect(Object.keys(body).sort()).toEqual([
      "boxImageRef",
      "boxImageTag",
      "commit",
      "migration",
    ]);
    expect(typeof body.commit).toBe("string");
    expect(typeof body.boxImageRef).toBe("string");
    expect(body.boxImageTag).toBe("blitz-box:test-amd64");
    expect(body.migration === null || typeof body.migration === "string").toBe(true);
  });

  it('reports "unknown" rather than omitting a commit the deploy never recorded', async () => {
    const { app } = harness();
    const body = (await (await appRequest(app, "/version")).json()) as VersionReport;
    // The test bindings set no GIT_COMMIT_SHA, which is exactly the case of a
    // deployment whose config predates the var.
    expect(body.commit).toBe("unknown");
  });

  // The consumers are packages/control-plane/scripts/check-box-image.mjs and
  // the canary workflow's verify step. Fixtures pin the whole response across
  // those runtimes, so neither a producer nor a consumer can hide a new field.
  it.each(Object.keys(fixtureSources))(
    "fixture %s matches the full response shape",
    async (path) => {
      const { app } = harness();
      const response = (await (await appRequest(app, "/version")).json()) as VersionReport;
      // SAFETY: Every VersionReport field is validated below before the value
      // is treated as a complete response fixture.
      const value = JSON.parse(fixtureSources[path]) as VersionReport;
      expect(Object.keys(value).sort()).toEqual(Object.keys(response).sort());
      expect(typeof value.commit).toBe("string");
      expect(value.commit).not.toBe("");
      expect(typeof value.boxImageRef).toBe("string");
      expect(typeof value.boxImageTag).toBe("string");
      expect(value.migration === null || typeof value.migration === "string").toBe(true);
    },
  );
});
