import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

export {};
