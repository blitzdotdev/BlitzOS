import type { CreateWorkspaceResponse, MachineResponse, PollResponse } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { machinePlaneAllows } from "../core/machine-plane.js";
import {
  appRequest,
  boxTokenFor,
  createWorkspace,
  harness,
  machineIdFor,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

/**
 * The machine API: what a box credential may do on the routes a browser uses.
 *
 * Two things are under test and they are deliberately separate:
 *
 *  1. THE ALLOWLIST. A box credential resolves a principal on machine
 *     lifecycle and the two workspace reads that find a machine. Everywhere
 *     else it authenticates nothing and the request 401s.
 *  2. AUTHENTICATION. On those routes it acts as the member
 *     `machines.membership_id` names, resolved at call time — with exactly
 *     that member's reach, no more and no less.
 */

function asBox(token: string, method = "GET"): RequestInit {
  return { method, headers: { Authorization: `Bearer ${token}` } };
}

/** The plane recorded against a machine — the whole basis of the destroy rule,
 * so it is read from the row rather than inferred from a refusal. */
async function planeOf(machineId: string): Promise<string | undefined> {
  const row = await env.DB
    .prepare("SELECT created_by_plane FROM machines WHERE id = ?1")
    .bind(machineId)
    .first<{ created_by_plane: string }>();
  return row?.created_by_plane;
}

describe("machine plane: the allowlist", () => {
  beforeEach(resetDatabase);

  // A pure predicate, so the table is asserted directly rather than inferred
  // from a hundred round trips. The routes that matter are then exercised for
  // real in the suite below.
  it("names machine lifecycle and the two workspace reads", () => {
    for (const [method, path] of [
      ["GET", "/workspaces"],
      ["GET", "/workspaces/ws-1"],
      ["GET", "/machine-types"],
      ["POST", "/machines/m-1/provision"],
      ["POST", "/machines/m-1/start"],
      ["POST", "/machines/m-1/stop"],
      ["POST", "/machines/m-1/recreate"],
      ["DELETE", "/machines/m-1"],
    ] as const) {
      expect(machinePlaneAllows(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("refuses workspace lifecycle, identity, and everything unnamed", () => {
    for (const [method, path] of [
      // Workspace lifecycle is not a machine API.
      ["POST", "/workspaces"],
      ["DELETE", "/workspaces/ws-1"],
      ["POST", "/workspaces/ws-1/recreate"],
      // The escalation an earlier cut of this change would have allowed.
      ["POST", "/oauth/device/approve"],
      // Identity, org and billing.
      ["POST", "/sessions/switch-org"],
      ["DELETE", "/sessions"],
      ["POST", "/workspaces/ws-1/members"],
      ["DELETE", "/workspaces/ws-1/members/m-1"],
      ["PUT", "/orgs/org-1/entitlements"],
      ["POST", "/operator-tokens"],
      // Spending: a type change destroys the VM and re-provisions at another
      // price.
      ["POST", "/machines/m-1/machine-type"],
      // The deleted-workspace list has the shape of /workspaces/:id and is a
      // different route.
      ["GET", "/workspaces/history"],
      // The webApp proxy is not on this plane; SSH is how an agent gets in.
      ["GET", "/workspaces/ws-1/webapp/7445/diag"],
      ["GET", "/workspaces/ws-1/shared/mem-2/webapp/7445/diag"],
      // Right path, wrong method.
      ["DELETE", "/workspaces"],
      ["POST", "/workspaces/ws-1"],
    ] as const) {
      expect(machinePlaneAllows(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("makes the device-approve escalation structurally impossible", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);

    // The allowlist is consulted before the credential is ever read, so a
    // perfectly valid box token authenticates nothing here.
    const started = await appRequest(app, "/oauth/device_authorization", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=test",
    });
    expect(started.status).toBe(200);
    const { user_code: userCode } = await started.json<{ user_code: string }>();

    const approved = await appRequest(app, "/oauth/device/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `user_code=${encodeURIComponent(userCode)}`,
    });
    expect(approved.status).toBe(401);
  });

  it("refuses workspace create and delete from a box credential", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);

    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small" }),
    });
    expect(created.status).toBe(401);

    const deleted = await appRequest(app, `/workspaces/${workspace.id}`, asBox(token, "DELETE"));
    expect(deleted.status).toBe(401);

    // And the workspace is untouched.
    const still = await appRequest(app, `/workspaces/${workspace.id}`, asBox(token));
    expect((await still.json<CreateWorkspaceResponse>()).workspace.phase).not.toBe("destroyed");
  });
});

describe("machine plane: authentication", () => {
  beforeEach(resetDatabase);

  it("authenticates a machine's box credential as its member", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);

    const listed = await appRequest(app, "/workspaces", asBox(token));
    expect(listed.status).toBe(200);
    const { workspaces } = await listed.json<PollResponse>();
    expect(workspaces.map(({ id }) => id)).toContain(workspace.id);

    expect((await appRequest(app, "/machine-types", asBox(token))).status).toBe(200);

    // The read an agent makes to find where to SSH.
    const one = await appRequest(app, `/workspaces/${workspace.id}`, asBox(token));
    expect(one.status).toBe(200);
    expect(await one.json<CreateWorkspaceResponse>()).toHaveProperty("workspace.ssh");
  });

  it("starts and stops a person's machine, but never destroys one", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // The real shape: the agent's box lives in one workspace and drives the
    // machine in another.
    const home = await createWorkspace(app, cookie);
    const target = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, home.id);
    const machineId = await machineIdFor(target.id);

    // Start and stop lose nothing, so they are open on a person's machine.
    const stopped = await appRequest(app, `/machines/${machineId}/stop`, asBox(token, "POST"));
    expect(stopped.status).toBe(200);
    expect((await stopped.json<MachineResponse>()).machine.state).toBe("stopped");

    expect((await appRequest(app, `/machines/${machineId}/start`, asBox(token, "POST"))).status)
      .toBe(200);

    // Destroying does lose something, and a person created this one.
    expect((await appRequest(app, `/machines/${machineId}/recreate`, asBox(token, "POST"))).status)
      .toBe(403);
    expect((await appRequest(app, `/machines/${machineId}`, asBox(token, "DELETE"))).status)
      .toBe(403);
  });

  it("gives an agent full lifecycle over a machine the agent plane created", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const home = await createWorkspace(app, cookie);
    const target = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, home.id);
    const machineId = await machineIdFor(target.id);

    // A person destroys their machine from the browser: the VM and its volume
    // both go, so nothing of theirs is left on it.
    expect((await appRequest(app, `/machines/${machineId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(200);

    // The agent provisions it. That is genuinely creating a machine, so the
    // provenance becomes the agent's.
    const provisioned = await appRequest(
      app,
      `/machines/${machineId}/provision`,
      asBox(token, "POST"),
    );
    expect(provisioned.status).toBe(200);

    // ...and now it may recreate and destroy what it made.
    expect((await appRequest(app, `/machines/${machineId}/recreate`, asBox(token, "POST"))).status)
      .toBe(200);
    const destroyed = await appRequest(app, `/machines/${machineId}`, asBox(token, "DELETE"));
    expect(destroyed.status).toBe(200);
    expect((await destroyed.json<MachineResponse>()).machine.state).toBe("destroyed");
  });

  it("does not let a provision launder a person's stopped machine", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const home = await createWorkspace(app, cookie);
    const target = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, home.id);
    const machineId = await machineIdFor(target.id);

    // Stop keeps the volume, so the person's work is still on it. Provisioning
    // that is RESUMING their machine, not creating one — provenance must not
    // move, or an agent could stop-provision-destroy its way through somebody
    // else's disk.
    expect((await appRequest(app, `/machines/${machineId}/stop`, asBox(token, "POST"))).status)
      .toBe(200);
    expect((await appRequest(app, `/machines/${machineId}/provision`, asBox(token, "POST"))).status)
      .toBe(200);

    expect((await appRequest(app, `/machines/${machineId}`, asBox(token, "DELETE"))).status)
      .toBe(403);
  });

  it("preserves provenance across a recreate", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const home = await createWorkspace(app, cookie);
    const target = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, home.id);
    const machineId = await machineIdFor(target.id);

    await appRequest(app, `/machines/${machineId}`, { method: "DELETE", headers: { Cookie: cookie } });
    await appRequest(app, `/machines/${machineId}/provision`, asBox(token, "POST"));
    expect(await planeOf(machineId)).toBe("machine");

    expect((await appRequest(app, `/machines/${machineId}/recreate`, asBox(token, "POST"))).status)
      .toBe(200);
    // A recreate replaces the VM on the same volume: same machine, same owner.
    expect(await planeOf(machineId)).toBe("machine");
  });

  it("accepts an SSH key on provision and recreate, and only a valid one", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const home = await createWorkspace(app, cookie);
    const target = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, home.id);
    const machineId = await machineIdFor(target.id);
    const key = "ssh-ed25519 AAAAC3Nzaagentkey agent@box";

    await appRequest(app, `/machines/${machineId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const provisioned = await appRequest(app, `/machines/${machineId}/provision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sshPublicKey: ` \t${key}\n ` }),
    });
    expect(provisioned.status).toBe(200);
    // Trimmed, and handed to the provider as the machine's authorized key.
    expect(providers.sshPublicKeys.get(machineId)).toBe(key);

    const recreated = await appRequest(app, `/machines/${machineId}/recreate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sshPublicKey: key }),
    });
    expect(recreated.status).toBe(200);

    const refused = await appRequest(app, `/machines/${machineId}/recreate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sshPublicKey: "not-a-key" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("sshPublicKey must be an SSH public key");
  });

  it("refuses to let an agent destroy its own machine: a person created it", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);
    const machineId = await machineIdFor(workspace.id);

    // The agent's own box was created from a browser, so it is a person's
    // machine and the agent may not take it away — not even from itself.
    for (const [path, method] of [
      [`/machines/${machineId}`, "DELETE"],
      [`/machines/${machineId}/recreate`, "POST"],
    ] as const) {
      const refused = await appRequest(app, path, asBox(token, method));
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.text()).toContain("a person created it");
    }

    // Still very much alive.
    expect((await appRequest(app, "/workspaces", asBox(token))).status).toBe(200);
  });

  it("refuses a bearer that is not a live machine credential", async () => {
    const { app } = harness();
    await operatorSession(app);
    expect((await appRequest(app, "/workspaces", asBox("not-a-token"))).status).toBe(401);
  });

  it("drops org reach when the machine's membership stops being active", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);
    expect((await appRequest(app, "/workspaces", asBox(token))).status).toBe(200);

    await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = 'personal'").run();

    // The membership is the identity, resolved at call time, so revoking it
    // takes effect on the very next call rather than at a token expiry.
    expect((await appRequest(app, "/workspaces", asBox(token))).status).toBe(401);
  });

  it("leaves the session plane alone", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);

    // A person still creates and deletes workspaces from the browser.
    const deleted = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
  });
});
