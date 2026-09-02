/**
 * Diff probe build config — the product's plugin pipeline, nothing else.
 * Mirrors `test/prod-probe/vite.config.ts` so what the probe renders is what
 * the product ships: same vendor aliases, same worker format, same plugins.
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
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
