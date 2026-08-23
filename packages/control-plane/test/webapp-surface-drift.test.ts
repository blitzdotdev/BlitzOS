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
    expect([...core.WEBAPP_AGENT_SURFACES]).toEqual([...schema.WEBAPP_AGENT_SURFACES]);
    expect([...core.WEBAPP_FILES_SURFACES]).toEqual([...schema.WEBAPP_FILES_SURFACES]);
    expect([...core.WEBAPP_FILES_SURFACE_PREFIXES])
      .toEqual([...schema.WEBAPP_FILES_SURFACE_PREFIXES]);
  });

  it("agrees on every case, allowed and refused", () => {
    const cases: [7444 | 7445, string][] = [
      [7444, "/"],
      [7444, "/admin/drain"],
      [7444, "/acp"],
      [7445, "/"],
      [7445, "/ports"],
      [7445, "/previews"],
      [7445, "/preview-focus"],
      [7445, "/connections-focus"],
      [7445, "/credentials/sync"],
      [7445, "/credentials"],
      [7445, "/credentials/sync/extra"],
      [7445, "/terminal/ws"],
      [7445, "/workspace"],
      [7445, "/workspace/"],
      [7445, "/workspace/notes/report.md"],
      [7445, "/workspace/a%20b.txt"],
      [7445, "/preview/3000/"],
      [7445, "/preview/3000/api/health"],
      [7445, "/home/"],
      [7445, "/home/.claude/.credentials.json"],
      [7445, "/admin/drain"],
      [7445, "/acp"],
      [7445, "/workspace/../home/.claude.json"],
      [7445, "/workspace/%2e%2e/home/.claude.json"],
      [7445, "/workspaceother"],
      [7445, "/%ZZ"],
    ];
    for (const [port, path] of cases) {
      expect(core.isWebAppSurfacePath(port, path), `${String(port)} ${path}`)
        .toBe(schema.isWebAppSurfacePath(port, path));
    }
  });
});
