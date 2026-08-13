import { changed, rows, transaction } from "./db.js";
import type { CoreRuntime } from "./runtime.js";
import type { WorkspaceRow } from "./workspaces.js";

const STUCK_CREATING_MS = 60 * 60 * 1000;
export const LAZY_SWEEP_INTERVAL_MS = 5 * 60_000;

let lastAttemptAt = 0;
let inFlight: Promise<void> | undefined;

const LAZY_SWEEP_PREFIXES = [
  "/sessions",
  "/workspaces",
  "/volumes",
  "/machine-types",
  "/oauth/",
  "/boxes/",
] as const;

function sweepPath(path: string): boolean {
  return LAZY_SWEEP_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`),
  );
}

export async function runOrphanSweep(runtime: CoreRuntime): Promise<number> {
  const result = await rows<WorkspaceRow>(runtime.db, {
    q: `SELECT * FROM workspaces
        WHERE vm_id IS NOT NULL AND phase IN ('destroying', 'destroyed')
        ORDER BY updated_at, id`,
    v: [],
  });
  let destroyed = 0;
  for (const row of result) {
    if (row.vm_id === null) continue;
    if (row.volume_id !== null) {
      await runtime.providers.vm.shutdown(row.vm_id);
      await runtime.providers.volume.detachVolume(row.volume_id, row.vm_id);
    }
    if ((await runtime.providers.vm.inspect(row.vm_id)) !== null) {
      await runtime.providers.vm.destroy(row.vm_id);
    }
    if (row.phase === "destroying") {
      const transition = await transaction(runtime.db, [
        { q: "DELETE FROM boxes WHERE workspace_id = ?1", v: [row.id] },
        {
          q: `UPDATE workspaces
              SET phase = 'destroyed', vm_id = NULL, ssh_host = NULL, ssh_port = NULL,
                  ssh_user = NULL, ssh_host_public_key = NULL, error = NULL,
                  revision = revision + 1, updated_at = ?1
              WHERE id = ?2 AND phase = 'destroying'
              RETURNING id`,
          v: [Date.now(), row.id],
        },
      ]);
      if (transition[1]?.length !== 1) continue;
    } else {
      await rows(runtime.db, {
        q: "UPDATE workspaces SET vm_id = NULL WHERE id = ?1",
        v: [row.id],
      });
    }
    destroyed += 1;
  }
  return destroyed;
}

export async function runInvariantSweep(
  runtime: CoreRuntime,
  now = Date.now(),
): Promise<number> {
  return changed(runtime.db, {
    q: `UPDATE workspaces
        SET phase = 'error', error = 'workspace creation timed out',
            phone_home_hash = NULL, revision = revision + 1, updated_at = ?1
        WHERE phase = 'creating' AND updated_at < ?2
        RETURNING id`,
    v: [now, now - STUCK_CREATING_MS],
  });
}

export async function runSessionSweep(
  runtime: CoreRuntime,
  now = Date.now(),
): Promise<number> {
  return changed(runtime.db, {
    q: "DELETE FROM sessions WHERE expires_at <= ?1 RETURNING token_hash",
    v: [now],
  });
}

export function maybeScheduleLazySweep(runtime: CoreRuntime, path: string): void {
  if (!sweepPath(path)) return;
  if (inFlight !== undefined) {
    runtime.waitUntil(inFlight);
    return;
  }
  const now = Date.now();
  if (now - lastAttemptAt < LAZY_SWEEP_INTERVAL_MS) return;
  lastAttemptAt = now;
  inFlight = (async () => {
    try {
      await runSessionSweep(runtime);
      await runInvariantSweep(runtime);
      await runOrphanSweep(runtime);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "lazy control-plane sweep failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    } finally {
      inFlight = undefined;
    }
  })();
  runtime.waitUntil(inFlight);
}
