import { changed, rows, transaction } from "./db.js";
import {
  revokeWorkspaceLeasesQuery,
  runLeaseSweep,
} from "./credentials/leases.js";
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
  "/integrations",
  "/leases/",
  "/requests",
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
    const provider = runtime.providers.vmRegistry.forVmId(row.vm_id);
    if (provider === undefined) {
      // TODO(house-canon): Route structured core logs through the canonical logger.
      console.error(JSON.stringify({
        message: "orphan sweep skipped VM with no owning provider",
        workspaceId: row.id,
        vmId: row.vm_id,
      }));
      continue;
    }
    if (row.volume_id !== null) {
      await provider.shutdown(row.vm_id);
      await runtime.providers.volume.detachVolume(row.volume_id, row.vm_id);
    }
    if ((await provider.inspect(row.vm_id)) !== null) {
      await provider.destroy(row.vm_id);
    }
    if (row.phase === "destroying") {
      const transition = await transaction(runtime.db, [
        revokeWorkspaceLeasesQuery(row.id),
        { q: "DELETE FROM boxes WHERE workspace_id = ?1", v: [row.id] },
        { q: "DELETE FROM webapp_state WHERE workspace_id = ?1", v: [row.id] },
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
      if (transition[3]?.length !== 1) continue;
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

export async function runWorkspaceTunnelSweep(runtime: CoreRuntime): Promise<number> {
  const workspaceTunnels = runtime.providers.workspaceTunnels;
  if (workspaceTunnels === undefined) return 0;
  const result = await rows<WorkspaceRow>(runtime.db, {
    q: `SELECT * FROM workspaces
        WHERE (tunnel_id IS NOT NULL OR dns_record_id IS NOT NULL)
          AND phase IN ('destroying', 'destroyed', 'error')
        ORDER BY updated_at, id`,
    v: [],
  });
  let cleaned = 0;
  for (const row of result) {
    const cleanup = await workspaceTunnels.cleanup(runtime.db, row);
    if (cleanup.errors.length > 0) {
      // TODO(house-canon): Route structured core logs through the canonical logger.
      console.error(JSON.stringify({
        message: "workspace tunnel sweep left Cloudflare resources for retry",
        workspaceId: row.id,
        errors: cleanup.errors,
      }));
      continue;
    }
    cleaned += 1;
  }
  return cleaned;
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
      await runLeaseSweep(runtime);
      await runInvariantSweep(runtime);
      await runOrphanSweep(runtime);
      await runWorkspaceTunnelSweep(runtime);
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
