import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv, type ServerOptions } from "vite";
import wasm from "vite-plugin-wasm";
import { defineConfig } from "vitest/config";
import {
  deriveCoreRoutePaths,
  devProxyPatterns,
} from "../control-plane/scripts/lib/worker-first-routes.mjs";
import {
  lodyCascadeLayerPlugin,
  lodyVendorAliases,
  loroWasmUrlWorkaround,
} from "./src/lody/vendor-bridge.js";
import { lodyAwareWorkerCount } from "./test/worker-budget.js";

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
    // The vendored Lody renderer (plans/LODY-SESSIONS.md §5.2) needs four
    // things our own surface never did: its pnpm workspace links resolved as
    // aliases, Tailwind v4, WASM (loro/flock), and top-level await in the
    // modules that load it. React is deduped so the vendored components share
    // our 19.2.x instance instead of getting a second copy through the alias.
    resolve: {
      alias: lodyVendorAliases(),
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    plugins: [tailwindcss(), lodyCascadeLayerPlugin(), loroWasmUrlWorkaround(), react(), wasm()],
    // Ported from their renderer config: the vendored workers reach WASM
    // through top-level await, which Vite's default `iife` worker format
    // cannot express.
    worker: {
      format: "es",
      plugins: () => [loroWasmUrlWorkaround(), wasm()],
    },
    server: target === "" ? {} : { proxy: controlPlaneProxy(target) },
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
      // Runs ONCE, before any worker. It kills a `lody` daemon orphaned by a
      // worker the OOM reaper took, which still holds the host lease on 17789
      // and would make every daemon-backed suite in this run time out. A
      // SIGKILLed worker runs no exit handler, so nothing in-process can do it.
      globalSetup: ["./test/lody-daemon-reaper.ts"],
      // Capped by MEMORY as well as by cores, because three suites import the
      // vendored Lody renderer and a worker holding that graph — Monaco, three,
      // mermaid, shiki, loro's WASM — plus a `lody` daemon runs to a gigabyte.
      // Four of those on a box with a gigabyte free gets the whole run
      // SIGKILLed by the OOM reaper: exit code 137, no failing test, no stack,
      // just `Killed`. The budget is the LOWER of what the machine has free
      // and what the enclosing cgroups have left under their ceilings — a box
      // throttles its user work at `memory.high` well before `freemem` reaches
      // zero (test/worker-budget.ts has the measurement). Measured here: two
      // workers are not slower than four, so the cap costs nothing on the
      // machine that needs it.
      maxWorkers: lodyAwareWorkerCount(),
      // `npm run dev` and `npm run build` read `env.defaults` through
      // `node --env-file`; `vitest run` does not, so the one variable the
      // vendored renderer THROWS without is repeated here. Keep it equal to
      // the `env.defaults` entry — see the comment beside it there.
      env: { VITE_PREVIEW_PUBLIC_BASE_DOMAIN: "local.invalid" },
      // Only the Lody surface entry is processed: the Tailwind containment
      // test reads the compiled sheet through the same plugin pipeline the
      // app builds with, and every other CSS import stays a cheap no-op.
      css: { include: [/lody-surface\.css/] },
      // The app's `loro-crdt -> loro-crdt/bundler` alias exists so Vite emits
      // and fingerprints the `.wasm` asset (`loroWasmUrlWorkaround`). Under
      // Vitest that rewrite yields a `/@fs/...` specifier, which `fetch` cannot
      // parse, so any test that instantiates a real `LoroRepo` dies at import.
      // The node entry loads the same WASM off disk. Overrides the app alias
      // for tests only; the browser build keeps the bundler entry.
      alias: [
        { find: /^loro-crdt$/u, replacement: "loro-crdt/nodejs" },
        // Vitest resolves packages through the SSR conditions, and
        // `react-resizable-panels` ships a DIFFERENT implementation there: its
        // `edge-light` build has no `useLayoutEffect` at all, so a consumer's
        // layout effect runs before the group has computed a layout and
        // `panel.collapse()` throws "Panel size not found". Their session
        // detail layout collapses its sidebar exactly that way
        // (`desktop-session-detail-layout.tsx:107`), so under jsdom the whole
        // session page would fail to mount for a reason that does not exist in
        // a browser. Same shape as the `loro-crdt` entry above: a build the
        // test environment can run, never the one the app ships.
        {
          find: /^react-resizable-panels$/u,
          replacement: fileURLToPath(
            new URL(
              "../../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.js",
              import.meta.url,
            ),
          ),
        },
      ],
    },
  };
});
