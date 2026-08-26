import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv, type ServerOptions } from "vite";
import { defineConfig } from "vitest/config";
import {
  deriveCoreRoutePaths,
  devProxyPatterns,
} from "../control-plane/scripts/lib/worker-first-routes.mjs";

// Every first-party control-plane route the dev server must forward to the
// control plane instead of serving the SPA shell.
//
// Derived, never listed. This used to be a hand-kept copy of
// assets.run_worker_first, and it was the copy no test covered, so it fell
// behind in silence: a route missing here is served the SPA shell with status
// 200 by `vite dev` and nobody finds out until production. The generator reads
// core's route registrations off disk — vite.config runs in Node, so it can —
// and packages/webapp/test/dev-proxy.test.ts pins the result.
//
// Each entry is an anchored pattern. Vite reads a key starting with "^" as a
// RegExp and any other key as "every URL starting with this", which would
// forward /members-directory because /members is a route.
export const CONTROL_PLANE_ROUTE_PREFIXES = devProxyPatterns(deriveCoreRoutePaths());

/**
 * The dev server's proxy table: every derived route forwarded to `target`.
 * Exported so test/dev-proxy.test.ts pins the table itself, not a copy of it.
 */
export function controlPlaneProxy(target: string): NonNullable<ServerOptions["proxy"]> {
  return Object.fromEntries(
    CONTROL_PLANE_ROUTE_PREFIXES.map((pattern) => [pattern, { target, changeOrigin: true }]),
  );
}

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
    server: target === "" ? {} : { proxy: controlPlaneProxy(target) },
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
    },
  };
});
