import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/sessions": { target: "https://blitz-control-plane.blitzapp.workers.dev", changeOrigin: true },
      "/workspaces": { target: "https://blitz-control-plane.blitzapp.workers.dev", changeOrigin: true },
      "/volumes": { target: "https://blitz-control-plane.blitzapp.workers.dev", changeOrigin: true },
      "/machine-types": { target: "https://blitz-control-plane.blitzapp.workers.dev", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
  },
});
