/**
 * The probe's build config — the product's plugin pipeline, nothing else.
 *
 * `plugins`, `resolve.alias` and `worker` are imported from the same module
 * `packages/webapp/vite.config.ts` imports them from, so the probe is compiled
 * by the pipeline the product is compiled by: the vendor aliases, Tailwind v4,
 * `lodyCascadeLayerPlugin`, the WASM workaround, and esbuild minification.
 * Duplicating the list here would let the probe pass while the product broke.
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { defineConfig } from "vite";
import {
  lodyCascadeLayerPlugin,
  lodyVendorAliases,
  loroWasmUrlWorkaround,
} from "../../src/lody/vendor-bridge.js";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("../../../..", import.meta.url)),
  resolve: {
    alias: lodyVendorAliases(),
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  plugins: [tailwindcss(), lodyCascadeLayerPlugin(), loroWasmUrlWorkaround(), react(), wasm()],
  worker: { format: "es", plugins: () => [loroWasmUrlWorkaround(), wasm()] },
  build: {
    outDir: process.env.BLITZ_PROBE_OUT ?? fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
