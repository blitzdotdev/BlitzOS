/**
 * The npm <-> pnpm bridge for the vendored Lody renderer (plans/LODY-SESSIONS.md §5.2).
 *
 * Lody's packages publish RAW `.ts`/`.tsx` through their `exports` maps and are
 * wired together by a pnpm workspace we do not have. This module holds the Vite
 * resolution rules that stand in for that workspace, plus the two bundle
 * aliases their Electron renderer config carries
 * (`vendor/lody/apps/electron/electron.vite.config.ts`).
 *
 * It is a build-config module: it runs in Node inside `vite.config.ts`, never
 * in the browser. Nothing here edits `vendor/lody` — that tree stays pristine
 * so `git subtree pull` keeps merging cleanly.
 */
import { fileURLToPath } from "node:url";
import type { Alias } from "vite";

/**
 * Absolute path of `path` inside the vendored Lody subtree.
 *
 * Resolved lazily, never at module load: `test/dev-proxy.test.ts` imports
 * `vite.config.ts` from inside Vitest, where `import.meta.url` is an `http:`
 * module URL and `fileURLToPath` throws. Only the build calls this.
 */
export function vendorPath(path: string): string {
  return fileURLToPath(new URL(`../../../../vendor/lody/${path}`, import.meta.url));
}

/** Source aliases shared by Vite and source-closure audits. */
export const LODY_VENDOR_SOURCE_ALIASES = [
  { find: "@lody/components", vendorSource: "packages/components/src" },
  { find: "@lody/shared", vendorSource: "packages/shared/src" },
  { find: "@lody/platform", vendorSource: "packages/platform/src" },
  { find: "@lody/cloud-api", vendorSource: "packages/cloud-api/src" },
  { find: "@lody/loro-streams-rpc", vendorSource: "packages/loro-streams-rpc/src" },
];

/**
 * Stand-ins for Lody's pnpm workspace links and for the one workspace package
 * that is an empty git submodule in the public tree (`acp-extension-dsh`; the
 * subtree carries the gitlink, not the sources, exactly as §5.1 expects).
 *
 * Order matters: Vite tries aliases in order and a bare string `find` is a
 * prefix match, so the deepest specifier has to come first.
 */
export function lodyVendorAliases(): Alias[] {
  const componentsSrc = vendorPath("packages/components/src");
  return [
    // The one dependency the public subtree cannot supply. Only a handful of
    // selector constants are re-exported from it, so a local stub keeps the
    // vendor tree untouched (constraint: no edits inside vendor/lody).
    {
      find: "acp-extension-dsh/capabilities",
      replacement: fileURLToPath(new URL("./stubs/acp-extension-dsh-capabilities.ts", import.meta.url)),
    },
    ...LODY_VENDOR_SOURCE_ALIASES.map(({ find, vendorSource }) => ({
      find,
      replacement: vendorPath(vendorSource),
    })),
    // Their components package imports itself as `@/...`. The trailing slash
    // keeps this from swallowing any future bare `@` specifier.
    { find: "@/", replacement: `${componentsSrc}/` },
    // Ported from their renderer config: `streamdown` asks for the full Shiki
    // bundle (every language and theme, ~30 MB) where the plain entry serves.
    { find: "shiki/bundle/full", replacement: "shiki" },
    // Ported from `vendor/lody/packages/components/vite-wasm-workarounds.ts`:
    // loro-crdt's browser entry sync-compiles its WASM, which some WebViews
    // refuse. The bundler entry defers it to the wasm plugin.
    { find: /^loro-crdt$/, replacement: "loro-crdt/bundler" },
  ];
}

/** Marker comment `lody-surface.css` carries so the layer plugin can find it. */
export const LODY_LAYER_NAME = "lody";

/**
 * Wraps the compiled Lody stylesheet in the `lody` cascade layer
 * (plans/LODY-SESSIONS.md §7.4, defence (a)).
 *
 * The obvious spelling — `@import "…/tailwind/index.css" layer(lody)` — does
 * not compile: their entry declares `@utility` at the top level, and Tailwind
 * v4 rejects `@utility` inside a layer ("`@utility` cannot be nested"). The
 * same holds for `@theme`, `@custom-variant`, and `@source`. So we let Tailwind
 * compile the sheet unlayered and wrap its OUTPUT instead, which is ordinary
 * CSS by then.
 *
 * Order matters: this plugin must sit AFTER `tailwindcss()` in the plugin
 * array. Both are `enforce: "pre"`, and Vite runs same-phase plugins in array
 * order, so this one receives Tailwind's generated CSS.
 */
export function lodyCascadeLayerPlugin() {
  return {
    name: "blitz-lody-cascade-layer",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("/lody/lody-surface.css")) return undefined;
      if (code.startsWith(`@layer ${LODY_LAYER_NAME}`)) return undefined;
      return { code: `@layer ${LODY_LAYER_NAME} {\n${code}\n}\n`, map: null };
    },
  };
}

/**
 * Ported from `vendor/lody/packages/components/vite-wasm-workarounds.ts`.
 *
 * The bundler entries reference their `.wasm` siblings as plain relative paths.
 * Vite only emits (and fingerprints) an asset for a `?url` import, so without
 * this rewrite the WASM 404s at runtime. The vendored copy cannot be imported
 * directly: its sibling `vite-renderer-bundle-aliases.ts` resolves a
 * `node_modules` path next to itself at module load, which only exists under
 * pnpm's nested layout.
 */
export function loroWasmUrlWorkaround() {
  return {
    name: "blitz-loro-wasm-url-workaround",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (id.includes("/loro-crdt/browser/loro_wasm.js")) {
        throw new Error(
          "loro-crdt browser build sync-loads WASM. Keep the loro-crdt -> loro-crdt/bundler alias.",
        );
      }
      if (id.includes("/loro-crdt/bundler/loro_wasm.js") && code.includes("loro_wasm_bg.wasm")) {
        return { code: code.replaceAll("./loro_wasm_bg.wasm", "./loro_wasm_bg.wasm?url"), map: null };
      }
      if (id.includes("/@loro-dev/streams-crdt/dist/zstd-core-") && code.includes("zstd.wasm")) {
        return { code: code.replaceAll("./zstd.wasm", "./zstd.wasm?url"), map: null };
      }
      return undefined;
    },
  };
}
