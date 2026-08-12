import type { VmProvider, VolumeProvider } from "./providers/types.js";
import type { WorkspaceRow } from "./workspaces.js";

const STUCK_CREATING_MS = 60 * 60 * 1000;

export async function runOrphanDestroy(
  db: D1Database,
  vmProvider: VmProvider,
  volumeProvider: VolumeProvider,
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT * FROM workspaces
       WHERE vm_id IS NOT NULL AND phase IN ('destroying', 'destroyed')
       ORDER BY updated_at, id`,
    )
    .all<WorkspaceRow>();
  let destroyed = 0;
  for (const row of result.results) {
    if (row.vm_id === null) continue;
    if (row.volume_id !== null) {
      await volumeProvider.detachVolume(row.volume_id, row.vm_id);
    }
    if ((await vmProvider.inspect(row.vm_id)) !== null) {
      await vmProvider.destroy(row.vm_id);
    }
    if (row.phase === "destroying") {
      await db.batch([
        db.prepare("DELETE FROM boxes WHERE workspace_id = ?1").bind(row.id),
        db
          .prepare(
            `UPDATE workspaces
             SET phase = 'destroyed', vm_id = NULL, ssh_host = NULL, ssh_port = NULL,
                 ssh_user = NULL, ssh_host_public_key = NULL, error = NULL,
                 revision = revision + 1, updated_at = ?1
             WHERE id = ?2 AND phase = 'destroying'`,
          )
          .bind(Date.now(), row.id),
      ]);
    } else {
      await db.prepare("UPDATE workspaces SET vm_id = NULL WHERE id = ?1").bind(row.id).run();
    }
    destroyed += 1;
  }
  return destroyed;
}

export async function runInvariantSweep(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE workspaces
       SET phase = 'error', error = 'workspace creation timed out',
           phone_home_hash = NULL, revision = revision + 1, updated_at = ?1
       WHERE phase = 'creating' AND updated_at < ?2`,
    )
    .bind(now, now - STUCK_CREATING_MS)
    .run();
  return result.meta.changes;
}
