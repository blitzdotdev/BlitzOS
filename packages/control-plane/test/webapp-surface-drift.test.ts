import * as schema from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import * as core from "../core/webapp-surface.js";

/** Core stays portable and imports nothing outside itself, so the list of box
 * paths the browser may reach exists twice: once in the schema the webApp
 * builds URLs from, once in core, which refuses everything else. A copy that
 * drifts either breaks a feature or widens the box, so pin them together —
 * the same arrangement `wire.ts` has with the schema types. */
describe("webApp surface copies", () => {
  it("declares the same surfaces on both sides", () => {
    expect([...core.WEBAPP_FILES_SURFACES]).toEqual([...schema.WEBAPP_FILES_SURFACES]);
    expect([...core.WEBAPP_FILES_SURFACE_PREFIXES])
      .toEqual([...schema.WEBAPP_FILES_SURFACE_PREFIXES]);
  });

  it("agrees on every case, allowed and refused", () => {
    const cases: string[] = [
      "/",
      "/diag",
      "/ports",
      "/previews",
      "/preview-focus",
      "/connections-focus",
      "/credentials",
      "/credentials/sync",
      "/terminal/ws",
      "/workspace",
      "/workspace/",
      "/workspace/notes/report.md",
      "/workspace/a%20b.txt",
      "/preview/3000/",
      "/preview/3000/api/health",
      "/home/",
      "/home/.claude/.credentials.json",
      "/admin/drain",
      "/acp",
      "/workspace/../home/.claude.json",
      "/workspace/%2e%2e/home/.claude.json",
      "/workspaceother",
      "/%ZZ",
    ];
    for (const path of cases) {
      expect(core.isWebAppSurfacePath(path), path).toBe(schema.isWebAppSurfacePath(path));
    }
  });
});
