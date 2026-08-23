import { changed, rows, transaction } from "./db.js";
import { runProviderCanary } from "./connections/canary.js";
import { runFileSyncSweep } from "./files/sync.js";
import type { CoreRuntime } from "./runtime.js";
import { finalizeWorkspaceDestroyQueries, type WorkspaceRow } from "./workspaces.js";

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
  "/connections",
  "/connect/",
  // Alias of /connections kept for old bookmarks and scripts.
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
  // SAFETY: only phase 'destroying' can hold a VM. Both destroy finalizers —
  // the DELETE route and this sweep, via finalizeWorkspaceDestroyQueries —
  // clear vm_id in the same UPDATE that sets phase = 'destroyed', so a
  // destroyed row with a non-null vm_id cannot exist.
  const result = await rows<WorkspaceRow>(runtime.db, {
    q: `SELECT * FROM workspaces
        WHERE vm_id IS NOT NULL AND phase = 'destroying'
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
    const transition = await transaction(
      runtime.db,
      finalizeWorkspaceDestroyQueries(row.id, Date.now()),
    );
    if (transition[3]?.length !== 1) continue;
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

export async function runInvariantSweep(runtime: CoreRuntime): Promise<number> {
  const now = Date.now();
  return changed(runtime.db, {
    q: `UPDATE workspaces
        SET phase = 'error', error = 'workspace creation timed out',
            phone_home_hash = NULL, revision = revision + 1, updated_at = ?1
        WHERE phase = 'creating' AND updated_at < ?2
        RETURNING id`,
    v: [now, now - STUCK_CREATING_MS],
  });
}

export async function runSessionSweep(runtime: CoreRuntime): Promise<number> {
  return changed(runtime.db, {
    q: "DELETE FROM sessions WHERE expires_at <= ?1 RETURNING token_hash",
    v: [Date.now()],
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

/** Must stay one of wrangler.toml's `triggers.crons` entries verbatim: the
 * scheduled handler routes on the literal expression Cloudflare hands back. */
const HOURLY_CRON = "0 * * * *";
const DAILY_CRON = "0 3 * * *";

/** The whole cron-tick policy, owned here so the Worker entry point only
 * builds a runtime and forwards `event.cron`. */
export async function runScheduledMaintenance(
  runtime: CoreRuntime,
  cron: string,
): Promise<void> {
  // Only the hourly and daily schedules run the full janitor set. Any
  // other tick (the */5 backstop today) converges folder sync alone, so
  // renaming that cron can never silently multiply the heavy sweeps.
  if (cron !== HOURLY_CRON && cron !== DAILY_CRON) {
    const swept = await runFileSyncSweep(runtime);
    console.log(JSON.stringify({ event: "file_sync_tick", cron, ...swept }));
    return;
  }
  await runtime.providers.microvm?.syncStaticHosts();
  await runSessionSweep(runtime);
  await runInvariantSweep(runtime);
  await runOrphanSweep(runtime);
  await runWorkspaceTunnelSweep(runtime);
  // The canary is the one sweep that costs an authenticated call to a
  // third party per provider, so it takes the hourly tick alone. On the
  // daily tick as well it would be counted twice against the same rate
  // limit for no extra signal.
  if (cron === HOURLY_CRON) {
    const probed = await runProviderCanary(runtime);
    console.log(JSON.stringify({ event: "provider_canary_tick", cron, probed }));
  }
  const swept = await runFileSyncSweep(runtime);
  console.log(JSON.stringify({ event: "file_sync_tick", cron, ...swept }));
}
