import { changed, rows, transaction } from "./db.js";
import {
  revokeMachineLeasesQuery,
  runLeaseSweep,
} from "./connections/leases.js";
import type { CoreRuntime } from "./runtime.js";
import type { MachineRow } from "./workspace-records.js";
import {
  expiredVolumes,
  markVolumeDetachedQuery,
  VOLUME_RETENTION_MS,
} from "./workspace-volumes.js";

const STUCK_CREATING_MS = 60 * 60 * 1000;
export const LAZY_SWEEP_INTERVAL_MS = 5 * 60_000;

let lastAttemptAt = 0;
let inFlight: Promise<void> | undefined;

const LAZY_SWEEP_PREFIXES = [
  "/sessions",
  "/workspaces",
  "/volumes",
  "/machine-types",
  "/machines",
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

/** VMs whose machine has already left. It iterates `machines` now: a workspace
 * has no VM of its own, and a workspace with five members has five of them. */
export async function runOrphanSweep(runtime: CoreRuntime): Promise<number> {
  const result = await rows<MachineRow & { org_id: string | null }>(runtime.db, {
    q: `SELECT m.*, w.org_id AS org_id
        FROM machines m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.vm_id IS NOT NULL AND m.state IN ('destroying', 'destroyed')
        ORDER BY m.updated_at, m.id`,
    v: [],
  });
  let destroyed = 0;
  for (const row of result) {
    if (row.vm_id === null) continue;
    const owner = runtime.providers.vmRegistry.forVmId(row.vm_id);
    if (owner === undefined) {
      // TODO(house-canon): Route structured core logs through the canonical logger.
      console.error(JSON.stringify({
        message: "orphan sweep skipped VM with no owning provider",
        machineId: row.id,
        workspaceId: row.workspace_id,
        vmId: row.vm_id,
      }));
      continue;
    }
    if (row.org_id === null) {
      runtime.reportError(
        "orphan_sweep_compute_credential_skipped",
        new Error(`machine ${row.id} has no organization for provider ${owner.id}`),
      );
      continue;
    }
    try {
      const resolved = await runtime.providers.vmRegistry.resolveVmId(
        row.vm_id,
        row.org_id,
        row.compute_credential_source,
      );
      if (resolved === undefined) continue;
      const provider = resolved.provider;
      if (row.volume_id !== null) {
        await provider.shutdown(row.vm_id);
        const volume = await runtime.providers.volume.forOrg(
          row.org_id,
          row.compute_credential_source,
        );
        await volume.provider.detachVolume(row.volume_id, row.vm_id);
        // The VM leaves the volume either way; the retention clock is what
        // separates a destroy from a stop. Starting it on a machine that is
        // coming back would delete a member's disk seven days after they
        // paused it, so a kept row keeps its volume undated.
        if (row.destroy_keeps_row !== 1) {
          await rows(runtime.db, markVolumeDetachedQuery(row.volume_id, Date.now()));
        }
      }
      if ((await provider.inspect(row.vm_id)) !== null) {
        await provider.destroy(row.vm_id);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "provider operation failed";
      runtime.reportError(
        "orphan_sweep_compute_credential_skipped",
        new Error(`machine ${row.id} provider ${owner.id}: ${detail}`),
      );
      continue;
    }
    if (row.state === "destroying") {
      // Which teardown this was is the row's to say, not this sweep's to
      // assume: a stop, a recreate and a machine-type change all pass through
      // `destroying` and all come back (`destroyMachine`'s `keepRow`, recorded
      // by migration 0047). Guessing `destroyed` here is what tombstoned a
      // machine its member had only stopped.
      const finalState = row.destroy_keeps_row === 1 ? "stopped" : "destroyed";
      const transition = await transaction(runtime.db, [
        revokeMachineLeasesQuery(row.id),
        { q: "DELETE FROM machine_token_families WHERE machine_id = ?1", v: [row.id] },
        { q: "DELETE FROM broker_keys WHERE machine_id = ?1", v: [row.id] },
        {
          q: `UPDATE machines
              SET state = ?1, destroy_keeps_row = 0, vm_id = NULL, ssh_host = NULL,
                  ssh_port = NULL, ssh_user = NULL, ssh_host_public_key = NULL,
                  error = NULL, updated_at = ?2
              WHERE id = ?3 AND state = 'destroying'
              RETURNING id`,
          v: [finalState, Date.now(), row.id],
        },
      ]);
      if (transition[3]?.length !== 1) continue;
    } else {
      await rows(runtime.db, {
        q: "UPDATE machines SET vm_id = NULL WHERE id = ?1",
        v: [row.id],
      });
    }
    destroyed += 1;
  }
  return destroyed;
}

/**
 * Deletes auto-created volumes whose retention window has closed.
 *
 * A destroyed workspace leaves its volume behind on purpose: it is the only
 * copy of `/workspace`, so the destroy stays reversible while the clock runs.
 * Once the window closes the volume is only a monthly bill, and this removes
 * it. A volume the operator created through POST /volumes is never touched;
 * only `auto_created` rows carry a clock at all.
 *
 * A provider failure leaves the row in place with its clock still set, so the
 * next sweep tries again. The delete is idempotent: Hetzner answers 404 for a
 * volume that is already gone, and the adapter maps that to success.
 */
export async function runVolumeRetentionSweep(
  runtime: CoreRuntime,
  now = Date.now(),
  retentionMs = VOLUME_RETENTION_MS,
): Promise<number> {
  const expired = await expiredVolumes(runtime.db, now, retentionMs);
  let reclaimed = 0;
  for (const row of expired) {
    try {
      const resolved = await runtime.providers.volume.forOrg(
        row.org_id,
        row.compute_credential_source ?? "deployment",
      );
      await resolved.provider.deleteVolume(row.volume_id);
    } catch (error) {
      runtime.reportError(
        "volume_retention_sweep_failed",
        error instanceof Error
          ? error
          : new Error(`volume ${row.volume_id} could not be reclaimed`),
      );
      continue;
    }
    await transaction(runtime.db, [
      {
        q: "DELETE FROM volume_ownership WHERE volume_id = ?1",
        v: [row.volume_id],
      },
      {
        q: "UPDATE machines SET volume_id = NULL WHERE volume_id = ?1",
        v: [row.volume_id],
      },
    ]);
    reclaimed += 1;
  }
  return reclaimed;
}

export async function runWorkspaceTunnelSweep(runtime: CoreRuntime): Promise<number> {
  const workspaceTunnels = runtime.providers.workspaceTunnels;
  if (workspaceTunnels === undefined) return 0;
  const result = await rows<MachineRow>(runtime.db, {
    q: `SELECT * FROM machines
        WHERE (tunnel_id IS NOT NULL OR dns_record_id IS NOT NULL)
          AND state IN ('destroying', 'destroyed', 'error')
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
        machineId: row.id,
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
    q: `UPDATE machines
        SET state = 'error', error = 'machine creation timed out',
            phone_home_hash = NULL, updated_at = ?1
        WHERE state = 'provisioning' AND updated_at < ?2
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
      await runVolumeRetentionSweep(runtime);
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
