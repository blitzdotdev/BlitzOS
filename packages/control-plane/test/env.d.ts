import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
    CRED_MASTER_KEY: string;
    /** "1" when the host environment opts into the vendor-only blitz.dev
     * managed-toolchain suites (BLITZDEV_MANAGED=1), otherwise "". */
    BLITZDEV_MANAGED: string;
  }
}

export {};
