import * as schema from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import * as core from "../core/preview.js";

/** Core stays portable and imports nothing outside itself, so the deep-link
 * rule for a preview tab exists twice: once in the schema the browser drops a
 * bad path with, once in core, which refuses one. A copy that drifts either
 * loses a route the browser kept or stores a path the browser would have
 * dropped, so pin them together — the same arrangement `webapp-surface.ts` has
 * with its schema module. */
describe("preview path copies", () => {
  it("declares the same bound on both sides", () => {
    expect(core.MAX_PREVIEW_PATH_LENGTH).toBe(schema.MAX_PREVIEW_PATH_LENGTH);
  });

  it("agrees on every case, allowed and refused", () => {
    const cases = [
      "/",
      "/dashboard",
      "/a/b/c",
      "/a..b",
      "/..a",
      "dashboard",
      "",
      "/..",
      "/../workspace/",
      "/a/../../workspace/",
      "/preview/..",
      `/${"a".repeat(schema.MAX_PREVIEW_PATH_LENGTH - 1)}`,
      `/${"a".repeat(schema.MAX_PREVIEW_PATH_LENGTH)}`,
    ];
    for (const path of cases) {
      expect(core.isPreviewPath(path), path).toBe(schema.isPreviewPath(path));
    }
  });

  it("rejects traversal, unrooted, and over-long paths", () => {
    expect(core.isPreviewPath("/a/../../workspace/")).toBe(false);
    expect(core.isPreviewPath("/..")).toBe(false);
    expect(core.isPreviewPath("dashboard")).toBe(false);
    expect(core.isPreviewPath(`/${"a".repeat(core.MAX_PREVIEW_PATH_LENGTH)}`)).toBe(false);
    // A `..` that is not a whole segment is an ordinary route.
    expect(core.isPreviewPath("/a..b")).toBe(true);
    expect(core.isPreviewPath(`/${"a".repeat(core.MAX_PREVIEW_PATH_LENGTH - 1)}`)).toBe(true);
  });
});
