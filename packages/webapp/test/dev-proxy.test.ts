import { describe, expect, it } from "vitest";
import { CONTROL_PLANE_ROUTE_PREFIXES, controlPlaneProxy } from "../vite.config.js";

// The dev proxy decides which paths `vite dev` forwards to the control plane
// and which it answers with the SPA shell. It was a hand-kept copy of
// assets.run_worker_first with no test at all, so a route added to one and not
// the other broke local development quietly — a 200 with the shell in it, which
// looks like a working page until the JSON parse fails.
//
// The list is derived now (packages/control-plane/scripts/lib/worker-first-routes.mjs
// reads core's route registrations). These assertions pin the wiring: that the
// derived list is what reaches vite's server.proxy, and that every key is
// anchored. An unanchored key is a prefix match in vite, so "/me" would forward
// /members and /menu as well.

describe("dev proxy", () => {
  it("forwards exactly the derived control-plane routes, and nothing else", () => {
    const proxy = controlPlaneProxy("http://127.0.0.1:8787");
    expect(Object.keys(proxy)).toEqual([...CONTROL_PLANE_ROUTE_PREFIXES]);
    expect(Object.values(proxy)).toContainEqual({
      target: "http://127.0.0.1:8787",
      changeOrigin: true,
    });
  });

  it("anchors every pattern, so a route never claims a name that starts like it", () => {
    expect(CONTROL_PLANE_ROUTE_PREFIXES.filter((pattern) => !pattern.startsWith("^"))).toEqual([]);
  });

  it("forwards the control-plane routes and leaves the SPA's paths alone", () => {
    const patterns = CONTROL_PLANE_ROUTE_PREFIXES.map((pattern) => new RegExp(pattern, "u"));
    const forwards = (url: string) => patterns.some((pattern) => pattern.test(url));
    for (const url of ["/me", "/sessions", "/workspaces/abc", "/api/v1/health", "/version?x=1"]) {
      expect(forwards(url), url).toBe(true);
    }
    for (const url of ["/", "/index.html", "/assets/index-abcd1234.js", "/members-directory", "/menu"]) {
      expect(forwards(url), url).toBe(false);
    }
  });
});
