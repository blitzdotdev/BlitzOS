import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Design-review bundle for the settings gallery, separate from the real
 * `vite.config.ts` so `npm run build`'s dist never carries preview files.
 *
 * `base: './'` because the box serves local ports through the workspace
 * preview proxy under a path prefix — absolute `/src/...` URLs escape the
 * prefix and come back as HTML, which is why plain `vite dev` renders blank
 * there. A relative-URL static build survives any prefix.
 *
 *   npx vite build --config vite.preview.config.mts
 *   npx vite preview --config vite.preview.config.mts --host 127.0.0.1 --port 5173
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "preview-dist",
    rollupOptions: {
      input: fileURLToPath(new URL("./settings-preview.html", import.meta.url)),
    },
  },
});
