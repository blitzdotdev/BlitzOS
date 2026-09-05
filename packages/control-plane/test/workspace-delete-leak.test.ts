/**
 * What a workspace delete must leave behind at the provider: nothing.
 *
 * Both cases here were real leaks on canary. A stopped machine has no VM and
 * still owns its disk, and the retention clock was stamped only on the VM
 * path — so its volume left the delete with no clock, and `expiredVolumes`
 * never returns an undated row. And the destroy loop threw on the first bad
 * machine, so every later member's server stayed up; because the retry
 * restarts at the same machine, a permanent provider failure wedged the
 * delete for good.
 */
import type { WorkspaceView } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  harness,
  machineIdFor,
  operatorSession,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

function json(body: object, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface CreatedWorkspace {
  workspace: WorkspaceView;
}

async function machineRow(workspaceId: string, membershipId: string) {
  return env.DB
    .prepare(
      "SELECT id, state, volume_id, vm_id FROM machines WHERE workspace_id = ?1 AND membership_id = ?2",
    )
    .bind(workspaceId, membershipId)
    .first<{ id: string; state: string; volume_id: string | null; vm_id: string | null }>();
}

async function detachedAt(volumeId: string): Promise<number | null> {
  return env.DB
    .prepare("SELECT detached_at FROM volume_ownership WHERE volume_id = ?1")
    .bind(volumeId)
    .first<number | null>("detached_at");
}

describe("workspace delete leaves nothing at the provider", () => {
  beforeEach(resetDatabase);

  it("starts the retention clock on a stopped member's volume too", async () => {
    const { app, providers } = harness();
    providers.volumeLocation = () => "test";
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("teammate");

    const created = await appRequest(app, "/workspaces", {
      ...json({
        defaultMachineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<CreatedWorkspace>()).workspace;

    const ownerVolume = (await machineRow(workspace.id, "personal"))?.volume_id;
    const mateVolume = (await machineRow(workspace.id, teammate.membershipId))?.volume_id;
    expect(ownerVolume).not.toBeNull();
    expect(mateVolume).not.toBeNull();

    // The teammate stops their machine first. Stop keeps the disk and leaves
    // the clock unset on purpose — that part is not the bug.
    const mateMachine = await machineIdFor(workspace.id, teammate.membershipId);
    expect((await appRequest(app, `/machines/${mateMachine}/stop`, {
      method: "POST",
      headers: { Cookie: cookie },
    })).status).toBe(200);
    expect((await machineRow(workspace.id, teammate.membershipId))?.state).toBe("stopped");
    expect(await detachedAt(mateVolume as string)).toBeNull();

    const deleted = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
    expect((await machineRow(workspace.id, teammate.membershipId))?.state).toBe("destroyed");

    // Both volumes carry a clock now, so the retention sweep reclaims both.
    expect(await detachedAt(ownerVolume as string)).not.toBeNull();
    expect(await detachedAt(mateVolume as string)).not.toBeNull();
  });

  it("destroys every other member's VM when one machine's provider fails", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("teammate");

    const created = await appRequest(app, "/workspaces", {
      ...json({
        defaultMachineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<CreatedWorkspace>()).workspace;

    // The owner's machine is destroyed first (`liveMachines` orders by
    // creation), so its failure is what used to spare the teammate's server.
    const ownerMachine = await machineIdFor(workspace.id, "personal");
    providers.onDestroy = async (machineId: string) => {
      if (machineId === ownerMachine) throw new Error("hetzner is having a day");
    };

    const deleted = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    // The caller still hears the failure: the first error is rethrown once
    // every machine has been asked to go.
    expect(deleted.status).toBe(500);

    const mate = await machineRow(workspace.id, teammate.membershipId);
    expect(mate?.state).toBe("destroyed");
    expect(mate?.vm_id).toBeNull();

    // The failing machine keeps its VM id and stays in `destroying`, which is
    // the row shape `runOrphanSweep` retries.
    const owner = await machineRow(workspace.id, "personal");
    expect(owner?.state).toBe("destroying");
    expect(owner?.vm_id).not.toBeNull();

    // And the workspace does not tombstone while a machine is still up.
    expect(await env.DB
      .prepare("SELECT deleted_at FROM workspaces WHERE id = ?1")
      .bind(workspace.id).first<number | null>("deleted_at")).toBeNull();
  });
});
