import { rows, type Db, type Query } from "./db.js";
import type { ComputeCredentialSource, VmProvider } from "./compute/types.js";
import type { Volume } from "./wire.js";

/** Size of an auto-created workspace volume. The box image plus the docker
 * store plus `/workspace` all live on it, so it has to clear the box image
 * with room to spare. Hetzner bills $0.0767 per GB each month, so this number
 * is the per-workspace storage bill: 50 GB costs $3.84 a month. */
export const WORKSPACE_VOLUME_GB = 50;

/** How long a detached volume outlives its workspace. The volume is the only
 * copy of `/workspace` after the VM is gone, so a destroy stays reversible for
 * this long and the janitor reclaims the volume afterwards. */
export const VOLUME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Hetzner volume names must be unique inside a project and hold only
 * `[A-Za-z0-9._-]` after a leading alphanumeric. Workspace names hold any
 * Unicode and are NOT unique: `randomWorkspaceName` picks from about 2,000
 * pairs with no collision check, and `templateWorkspaceName` only avoids
 * live rows. So this builds the preferred name, and `uniqueVolumeName`
 * builds the fallback the caller uses when the provider refuses a duplicate.
 * A name that sanitizes to nothing falls back to the workspace id. */
export function preferredVolumeName(workspaceName: string): string | null {
  const label = workspaceName
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^[^a-z0-9]+|[-._]+$/gu, "")
    .slice(0, 64)
    .replaceAll(/[-._]+$/gu, "");
  return label === "" ? null : label;
}

/** The collision-proof name. The workspace id is a UUID, so its first segment
 * makes the name unique inside the project without a lookup. */
export function uniqueVolumeName(
  workspaceName: string,
  machineId: string,
): string {
  const suffix = machineId.slice(0, 8);
  const base = preferredVolumeName(workspaceName);
  if (base === null) return `blitz-${suffix}`;
  return `${base.slice(0, 64 - suffix.length - 1)}-${suffix}`;
}

export interface WorkspaceVolumeRequest {
  db: Db;
  provider: VmProvider;
  createVolume: (name: string, sizeGb: number, location: string) => Promise<Volume>;
  /** Removes a volume whose ownership row could not be written. Without it the
   * volume exists at the provider with nothing in the database pointing at it,
   * so no later path can find it and it bills every month. */
  deleteVolume: (id: string) => Promise<void>;
  workspaceId: string;
  /** The volume belongs to one member's machine, so the unique name and the
   * ownership row are keyed on it — a workspace holds several now. */
  machineId: string;
  workspaceName: string;
  machineTypeId: string;
  orgId: string;
  membershipId: string;
  credentialSource: ComputeCredentialSource | null;
  sizeGb?: number;
  now: number;
}

/**
 * Creates the workspace's own volume and records the ownership row.
 *
 * Returns null when the provider cannot place one: either it has no volumes,
 * or it cannot name a location for the machine type. Both are ordinary
 * answers, not errors — a microVM workspace simply has no volume.
 *
 * The provider is asked for the location rather than parsing the machine type
 * here, because the id format belongs to the provider (`cx23@hel1` is a
 * Hetzner shape, not a general one).
 */
export async function provisionWorkspaceVolume(
  request: WorkspaceVolumeRequest,
): Promise<Volume | null> {
  const capabilities = request.provider.capabilities();
  if (!capabilities.volumes) return null;
  const location = request.provider.volumeLocation?.(request.machineTypeId) ?? null;
  if (location === null) return null;

  const sizeGb = request.sizeGb ?? WORKSPACE_VOLUME_GB;
  const preferred = preferredVolumeName(request.workspaceName);
  const unique = uniqueVolumeName(request.workspaceName, request.machineId);

  // The workspace name is what the operator asked to see on the volume, so it
  // is tried first. A duplicate name is the expected failure, not a rare one,
  // because a destroyed workspace's volume keeps its name for seven more days
  // while the name itself is free to be reused.
  let volume: Volume;
  if (preferred === null || preferred === unique) {
    volume = await request.createVolume(unique, sizeGb, location);
  } else {
    try {
      volume = await request.createVolume(preferred, sizeGb, location);
    } catch {
      volume = await request.createVolume(unique, sizeGb, location);
    }
  }

  try {
    await rows(request.db, {
      q: `INSERT INTO volume_ownership
          (volume_id, org_id, created_by_membership_id, created_at,
           compute_credential_source, auto_created, workspace_id)
          VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)`,
      v: [
        volume.id,
        request.orgId,
        request.membershipId,
        request.now,
        request.credentialSource,
        request.workspaceId,
      ],
    });
  } catch (error) {
    // The volume exists at the provider and nothing in the database points at
    // it. Remove it before reporting, or it bills forever unreachable.
    await request.deleteVolume(volume.id).catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`volume ownership row for ${volume.id} failed: ${detail}`);
  }
  return volume;
}

/** Stamps the detach time so the retention clock starts. Only auto-created
 * volumes carry one; a volume the operator made by hand is never reclaimed. */
export function markVolumeDetachedQuery(volumeId: string, now: number): Query {
  return {
    q: `UPDATE volume_ownership SET detached_at = ?1
        WHERE volume_id = ?2 AND auto_created = 1 AND detached_at IS NULL`,
    v: [now, volumeId],
  };
}

/** Clears the retention clock when a volume is attached to a workspace again,
 * so a recreate inside the window resets the seven days. */
export function markVolumeAttachedQuery(volumeId: string): Query {
  return {
    q: "UPDATE volume_ownership SET detached_at = NULL WHERE volume_id = ?1",
    v: [volumeId],
  };
}

export interface ExpiredVolume {
  volume_id: string;
  org_id: string;
  compute_credential_source: ComputeCredentialSource | null;
}

/** Auto-created volumes whose retention window has closed. */
export async function expiredVolumes(
  db: Db,
  now: number,
  retentionMs: number = VOLUME_RETENTION_MS,
): Promise<ExpiredVolume[]> {
  return rows<ExpiredVolume>(db, {
    q: `SELECT volume_id, org_id, compute_credential_source
        FROM volume_ownership
        WHERE auto_created = 1
          AND detached_at IS NOT NULL
          AND detached_at <= ?1
        ORDER BY detached_at, volume_id
        LIMIT 50`,
    v: [now - retentionMs],
  });
}
