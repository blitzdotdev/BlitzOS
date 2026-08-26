import { first, type Db } from "../db.js";
import { HttpError } from "../http.js";
import type { ResolvedVmProvider, VmProviderRegistry } from "./registry.js";
import type { ComputeCredentialSource } from "./types.js";

/** Resolves the one provider that owns the requested machine type and checks
 * that an attached volume was created with the same credential source. A
 * deployment-key volume must never be handed to an org-key adapter (or the
 * reverse), even when both identities can see similarly named resources. */
export async function resolveWorkspacePlacement(
  db: Db,
  registry: VmProviderRegistry,
  orgId: string,
  machineTypeId: string,
  volumeId?: string,
): Promise<ResolvedVmProvider> {
  const resolution = await registry.forMachineType(machineTypeId, orgId);
  if (volumeId === undefined) return resolution;
  if (!resolution.provider.capabilities().volumes) {
    throw new HttpError(400, `machine type ${machineTypeId} does not support volumes`);
  }
  const owned = await first<{
    volume_id: string;
    compute_credential_source: ComputeCredentialSource | null;
  }>(db, {
    q: `SELECT volume_id, compute_credential_source FROM volume_ownership
        WHERE volume_id = ?1 AND org_id = ?2 LIMIT 1`,
    v: [volumeId, orgId],
  });
  if (owned === null) throw new HttpError(404, "volume not found");
  const volumeSource = owned.compute_credential_source ?? "deployment";
  if (
    resolution.credentialSource !== null
    && resolution.credentialSource !== volumeSource
  ) {
    throw new HttpError(409, "volume and machine use different compute credentials");
  }
  return resolution;
}
