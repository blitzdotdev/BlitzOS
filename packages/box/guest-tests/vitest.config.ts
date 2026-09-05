import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "acp-extension-dsh/capabilities": fileURLToPath(
        new URL("../../webapp/src/lody/stubs/acp-extension-dsh-capabilities.ts", import.meta.url),
      ),
      "@lody/shared": fileURLToPath(new URL("../../../vendor/lody/packages/shared/src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
