import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Mirrors assets.run_worker_first in ../control-plane/wrangler.toml: every
// first-party control-plane route the dev server must forward to the control
// plane instead of serving the SPA shell. "/me" is listed as an anchored
// pattern because it is the one exact-match entry in that list.
const CONTROL_PLANE_ROUTE_PREFIXES = [
  "/sessions",
  "/auth",
  "/invite",
  "/invites",
  "^/me(?:$|[/?])",
  "/members",
  "/orgs",
  "/workspaces",
  "/workspace-templates",
  "/workspace-recipes",
  "/folders",
  "/integrations",
  "/leases",
  "/requests",
  "/proxy",
  "/volumes",
  "/machine-types",
  "/webapp-state",
  "/hosts",
  "/oauth",
  "/boxes",
  "/box-image",
  "/api",
];

export default defineConfig(({ command, mode }) => {
  const envDir = fileURLToPath(new URL("../..", import.meta.url));
  const target = loadEnv(mode, envDir, "VITE_").VITE_DEV_PROXY_TARGET?.trim() ?? "";
  if (target === "" && command === "serve" && mode !== "test") {
    console.warn(
      "[webapp] VITE_DEV_PROXY_TARGET is not set; control-plane API routes will not be proxied.\n"
      + "[webapp] Set it to your control plane origin (for example http://127.0.0.1:8787 from `wrangler dev`).",
    );
  }
  return {
    envDir: "../..",
    plugins: [react()],
    server: target === ""
      ? {}
      : {
          proxy: Object.fromEntries(
            CONTROL_PLANE_ROUTE_PREFIXES.map((prefix) => [
              prefix,
              { target, changeOrigin: true },
            ]),
          ),
        },
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
    },
  };
});
