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
            // Pin every var the suite reads so tests are hermetic: the local
            // wrangler.toml is per-deployment (gitignored) and may hold either
            // real or example placeholder values.
            APP_URL: "https://control-plane.test",
            BOX_IMAGE_REF: "https://control-plane.test/box-image/manifest.json",
            BOX_IMAGE_TAG: "blitz-box:test-amd64",
            BOX_IMAGE_SHA256: "ad".repeat(32),
            SESSION_TTL_DAYS: "30",
            MICROVM_HOSTS: '[{"name":"lab","tokenVar":"MICROVM_LAB_TOKEN","dynamic":true}]',
            // Vendor-only blitz.dev managed-toolchain suites run only when the
            // host environment opts in with BLITZDEV_MANAGED=1.
            BLITZDEV_MANAGED: process.env.BLITZDEV_MANAGED === "1" ? "1" : "",
          },
        },
      }),
    ],
    test: {
      exclude: [
        ...configDefaults.exclude,
        "test/bootstrap-bash.test.mjs",
        "test/bootstrap-python.test.mjs",
        "test/box-update-conformance.test.mjs",
        "test/box-update-host.test.mjs",
        "test/publish-box-image.test.mjs",
        "test/set-box-image-ref.test.mjs",
        "test/deploy-tooling.test.mjs",
      ],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  });
});
