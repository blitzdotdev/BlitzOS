import { boxHostname } from "./bootstrap.js";
import { buildUserData, type BootShaping } from "./cloud-init.js";
import { revokeMachineLeasesQuery } from "./connections/leases.js";
import { hashSecret, randomToken } from "./crypto.js";
import { first, rows, transaction, type Db, type Query } from "./db.js";
import { HttpError, isRecord, isSshPublicKey, readJson, requiredString, type JsonValue } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import type { CreateVmInput, VmProvider } from "./compute/types.js";
import { resolveWorkspacePlacement } from "./compute/workspace-placement.js";
import { workspaceRepos } from "./template-repos.js";
import {
  isWorkspaceAdmin,
  requireWorkspaceAdmin,
  workspaceAccess,
} from "./workspace-access.js";
import {
  MACHINE_SLOT_STATES,
  machineView,
  workspaceById,
  type MachineRow,
  type CreatedByPlane,
  type WorkspaceRow,
} from "./workspace-records.js";
import {
  markVolumeAttachedQuery,
  markVolumeDetachedQuery,
  provisionWorkspaceVolume,
} from "./workspace-volumes.js";
import type { MachineResponse, MachineState, SetMachineTypeRequest } from "./wire.js";

const MACHINE_ERROR_MAX_LENGTH = 1_024;

/** Machine states a lifecycle verb may act on. `destroying` and `destroyed`
 * are already on their way out, and a second verb on top of them races the
 * janitor rather than doing anything. */
const LIVE_STATES: readonly MachineState[] = ["provisioning", "running", "stopped", "error"];

export function providerForVmId(runtime: CoreRuntime, vmId: string): VmProvider {
  const provider = runtime.providers.vmRegistry.forVmId(vmId);
  if (provider === undefined) {
    throw new HttpError(409, `no VM provider owns VM ID ${vmId}`);
  }
  return provider;
}

export function providerOperationError(error: unknown): string {
  if (!(error instanceof Error)) return "provider operation failed";
  const detail = error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return detail === "" ? "provider operation failed" : `provider operation failed: ${detail}`;
}

export async function machineById(db: Db, id: string): Promise<MachineRow | null> {
  return first<MachineRow>(db, { q: "SELECT * FROM machines WHERE id = ?1 LIMIT 1", v: [id] });
}

export async function machineFor(
  db: Db,
  workspaceId: string,
  membershipId: string,
): Promise<MachineRow | null> {
  return first<MachineRow>(db, {
    q: "SELECT * FROM machines WHERE workspace_id = ?1 AND membership_id = ?2 LIMIT 1",
    v: [workspaceId, membershipId],
  });
}

/** Every token family this machine has ever held stops working.
 *
 * A VM destroy is the revocation event: the guest that held the credential no
 * longer exists, and its disk may outlive it on a volume. The `vm_id` stamp
 * fences a guest that is still running somewhere; deleting the row is what
 * stops it minting. */
function revokeMachineTokensQuery(machineId: string): Query {
  return { q: "DELETE FROM machine_token_families WHERE machine_id = ?1", v: [machineId] };
}

/** Arms a fresh phone-home capability for the next boot. The capability is
 * per machine and re-armed at every VM provision, so a stale URL from a
 * previous incarnation cannot enroll a new one. */
async function armPhoneHome(db: Db, machineId: string, now: number): Promise<string> {
  const capability = randomToken();
  await rows(db, {
    q: `UPDATE machines
        SET phone_home_hash = ?1, phone_home_used = 0, updated_at = ?2
        WHERE id = ?3`,
    v: [await hashSecret(capability), now, machineId],
  });
  return capability;
}

async function markMachineError(
  runtime: CoreRuntime,
  machineId: string,
  message: string,
): Promise<MachineRow> {
  await rows(runtime.db, {
    q: `UPDATE machines
        SET state = 'error', error = ?1, phone_home_hash = NULL, updated_at = ?2
        WHERE id = ?3`,
    v: [message.slice(0, MACHINE_ERROR_MAX_LENGTH), Date.now(), machineId],
  });
  await touchWorkspace(runtime.db, machineId);
  const row = await machineById(runtime.db, machineId);
  if (row === null) throw new Error("machine disappeared during provision");
  return row;
}

/** Bumps the workspace revision so a poller sees the machine change. The
 * workspace has no lifecycle of its own, but it is still the row clients
 * watch, and a revision that never moves is a poll that never converges. */
async function touchWorkspace(db: Db, machineId: string): Promise<void> {
  await rows(db, {
    q: `UPDATE workspaces SET revision = revision + 1, updated_at = ?1
        WHERE id = (SELECT workspace_id FROM machines WHERE id = ?2)`,
    v: [Date.now(), machineId],
  });
}

export interface ProvisionMachineInput {
  workspace: WorkspaceRow;
  membershipId: string;
  /** The type this machine takes. Defaulted by the caller from the workspace
   * default or a per-member override; never re-derived here. */
  machineTypeId: string;
  requestOrigin: string;
  sshPublicKey?: string;
  userData?: string;
  /** A volume to reuse instead of creating one: a recreate or a machine-type
   * change keeps the member's disk. */
  volumeId?: string;
  /** Whether this machine gets its own volume when it has none to reuse.
   * Defaults to true; false skips the volume entirely, so the VM's disk is
   * the only one it has and nothing on it outlives the VM. */
  persistentVolume?: boolean;
  /** An existing machine row to bring back up, instead of inserting one. */
  machineId?: string;
  /** The plane that asked for this machine. Written on the INSERT and, for a
   * machine coming back from `destroyed`, re-stamped by the provision route —
   * see `provenanceForProvision`. */
  createdByPlane?: CreatedByPlane;
}

/**
 * Creates one member's VM and everything it needs.
 *
 * This is the one path a member's machine is ever created on: workspace
 * create, member add, provision, recreate, and the start that follows a
 * machine-type change all land here. A provider failure lands the machine in `error` with
 * the detail on the row rather than throwing, exactly as the workspace create
 * path always did — except a 413 (user data too large) and a 503 (no
 * capacity), which are request-shaped and thrown so the caller can answer.
 */
export async function provisionMachine(
  runtime: CoreRuntime,
  input: ProvisionMachineInput,
): Promise<MachineRow> {
  const workspace = input.workspace;
  const orgId = workspace.org_id;
  if (orgId === null) throw new HttpError(409, "workspace has no organization");
  const vmResolution = await resolveWorkspacePlacement(
    runtime.db,
    runtime.providers.vmRegistry,
    orgId,
    input.machineTypeId,
    input.volumeId,
  );
  const vmProvider = vmResolution.provider;
  const providerCapabilities = vmProvider.capabilities();
  const name = workspace.name ?? workspace.id;
  const now = Date.now();
  const id = input.machineId ?? crypto.randomUUID();

  if (input.machineId === undefined) {
    // The vm_limit gate lives inside the INSERT so two creates racing the last
    // slot cannot both win it. It counts machines, not workspaces: a workspace
    // is free and a VM is not.
    const inserted = await rows(runtime.db, {
      q: `INSERT INTO machines
          (id, workspace_id, membership_id, state, machine_type_id,
           compute_credential_source, volume_id, created_at, updated_at,
           created_by_plane)
          SELECT ?1, ?2, ?3, 'provisioning', ?4, ?5, ?6, ?7, ?7, ?9
          WHERE (
            SELECT COUNT(*) FROM machines m
            JOIN workspaces w ON w.id = m.workspace_id
            WHERE w.org_id = ?8 AND m.state IN (${MACHINE_SLOT_STATES})
          ) < (SELECT vm_limit FROM orgs WHERE id = ?8)
          RETURNING id`,
      v: [
        id,
        workspace.id,
        input.membershipId,
        input.machineTypeId,
        vmResolution.credentialSource ?? "deployment",
        input.volumeId ?? null,
        now,
        orgId,
        input.createdByPlane ?? "session",
      ],
    });
    if (inserted.length !== 1) {
      throw new HttpError(
        409,
        "organization workspace quota reached; destroy an existing workspace before creating another",
      );
    }
  } else {
    await rows(runtime.db, {
      q: `UPDATE machines
          SET state = 'provisioning', error = NULL, machine_type_id = ?1,
              compute_credential_source = ?2, vm_id = NULL, ssh_host = NULL,
              ssh_port = NULL, ssh_user = NULL, ssh_host_public_key = NULL,
              updated_at = ?3
          WHERE id = ?4`,
      v: [
        input.machineTypeId,
        vmResolution.credentialSource ?? "deployment",
        now,
        id,
      ],
    });
  }

  const capability = await armPhoneHome(runtime.db, id, now);
  // The URL keeps its workspace shape. Every deployed guest holds one it was
  // handed at creation and never updates it, and the route resolves the
  // machine by matching the capability hash, so one route serves both.
  const phoneHomeUrl = `${input.requestOrigin}/workspaces/${workspace.id}/phone-home/${capability}`;

  const orgCapture = await first<{ usage_capture: number }>(runtime.db, {
    q: "SELECT usage_capture FROM orgs WHERE id = ?1 LIMIT 1",
    v: [orgId],
  });
  const shaping: BootShaping = { usageCapture: orgCapture?.usage_capture === 1 };
  const providerAptSetup = vmProvider.bootstrapAptSetup?.();
  if (providerAptSetup !== undefined) shaping.providerAptSetup = providerAptSetup;
  const repos = await workspaceRepos(runtime.db, workspace.id);
  if (repos.length > 0) shaping.repos = repos.map(({ repo }) => repo);
  shaping.boxHostname = boxHostname(name, workspace.id);

  let autoVolumeId: string | undefined;
  try {
    const baseUserData = buildUserData(
      input.sshPublicKey,
      phoneHomeUrl,
      runtime.vars.boxImageRef,
      input.userData,
      runtime.vars.boxImageTag,
      runtime.vars.boxImageSha256,
      undefined,
      shaping,
    );
    const maxUserDataBytes = providerCapabilities.maxUserDataBytes ?? null;
    if (maxUserDataBytes !== null) {
      const encoder = new TextEncoder();
      const callerBytes = encoder.encode(input.userData ?? "").byteLength;
      const totalBytes = encoder.encode(baseUserData).byteLength;
      const generatedBytes = totalBytes - callerBytes;
      if (totalBytes > maxUserDataBytes) {
        throw new HttpError(
          413,
          `userData exceeds the provider limit: caller UTF-8 bytes ${callerBytes} + generated bootstrap bytes ${generatedBytes} = ${totalBytes} > ${maxUserDataBytes}`,
        );
      }
    }
    // The member's own disk. It holds /var/lib/blitz, which is the docker
    // store and /workspace both, so a destroyed machine can come back on it.
    // A member row that asked for no persistent volume gets none: the VM's
    // own disk is all there is, and it goes when the VM goes.
    const autoVolume = input.volumeId !== undefined || input.persistentVolume === false
      ? null
      : await provisionWorkspaceVolume({
          db: runtime.db,
          provider: vmProvider,
          createVolume: async (volumeName, sizeGb, location) => {
            const resolved = await runtime.providers.volume.forOrg(
              orgId,
              vmResolution.credentialSource,
            );
            return resolved.provider.createVolume({ name: volumeName, sizeGb, location });
          },
          deleteVolume: async (volumeId) => {
            const resolved = await runtime.providers.volume.forOrg(
              orgId,
              vmResolution.credentialSource,
            );
            await resolved.provider.deleteVolume(volumeId);
          },
          workspaceId: workspace.id,
          machineId: id,
          workspaceName: name,
          machineTypeId: input.machineTypeId,
          orgId,
          membershipId: input.membershipId,
          credentialSource: vmResolution.credentialSource,
          now: Date.now(),
        });
    if (autoVolume !== null) {
      autoVolumeId = autoVolume.id;
      await rows(runtime.db, {
        q: "UPDATE machines SET volume_id = ?1, updated_at = ?2 WHERE id = ?3",
        v: [autoVolume.id, Date.now(), id],
      });
    }
    const volumeId = input.volumeId ?? autoVolume?.id;
    const workspaceTunnels = runtime.providers.workspaceTunnels;
    const existing = await machineById(runtime.db, id);
    // A machine keeps the tunnel it already has: the hostname is baked into
    // the guest's cloudflared config, and re-provisioning one would orphan the
    // old Cloudflare resources.
    const tunnel = workspaceTunnels !== undefined
      && vmProvider.proxyWebApp === undefined
      && (existing?.tunnel_id ?? null) === null
      ? await workspaceTunnels.provision(runtime.db, id, workspace.id)
      : undefined;
    const userData = tunnel === undefined
      ? baseUserData
      : buildUserData(
          input.sshPublicKey,
          phoneHomeUrl,
          runtime.vars.boxImageRef,
          input.userData,
          runtime.vars.boxImageTag,
          runtime.vars.boxImageSha256,
          tunnel,
          shaping,
        );
    const attachesAtCreate = providerCapabilities.attachesVolumesAtCreate === true;
    const createInput: CreateVmInput = {
      workspaceId: workspace.id,
      machineId: id,
      machineTypeId: input.machineTypeId,
      sshPublicKey: input.sshPublicKey,
      phoneHomeUrl,
      userData,
    };
    if (attachesAtCreate && volumeId !== undefined) createInput.volumeIds = [volumeId];
    const vm = await vmProvider.createVm(createInput);
    await rows(runtime.db, {
      q: "UPDATE machines SET vm_id = ?1, updated_at = ?2 WHERE id = ?3",
      v: [vm.id, Date.now(), id],
    });
    if (volumeId !== undefined && !attachesAtCreate) {
      const volume = await runtime.providers.volume.forOrg(orgId, vmResolution.credentialSource);
      await volume.provider.attachVolume(volumeId, vm.id);
    }
    if (volumeId !== undefined) {
      await rows(runtime.db, markVolumeAttachedQuery(volumeId));
    }
    await rows(runtime.db, {
      q: `UPDATE machines
          SET ssh_host = ?1, ssh_port = ?2, ssh_user = ?3, updated_at = ?4
          WHERE id = ?5`,
      v: [vm.host, vm.port, vm.user, Date.now(), id],
    });
  } catch (error) {
    if (autoVolumeId !== undefined) {
      try {
        const resolved = await runtime.providers.volume.forOrg(
          orgId,
          vmResolution.credentialSource,
        );
        await resolved.provider.deleteVolume(autoVolumeId);
        await transaction(runtime.db, [
          {
            q: "DELETE FROM volume_ownership WHERE volume_id = ?1 AND org_id = ?2",
            v: [autoVolumeId, orgId],
          },
          { q: "UPDATE machines SET volume_id = NULL WHERE id = ?1", v: [id] },
        ]);
      } catch (cleanupError) {
        runtime.reportError(
          "machine_provision_volume_cleanup_failed",
          cleanupError instanceof Error
            ? cleanupError
            : new Error(`volume ${autoVolumeId} survived a failed provision`),
        );
      }
    }
    if (error instanceof HttpError && (error.status === 503 || error.status === 413)) {
      // Nothing was created, so nothing is left to reclaim. The row goes and
      // the caller answers with the provider's own refusal.
      await rows(runtime.db, { q: "DELETE FROM machines WHERE id = ?1", v: [id] });
      throw error;
    }
    return markMachineError(runtime, id, providerOperationError(error));
  }
  await touchWorkspace(runtime.db, id);
  const row = await machineById(runtime.db, id);
  if (row === null) throw new Error("machine disappeared during provision");
  return row;
}

/** Destroys the VM incarnation and, unless `keepVolume`, starts the volume's
 * retention clock. The machine row survives in `state`. */
async function destroyVm(
  runtime: CoreRuntime,
  machine: MachineRow,
  options: { keepVolume: boolean },
): Promise<void> {
  const workspace = await workspaceById(runtime.db, machine.workspace_id);
  const orgId = workspace?.org_id ?? null;
  if (machine.vm_id === null || orgId === null) return;
  const resolved = await runtime.providers.vmRegistry.resolveVmId(
    machine.vm_id,
    orgId,
    machine.compute_credential_source,
  );
  if (resolved === undefined) {
    throw new HttpError(409, `no VM provider owns VM ID ${machine.vm_id}`);
  }
  if (machine.volume_id !== null) {
    await resolved.provider.shutdown(machine.vm_id);
    const volume = await runtime.providers.volume.forOrg(
      orgId,
      machine.compute_credential_source,
    );
    await volume.provider.detachVolume(machine.volume_id, machine.vm_id);
    if (!options.keepVolume) {
      await rows(runtime.db, markVolumeDetachedQuery(machine.volume_id, Date.now()));
    }
  }
  await resolved.provider.destroy(machine.vm_id);
}

export interface DestroyMachineOptions {
  /** Keep the machine row and its volume, so a new VM can come back on the
   * same disk. This is what a machine-type change and a recreate do. */
  keepRow: boolean;
}

/**
 * Takes a machine down.
 *
 * The token families go first, so a guest that is still running cannot mint
 * anything on its way out. Cloudflare resources are cleaned before the state
 * flips, and a failure there leaves the row in `destroying` for the janitor,
 * which is the same honest-destroy shape the workspace destroy always had.
 *
 * `keepRow` is written to the row in the same statement that enters
 * `destroying`, because the janitor is the OTHER half of this function: a
 * teardown that never reaches its last statement — a provider that throws, a
 * request that dies, a sweep that gets there first — is finished by
 * `runOrphanSweep`, and `destroying` alone does not say whether the machine
 * was coming back. Reading the intent from memory is what turned a stop into
 * a tombstone (migration 0047).
 */
export async function destroyMachine(
  runtime: CoreRuntime,
  machine: MachineRow,
  options: DestroyMachineOptions = { keepRow: false },
): Promise<MachineRow> {
  await rows(runtime.db, {
    q: `UPDATE machines
        SET state = 'destroying', destroy_keeps_row = ?1, error = NULL,
            phone_home_hash = NULL, updated_at = ?2
        WHERE id = ?3 AND state IN ('provisioning', 'running', 'stopped', 'error')`,
    v: [options.keepRow ? 1 : 0, Date.now(), machine.id],
  });
  await rows(runtime.db, revokeMachineTokensQuery(machine.id));
  await destroyVm(runtime, machine, { keepVolume: options.keepRow });

  const workspaceTunnels = runtime.providers.workspaceTunnels;
  if (workspaceTunnels !== undefined && !options.keepRow) {
    const cleanup = await workspaceTunnels.cleanup(runtime.db, machine);
    if (cleanup.errors.length > 0) {
      const pending = await machineById(runtime.db, machine.id);
      if (pending === null) throw new Error("machine disappeared during destroy");
      return pending;
    }
  }

  await transaction(runtime.db, [
    revokeMachineLeasesQuery(machine.id),
    // The guest's authorized_keys lines go with the VM. Destroy stays the
    // revocation path for the broker: the keys leave, and the member's account
    // survives because the feed is driven by `broker_members`, not by keys.
    { q: "DELETE FROM broker_keys WHERE machine_id = ?1", v: [machine.id] },
    {
      q: `UPDATE machines
          SET state = ?1, destroy_keeps_row = 0, vm_id = NULL, ssh_host = NULL,
              ssh_port = NULL, ssh_user = NULL, ssh_host_public_key = NULL,
              error = NULL, updated_at = ?2
          WHERE id = ?3 AND state = 'destroying'`,
      v: [options.keepRow ? "stopped" : "destroyed", Date.now(), machine.id],
    },
  ]);
  await touchWorkspace(runtime.db, machine.id);
  const row = await machineById(runtime.db, machine.id);
  if (row === null) throw new Error("machine disappeared after destroy");
  return row;
}

/** Every machine of one workspace, live states only. */
export async function liveMachines(db: Db, workspaceId: string): Promise<MachineRow[]> {
  return rows<MachineRow>(db, {
    q: `SELECT * FROM machines
        WHERE workspace_id = ?1 AND state != 'destroyed'
        ORDER BY created_at, id`,
    v: [workspaceId],
  });
}

function parseSetMachineType(value: JsonValue): SetMachineTypeRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  return { machineTypeId: requiredString(value.machineTypeId, "machineTypeId", 256) };
}

/**
 * The public key to put in the machine's `authorized_key`, if the caller sent
 * one. Same validation the workspace-create field used before it was deleted —
 * this is now the ONLY way a key reaches a machine.
 *
 * An absent key is not an empty key: it leaves whatever the volume already
 * carries in place (see `core/bootstrap.ts`), so a plain `provision` never
 * silently locks a member out of their own disk.
 */
function parseMachineKey(value: JsonValue): string | undefined {
  if (value === null) return undefined;
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  if (value.sshPublicKey === undefined || value.sshPublicKey === null) return undefined;
  const key = requiredString(value.sshPublicKey, "sshPublicKey").trim();
  if (key === "") return undefined;
  if (!isSshPublicKey(key)) throw new HttpError(400, "sshPublicKey must be an SSH public key");
  return key;
}

/** An optional JSON body. These verbs took none until the key arrived, and a
 * caller that still sends nothing must keep working. */
async function optionalBody(request: Request): Promise<JsonValue> {
  if (request.body === null) return null;
  const text = await request.text();
  if (text.trim() === "") return null;
  try {
    // SAFETY: JSON.parse returns a JsonValue by construction; the parse failure is caught below.
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/**
 * What provenance a provision writes.
 *
 * `destroyed` means the VM AND its volume are already gone (`destroyMachine`
 * passes `keepVolume: false` on that path), so nothing of the previous owner
 * survives and the caller is genuinely making a new machine: it is stamped
 * with the caller's plane.
 *
 * `stopped` is the opposite — the volume, and the member's work on it, is
 * still there. Provisioning that is RESUMING somebody's machine, not creating
 * one, so provenance is left exactly as it was. Without this distinction an
 * agent could stop a person's machine, provision it to re-stamp it as its own,
 * and then destroy it with the disk; the rule below would wave it through.
 */
function provenanceForProvision(
  machine: MachineRow,
  principal: Principal,
): CreatedByPlane | undefined {
  return machine.state === "destroyed" ? principal.plane : undefined;
}

/**
 * An agent may destroy only what the agent plane created.
 *
 * An agent authenticates as its own member, so every ownership check below
 * says yes to whatever that person may do — including destroying the machine
 * they are working on. Membership cannot separate the two, because it is the
 * same membership; `machines.created_by_plane` can, and this is the one place
 * it is read.
 *
 * A person at a browser is never judged by this: `plane` is `"session"` for a
 * cookie, an operator token and a signed OAuth state alike, so the product's
 * own delete and recreate buttons behave exactly as they always have, on every
 * machine.
 */
function assertMachinePlaneMayDestroy(
  principal: Principal,
  machine: MachineRow,
  verb: "destroy" | "recreate",
): void {
  if (principal.plane === "session") return;
  if (machine.created_by_plane === "session") {
    throw new HttpError(
      403,
      `an agent may not ${verb} this machine: a person created it`,
    );
  }
}

/** The location a provider places this machine type's volume in, or null when
 * it cannot say. A cross-location change needs a volume move, which is
 * deferred (plan §5), so a null on either side is treated as unknown and the
 * change is refused rather than guessed at. */
function volumeLocationFor(provider: VmProvider, machineTypeId: string): string | null {
  return provider.volumeLocation?.(machineTypeId) ?? null;
}

/** The provision input for a machine that already has a row: bring this one
 * back up on the type and volume it holds. Built in statements rather than
 * spreads, because `volumeId` is genuinely absent on a machine that never got
 * a disk and an empty spread hides that. */
function reprovisionInput(
  workspace: WorkspaceRow,
  machine: MachineRow,
  machineTypeId: string,
  requestOrigin: string,
): ProvisionMachineInput {
  const input: ProvisionMachineInput = {
    workspace,
    membershipId: machine.membership_id,
    machineTypeId,
    requestOrigin,
    machineId: machine.id,
  };
  if (machine.volume_id !== null) input.volumeId = machine.volume_id;
  return input;
}

interface MachineTarget {
  workspace: WorkspaceRow;
  machine: MachineRow;
  admin: boolean;
}

export function addMachineRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  /** Resolves the machine a verb names and grades the caller against §3.
   *
   * `own` is what a plain member may do to their own machine (stop, start).
   * Everything else is workspace-admin work, and an org admin passes through
   * implicit reach. */
  async function target(
    context: CoreContext,
    runtime: CoreRuntime,
    scope: "admin" | "own",
  ): Promise<MachineTarget & { principal: Principal }> {
    const principal = await requirePrincipal(context);
    const machine = await machineById(runtime.db, context.req.param("machineId"));
    if (machine === null) throw new HttpError(404, "machine not found");
    const workspace = await workspaceById(runtime.db, machine.workspace_id);
    if (workspace === null || workspace.org_id !== principal.orgId) {
      throw new HttpError(404, "machine not found");
    }
    const access = await workspaceAccess(runtime.db, principal, workspace);
    const admin = isWorkspaceAdmin(access);
    if (!admin) {
      if (scope === "admin") throw new HttpError(403, "workspace admin required");
      if (access.stored !== "member" || machine.membership_id !== principal.membershipId) {
        throw new HttpError(403, "forbidden");
      }
    }
    return { workspace, machine, admin, principal };
  }

  /** Brings up a machine that has no VM. A member whose workspace has
   * `auto_provision` off lands here on first open. */
  router.post("/machines/:machineId/provision", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, machine, principal } = await target(context, runtime, "own");
    if (machine.vm_id !== null) throw new HttpError(409, "machine already has a VM");
    if (!LIVE_STATES.includes(machine.state) && machine.state !== "destroyed") {
      throw new HttpError(409, `machine is ${machine.state}`);
    }
    const sshPublicKey = parseMachineKey(await optionalBody(context.req.raw));
    const provenance = provenanceForProvision(machine, principal);
    const input = reprovisionInput(
      workspace,
      machine,
      machine.machine_type_id,
      new URL(context.req.url).origin,
    );
    if (sshPublicKey !== undefined) input.sshPublicKey = sshPublicKey;
    if (provenance !== undefined) {
      input.createdByPlane = provenance;
      await rows(runtime.db, {
        q: "UPDATE machines SET created_by_plane = ?1, updated_at = ?2 WHERE id = ?3",
        v: [provenance, Date.now(), machine.id],
      });
    }
    const provisioned = await provisionMachine(runtime, input);
    return context.json<MachineResponse>({ machine: machineView(provisioned) });
  });

  /** Stop keeps the disk and the machine row. The VM goes, because a stopped
   * cloud VM still bills for itself on most providers and the volume is where
   * the state actually lives (#88). */
  router.post("/machines/:machineId/stop", async (context) => {
    const runtime = runtimeFactory(context);
    const { machine } = await target(context, runtime, "own");
    if (machine.state === "stopped") {
      return context.json<MachineResponse>({ machine: machineView(machine) });
    }
    if (!LIVE_STATES.includes(machine.state)) {
      throw new HttpError(409, `machine is ${machine.state}`);
    }
    const stopped = await destroyMachine(runtime, machine, { keepRow: true });
    return context.json<MachineResponse>({ machine: machineView(stopped) });
  });

  /**
   * Brings a machine that has no VM back up, on the disk it already has.
   *
   * `destroying` is the only refusal: a teardown is in flight and a second VM
   * on the same volume would race its finaliser. `destroyed` is accepted,
   * because the row and the volume outlive the tombstone — a destroy keeps the
   * disk for its retention window (§2.3), and boxes in the field carry rows
   * that a janitor tombstoned mid-stop before migration 0047 recorded the
   * intent. Refusing those was the second half of the trap: the workspace
   * projects as `destroyed`, the member's `machine` reads null, and the one
   * verb that could have brought it back said 409.
   *
   * Provenance is deliberately NOT re-stamped here, unlike `provision`: start
   * resumes a machine and never creates one, so it cannot be the step that
   * makes somebody else's surviving disk an agent's to destroy.
   */
  router.post("/machines/:machineId/start", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, machine } = await target(context, runtime, "own");
    if (machine.vm_id !== null) {
      return context.json<MachineResponse>({ machine: machineView(machine) });
    }
    if (machine.state === "destroying") {
      throw new HttpError(409, `machine is ${machine.state}`);
    }
    const started = await provisionMachine(runtime, reprovisionInput(
      workspace,
      machine,
      machine.machine_type_id,
      new URL(context.req.url).origin,
    ));
    return context.json<MachineResponse>({ machine: machineView(started) });
  });

  /** Replaces the VM on the same volume. Sessions restart; disk state
   * survives. Workspace-admin only, because it interrupts whoever is working
   * on that machine. */
  router.post("/machines/:machineId/recreate", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, machine, principal } = await target(context, runtime, "admin");
    assertMachinePlaneMayDestroy(principal, machine, "recreate");
    if (machine.state === "destroying") throw new HttpError(409, "machine is destroying");
    const sshPublicKey = parseMachineKey(await optionalBody(context.req.raw));
    const stopped = await destroyMachine(runtime, machine, { keepRow: true });
    // Provenance is deliberately NOT touched here: a recreate replaces the VM
    // on the same volume, so it is the same machine and the same owner.
    const input = reprovisionInput(
      workspace,
      stopped,
      machine.machine_type_id,
      new URL(context.req.url).origin,
    );
    if (sshPublicKey !== undefined) input.sshPublicKey = sshPublicKey;
    const recreated = await provisionMachine(runtime, input);
    return context.json<MachineResponse>({ machine: machineView(recreated) });
  });

  /**
   * The machine-type change (§1a).
   *
   * The VM is an incarnation and the volume is the machine, so this destroys
   * the first and keeps the second. A type in another location is refused:
   * a volume attaches only inside its own location, and moving one needs a
   * snapshot-and-restore that is deferred (§5).
   */
  router.post("/machines/:machineId/machine-type", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, machine } = await target(context, runtime, "admin");
    const input = parseSetMachineType(await readJson(context.req.raw, 4 * 1024));
    if (input.machineTypeId === machine.machine_type_id) {
      return context.json<MachineResponse>({ machine: machineView(machine) });
    }
    if (machine.state === "destroying" || machine.state === "destroyed") {
      throw new HttpError(409, `machine is ${machine.state}`);
    }
    const orgId = workspace.org_id;
    if (orgId === null) throw new HttpError(409, "workspace has no organization");
    const next = await runtime.providers.vmRegistry.forMachineType(input.machineTypeId, orgId);
    if (machine.volume_id !== null) {
      const current = await runtime.providers.vmRegistry.forMachineType(
        machine.machine_type_id,
        orgId,
      );
      const from = volumeLocationFor(current.provider, machine.machine_type_id);
      const to = volumeLocationFor(next.provider, input.machineTypeId);
      if (from === null || to === null || from !== to) {
        throw new HttpError(
          409,
          `the volume is in ${from ?? "an unknown location"}; moving a machine to another location is not supported yet`,
        );
      }
    }
    const stopped = await destroyMachine(runtime, machine, { keepRow: true });
    const changed = await provisionMachine(runtime, reprovisionInput(
      workspace,
      stopped,
      input.machineTypeId,
      new URL(context.req.url).origin,
    ));
    return context.json<MachineResponse>({ machine: machineView(changed) });
  });

  router.delete("/machines/:machineId", async (context) => {
    const runtime = runtimeFactory(context);
    const { machine, principal } = await target(context, runtime, "admin");
    assertMachinePlaneMayDestroy(principal, machine, "destroy");
    if (machine.state === "destroyed") {
      return context.json<MachineResponse>({ machine: machineView(machine) });
    }
    const destroyed = await destroyMachine(runtime, machine);
    return context.json<MachineResponse>({ machine: machineView(destroyed) });
  });
}

export { requireWorkspaceAdmin };
