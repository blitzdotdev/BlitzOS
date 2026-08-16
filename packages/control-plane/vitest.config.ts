import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig, defineProject } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return defineProject({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            MICROVM_LAB_TOKEN: "test-only-microvm-lab-token-00000000",
            CRED_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
      }),
    ],
    test: {
      exclude: [...configDefaults.exclude, "test/bootstrap-python.test.mjs"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  });
});
