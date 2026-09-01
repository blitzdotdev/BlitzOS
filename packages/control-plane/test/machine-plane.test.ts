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

  it("drives another machine's whole lifecycle as its member", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // The real shape: the agent's box lives in one workspace and drives the
    // machine in another.
    const home = await createWorkspace(app, cookie);
    const target = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, home.id);
    const machineId = await machineIdFor(target.id);

    const stopped = await appRequest(app, `/machines/${machineId}/stop`, asBox(token, "POST"));
    expect(stopped.status).toBe(200);
    expect((await stopped.json<MachineResponse>()).machine.state).toBe("stopped");

    expect((await appRequest(app, `/machines/${machineId}/start`, asBox(token, "POST"))).status)
      .toBe(200);
    expect((await appRequest(app, `/machines/${machineId}/recreate`, asBox(token, "POST"))).status)
      .toBe(200);

    const destroyed = await appRequest(app, `/machines/${machineId}`, asBox(token, "DELETE"));
    expect(destroyed.status).toBe(200);
    expect((await destroyed.json<MachineResponse>()).machine.state).toBe("destroyed");
  });

  it("lets an agent destroy its own machine, and dies with it", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);
    const machineId = await machineIdFor(workspace.id);

    // This is the accepted model, stated as a test rather than left implicit:
    // the credential is the member's, so an agent may destroy any machine its
    // member may — its own box's included.
    const destroyed = await appRequest(app, `/machines/${machineId}`, asBox(token, "DELETE"));
    expect(destroyed.status).toBe(200);

    // And it is self-limiting. Destroying a machine drops its token family, so
    // the credential that asked stops working on the way out. An agent cannot
    // keep operating on a box it has just deleted.
    expect((await appRequest(app, "/workspaces", asBox(token))).status).toBe(401);
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
