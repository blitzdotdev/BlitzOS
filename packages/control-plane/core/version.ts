import { first } from "./db.js";
import type { CoreRouter, RuntimeFactory } from "./runtime.js";

/**
 * What `GET /version` answers.
 *
 * Deploy tooling reads this to learn which commit and box image an instance
 * runs. The Node advisory and canary workflow are cross-runtime consumers, so
 * the full report is pinned by `packages/schema/fixtures/version/` and both
 * conformance tests.
 *
 * Every field is public on purpose. A commit SHA of an open-source repository
 * and a public GHCR image reference disclose nothing an attacker cannot read
 * from the repository itself, and the alternative — guessing which commit a
 * deployment runs — costs an operator far more.
 */
export interface VersionReport {
  /**
   * The git commit this deployment shipped. `"unknown"` when the deploy
   * recorded none, which is what a config older than GIT_COMMIT_SHA reports.
   */
  commit: string;
  /** The box image this deployment hands to each new workspace. */
  boxImageRef: string;
  /** The local Docker tag expected after an archive-backed image is loaded. */
  boxImageTag: string;
  /**
   * The newest applied D1 migration, by filename. `null` when the migration
   * table cannot be read, which is the honest answer for a database that
   * predates it — a version route must never 500 on its own diagnosis.
   */
  migration: string | null;
}

export function addVersionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/version", async (context) => {
    const runtime = runtimeFactory(context);
    const report: VersionReport = {
      commit: runtime.vars.gitCommitSha ?? "unknown",
      boxImageRef: runtime.vars.boxImageRef,
      boxImageTag: runtime.vars.boxImageTag,
      migration: await appliedMigration(runtime),
    };
    return context.json(report);
  });
}

/**
 * Wrangler records applied migrations by filename in `d1_migrations`. Reading
 * the newest row tells an operator which schema is live, which is the one fact
 * a rollback decision turns on.
 */
async function appliedMigration(
  runtime: ReturnType<RuntimeFactory>,
): Promise<string | null> {
  try {
    const row = await first<{ name: string }>(runtime.db, {
      q: "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
      v: [],
    });
    return row === null ? null : row.name;
  } catch {
    // A database without the table answers null rather than failing the route.
    return null;
  }
}
