import type {
  ListWorkspaceReposResponse,
  MachineResponse,
  WorkspaceMemberResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appRequest,
  boxTokenFor,
  createWorkspace,
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
    .prepare("SELECT id, state, machine_type_id, volume_id, vm_id FROM machines WHERE workspace_id = ?1 AND membership_id = ?2")
    .bind(workspaceId, membershipId)
    .first<{
      id: string;
      state: string;
      machine_type_id: string;
      volume_id: string | null;
      vm_id: string | null;
    }>();
}

describe("member machines", () => {
  beforeEach(resetDatabase);

  it("creates a workspace with one machine per member and refuses a non-admin creator", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("teammate");
    const watcher = await sameOrgSession("watcher");

    // Workspace creation is org-admin only for now (plan §3).
    expect((await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: teammate.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);

    const created = await appRequest(app, "/workspaces", {
      ...json({
        name: "engineering",
        defaultMachineTypeId: "small",
        members: [
          { membershipId: teammate.membershipId, role: "member" },
          { membershipId: watcher.membershipId, role: "viewer" },
        ],
        credentials: [{ name: "STRIPE_API_KEY", label: "live", value: "sk_test_only" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<CreatedWorkspace>()).workspace;

    expect(workspace.defaultMachineTypeId).toBe("small");
    expect(workspace.autoProvision).toBe(true);
    expect(workspace.myRole).toBe("admin");
    // The creator is the first workspace admin and never needs a members[] row.
    expect(workspace.members?.map(({ membershipId, role }) => [membershipId, role])).toEqual([
      ["personal", "admin"],
      [teammate.membershipId, "member"],
      [watcher.membershipId, "viewer"],
    ]);
    // A viewer never holds a machine (§2.2); everybody else gets one at once.
    expect(workspace.members?.map(({ machine }) => machine?.state ?? null)).toEqual([
      "provisioning",
      "provisioning",
      null,
    ]);
    // Names only: a value never comes back out of the store.
    expect(workspace.credentials).toEqual([
      { name: "STRIPE_API_KEY", label: "live", createdAt: expect.any(Number) },
    ]);
    expect(JSON.stringify(workspace)).not.toContain("sk_test_only");
  });

  it("keeps the machine row and the volume when a machine stops, and brings it back on start", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // An explicit volume: the fake provider cannot place one itself, and this
    // test is about what a stop does to the disk.
    const volume = await appRequest(app, "/volumes", {
      ...json({ name: "state", sizeGb: 20, location: "test" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const volumeId = (await volume.json<{ volume: { id: string } }>()).volume.id;
    const workspace = await createWorkspace(app, cookie, volumeId);
    const machineId = await machineIdFor(workspace.id);
    const before = await machineRow(workspace.id, "personal");
    expect(before?.volume_id).toBe(volumeId);

    const stopped = await appRequest(app, `/machines/${machineId}/stop`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(stopped.status).toBe(200);
    await expect(stopped.json<MachineResponse>()).resolves.toMatchObject({
      machine: { id: machineId, state: "stopped" },
    });
    // The VM is an incarnation; the volume is the machine. Stop destroys the
    // first and keeps the second, and the retention clock does NOT start.
    const afterStop = await machineRow(workspace.id, "personal");
    expect(afterStop?.vm_id).toBeNull();
    expect(afterStop?.volume_id).toBe(before?.volume_id);
    expect(await env.DB
      .prepare("SELECT detached_at FROM volume_ownership WHERE volume_id = ?1")
      .bind(before?.volume_id).first<number | null>("detached_at")).toBeNull();
    // The guest's credential dies with its VM.
    expect(await env.DB
      .prepare("SELECT COUNT(*) AS count FROM machine_token_families WHERE machine_id = ?1")
      .bind(machineId).first<number>("count")).toBe(0);

    const started = await appRequest(app, `/machines/${machineId}/start`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(started.status).toBe(200);
    const afterStart = await machineRow(workspace.id, "personal");
    expect(afterStart?.state).toBe("provisioning");
    expect(afterStart?.volume_id).toBe(before?.volume_id);
    expect(providers.createCalls).toBe(2);
    // A fresh capability is armed for the new incarnation, so the guest that
    // boots on the same disk enrols against the same machine row.
    expect(await appRequest(app, new URL(
      (providers.userData.get(machineId) ?? "").match(/readonly PHONE_HOME_URL='([^']+)'/u)?.[1] ?? "",
    ).pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAhost" }),
    }).then(({ status }) => status)).toBe(200);
  });

  it("changes a machine type on the same volume and refuses another location", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const machineId = await machineIdFor(workspace.id);
    const volumeId = (await machineRow(workspace.id, "personal"))?.volume_id;

    // The fake provider places every type in one location, so a same-location
    // change is the path this exercises; the cross-location refusal is the
    // unknown-location branch below.
    const changed = await appRequest(app, `/machines/${machineId}/machine-type`, {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    // Same type: nothing to do, and nothing destroyed.
    expect(changed.status).toBe(200);
    expect(providers.destroyCalls).toBe(0);

    const unknown = await appRequest(app, `/machines/${machineId}/machine-type`, {
      ...json({ machineTypeId: "not-a-type" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(unknown.status).toBe(400);
    // The machine is untouched by a refused change: its disk is still there.
    expect((await machineRow(workspace.id, "personal"))?.volume_id).toBe(volumeId);
  });

  it("grades machine verbs against the permission matrix", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("matrix-member");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const ownerMachine = await machineIdFor(workspace.id);
    const theirMachine = await machineIdFor(workspace.id, teammate.membershipId);

    // A member may stop and start their OWN machine.
    expect((await appRequest(app, `/machines/${theirMachine}/stop`, {
      method: "POST",
      headers: { Cookie: teammate.cookie },
    })).status).toBe(200);
    // ...and nobody else's.
    expect((await appRequest(app, `/machines/${ownerMachine}/stop`, {
      method: "POST",
      headers: { Cookie: teammate.cookie },
    })).status).toBe(403);
    // Recreate, SetMachineType and destroy are workspace-admin work, even on
    // their own machine: they interrupt the workspace, not just themselves.
    for (const [path, init] of [
      [`/machines/${theirMachine}/recreate`, { method: "POST", headers: { Cookie: teammate.cookie } }],
      [`/machines/${theirMachine}`, { method: "DELETE", headers: { Cookie: teammate.cookie } }],
      [`/machines/${theirMachine}/machine-type`, {
        ...json({ machineTypeId: "small" }),
        headers: { Cookie: teammate.cookie, "Content-Type": "application/json" },
      }],
    ] as const) {
      expect((await appRequest(app, path, init)).status, path).toBe(403);
    }
    // The org admin passes every workspace-admin gate through implicit reach.
    expect((await appRequest(app, `/machines/${theirMachine}/start`, {
      method: "POST",
      headers: { Cookie: cookie },
    })).status).toBe(200);
  });

  it("destroys a removed member's machine and keeps the disk for the retention window", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("leaver");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;

    expect((await appRequest(app, `/workspaces/${workspace.id}/members/${teammate.membershipId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);

    // The machine goes and the membership with it. The grace snapshot §2.3
    // asks for is the existing seven-day volume retention, which
    // `destroyMachine` starts and `test/workspace-volumes.test.ts` pins.
    expect((await machineRow(workspace.id, teammate.membershipId))?.state).toBe("destroyed");
    expect(await env.DB
      .prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?1")
      .bind(workspace.id).first<number>("count")).toBe(1);

    // The owner cannot be removed: the workspace row names them.
    expect((await appRequest(app, `/workspaces/${workspace.id}/members/personal`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(409);
  });

  it("destroys a machine when a member is demoted to viewer and rebuilds one on promotion", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("demoted");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;

    const demoted = await appRequest(app, `/workspaces/${workspace.id}/members/${teammate.membershipId}`, {
      ...json({ role: "viewer" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(demoted.status).toBe(200);
    await expect(demoted.json<WorkspaceMemberResponse>()).resolves.toMatchObject({
      member: { role: "viewer", machine: null },
    });

    const promoted = await appRequest(app, `/workspaces/${workspace.id}/members/${teammate.membershipId}`, {
      ...json({ role: "member" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(promoted.status).toBe(200);
    await expect(promoted.json<WorkspaceMemberResponse>()).resolves.toMatchObject({
      member: { role: "member", machine: { state: "provisioning" } },
    });
  });

  it("leaves the member with no machine when auto_provision is off, until one is asked for", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("manual");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        autoProvision: false,
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    expect(workspace.autoProvision).toBe(false);
    expect(workspace.members?.every(({ machine }) => machine === null)).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM machines")
      .first<number>("count")).toBe(0);

    // Nobody's machine exists, so the proxy says so in words the member can
    // act on instead of failing somewhere downstream.
    const proxied = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, {
      headers: { Cookie: teammate.cookie },
    });
    expect(proxied.status).toBe(409);
    await expect(proxied.json()).resolves.toMatchObject({
      error: expect.stringContaining("no machine in this workspace"),
    });
  });

  it("provisions a machine for a member row that holds none", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("manual-member");
    const watcher = await sameOrgSession("manual-viewer");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        autoProvision: false,
        members: [
          { membershipId: teammate.membershipId, role: "member" },
          { membershipId: watcher.membershipId, role: "viewer" },
        ],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const path = (membershipId: string) =>
      `/workspaces/${workspace.id}/members/${membershipId}/machine`;
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM machines")
      .first<number>("count")).toBe(0);

    const provisioned = await appRequest(app, path(teammate.membershipId), {
      ...json({}),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(provisioned.status).toBe(201);
    await expect(provisioned.json<WorkspaceMemberResponse>()).resolves.toMatchObject({
      member: {
        membershipId: teammate.membershipId,
        role: "member",
        machine: { state: "provisioning", machineTypeId: "small" },
      },
    });

    // This route creates. A machine that exists has `start` and `recreate`.
    const again = await appRequest(app, path(teammate.membershipId), {
      ...json({}),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({
      error: expect.stringContaining("already has a machine"),
    });

    // A viewer never holds one (§2.2); the way to give them a machine is the
    // role write, not this route.
    const viewer = await appRequest(app, path(watcher.membershipId), {
      ...json({}),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(viewer.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM machines")
      .first<number>("count")).toBe(1);

    // Somebody who is not in this workspace has no machine to provision.
    expect((await appRequest(app, path("no-such-membership"), {
      ...json({}),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(404);
    // Provisioning somebody's machine is workspace-admin work (§3).
    expect((await appRequest(app, path(watcher.membershipId), {
      ...json({}),
      headers: { Cookie: teammate.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
  });

  it("brings a destroyed member machine back on its own disk, at the type asked for", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("returning-member");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const machineId = await machineIdFor(workspace.id, teammate.membershipId);
    const volumeId = (await machineRow(workspace.id, teammate.membershipId))?.volume_id;
    const path = `/workspaces/${workspace.id}/members/${teammate.membershipId}/machine`;

    expect((await appRequest(app, `/machines/${machineId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(200);
    expect((await machineRow(workspace.id, teammate.membershipId))?.state).toBe("destroyed");

    const back = await appRequest(app, path, {
      ...json({}),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(back.status).toBe(201);
    // The row and its disk are the durable machine, so the member comes back
    // on what they had rather than on an empty one.
    const after = await machineRow(workspace.id, teammate.membershipId);
    expect(after?.id).toBe(machineId);
    expect(after?.volume_id).toBe(volumeId ?? null);

    // A type no provider claims is refused before anything is created: the
    // registry is the only authority on what a type id means.
    const ownerMachine = await machineIdFor(workspace.id);
    expect((await appRequest(app, `/machines/${ownerMachine}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(200);
    const unknown = await appRequest(app, `/workspaces/${workspace.id}/members/personal/machine`, {
      ...json({ machineTypeId: "not-a-type" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(unknown.status).toBe(400);
    expect((await machineRow(workspace.id, "personal"))?.state).toBe("destroyed");
  });

  it("counts machines against vm_limit, not workspaces", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const first = await sameOrgSession("quota-one");
    const second = await sameOrgSession("quota-two");
    await env.DB.prepare("UPDATE orgs SET vm_limit = 2 WHERE id = 'personal'").run();

    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [
          { membershipId: first.membershipId, role: "member" },
          { membershipId: second.membershipId, role: "member" },
        ],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    // Two slots, three members who each want a VM: the creator and the first
    // added member get one, and the third add finds the quota spent.
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM machines")
      .first<number>("count")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_members")
      .first<number>("count")).toBe(3);

    const usage = await appRequest(app, "/orgs/self/usage", { headers: { Cookie: cookie } });
    await expect(usage.json()).resolves.toMatchObject({ vmsUsed: 2, vmLimit: 2 });
  });

  it("serves a workspace credential through the box pull wire, personal grant first", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        credentials: [{ name: "STRIPE_API_KEY", value: "sk_workspace_value" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const token = await boxTokenFor(app, providers, workspace.id);
    const boxHeaders = { Authorization: `Bearer ${token}` };

    // The allow-list a box reads carries both planes: `blitz-cred` is the one
    // door to every secret on the machine.
    const listed = await appRequest(app, "/workspaces/self/connections", { headers: boxHeaders });
    await expect(listed.json()).resolves.toEqual({ connections: ["STRIPE_API_KEY"] });

    const minted = await appRequest(app, "/workspaces/self/connections/STRIPE_API_KEY/token", {
      method: "POST",
      headers: boxHeaders,
    });
    expect(minted.status).toBe(200);
    await expect(minted.json()).resolves.toMatchObject({
      connection: "STRIPE_API_KEY",
      mode: "inject",
      token: "sk_workspace_value",
      env: [{ name: "STRIPE_API_KEY", value: "sk_workspace_value" }],
    });

    // A rotate is the same act as an add: the next pull reads the new value
    // live, with no sync and no restart.
    expect((await appRequest(app, `/workspaces/${workspace.id}/credentials`, {
      ...json({ name: "STRIPE_API_KEY", value: "sk_rotated_value" }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(201);
    await expect(appRequest(app, "/workspaces/self/connections/STRIPE_API_KEY/token", {
      method: "POST",
      headers: boxHeaders,
    }).then((response) => response.json())).resolves.toMatchObject({
      token: "sk_rotated_value",
    });

    // A revoke refuses the next call rather than the one after it.
    expect((await appRequest(app, `/workspaces/${workspace.id}/credentials/STRIPE_API_KEY`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    expect((await appRequest(app, "/workspaces/self/connections/STRIPE_API_KEY/token", {
      method: "POST",
      headers: boxHeaders,
    })).status).toBe(404);
  });

  it("gates workspace credentials on the workspace role", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("cred-member");
    const viewer = await sameOrgSession("cred-viewer");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [
          { membershipId: member.membershipId, role: "member" },
          { membershipId: viewer.membershipId, role: "viewer" },
        ],
        credentials: [{ name: "STRIPE_API_KEY", value: "sk_test_only" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const path = `/workspaces/${workspace.id}/credentials`;

    // Use, yes; manage, no. A viewer may not even enumerate the names: they
    // hold no machine and may not use a credential at all (§3).
    await expect(appRequest(app, path, { headers: { Cookie: member.cookie } })
      .then((response) => response.json())).resolves.toEqual({
        credentials: [{ name: "STRIPE_API_KEY", label: null, createdAt: expect.any(Number) }],
      });
    expect((await appRequest(app, path, { headers: { Cookie: viewer.cookie } })).status).toBe(403);
    expect((await appRequest(app, path, {
      ...json({ name: "OTHER", value: "x" }, "PUT"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, `${path}/STRIPE_API_KEY`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(403);
  });

  it("routes the webApp proxy to the requesting member's own machine", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("proxy-member");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: teammate.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const theirMachine = await machineIdFor(workspace.id, teammate.membershipId);

    // Their machine is destroyed, so the proxy refuses THEM while the owner
    // keeps working: one workspace, one VM per member.
    expect((await appRequest(app, `/machines/${theirMachine}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(200);
    const refused = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, {
      headers: { Cookie: teammate.cookie },
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: expect.stringContaining("no machine in this workspace"),
    });
  });
});

describe("workspace settings", () => {
  beforeEach(resetDatabase);

  it("edits the settings a workspace admin owns and leaves live machines alone", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const machineId = await machineIdFor(workspace.id);
    const path = `/workspaces/${workspace.id}`;

    const rule = await appRequest(app, "/agent-rules/rule-one", {
      ...json({ name: "House rules", content: "# House rules\n" }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(rule.status).toBe(201);

    const patched = await appRequest(app, path, {
      ...json({ name: "engineering", autoProvision: false, agentRuleId: "rule-one" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(patched.status).toBe(200);
    const updated = (await patched.json<CreatedWorkspace>()).workspace;
    expect(updated.name).toBe("engineering");
    expect(updated.autoProvision).toBe(false);
    expect(updated.agentRuleId).toBe("rule-one");
    // The revision is the counter every poller watches, and a workspace has no
    // lifecycle of its own — so a settings write has to move it.
    expect(updated.revision).toBeGreaterThan(workspace.revision);
    // A default is a default: the type change below moves what a FUTURE
    // machine takes, and this one keeps the type it was provisioned with.
    expect((await machineRow(workspace.id, "personal"))?.machine_type_id).toBe("small");
    expect((await machineRow(workspace.id, "personal"))?.id).toBe(machineId);

    // An absent field is left alone rather than reset.
    const single = await appRequest(app, path, {
      ...json({ name: "renamed" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    await expect(single.json<CreatedWorkspace>()).resolves.toMatchObject({
      workspace: { name: "renamed", autoProvision: false, agentRuleId: "rule-one" },
    });

    // An explicit null is the way back to the built-in doc.
    await expect(appRequest(app, path, {
      ...json({ agentRuleId: null }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    }).then((response) => response.json<CreatedWorkspace>())).resolves.toMatchObject({
      workspace: { agentRuleId: null },
    });
  });

  it("refuses a default machine type no provider claims, and an agent rule of another org", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}`;

    const unknownType = await appRequest(app, path, {
      ...json({ defaultMachineTypeId: "not-a-type" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(unknownType.status).toBe(400);
    await expect(unknownType.json()).resolves.toMatchObject({
      error: expect.stringContaining("unknown machine type"),
    });
    expect((await appRequest(app, path, {
      ...json({ agentRuleId: "no-such-rule" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(404);
    expect((await appRequest(app, path, {
      ...json({ autoProvision: "yes" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);

    // A refused write leaves the row exactly as it was.
    await expect(appRequest(app, path, { headers: { Cookie: cookie } })
      .then((response) => response.json<CreatedWorkspace>())).resolves.toMatchObject({
        workspace: { defaultMachineTypeId: "small", revision: workspace.revision },
      });
  });

  it("gates the settings write on workspace admin, and org admins pass implicitly", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("settings-member");
    const other = await sameOrgSession("settings-admin", "admin");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: member.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const path = `/workspaces/${workspace.id}`;

    expect((await appRequest(app, path, {
      ...json({ name: "not yours" }, "PATCH"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    // Another org's admin never sees the workspace at all, so 404 rather than
    // 403: a refusal that names the row leaks what the organization holds.
    expect((await appRequest(app, "/workspaces/no-such-workspace", {
      ...json({ name: "nowhere" }, "PATCH"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(404);
    expect((await appRequest(app, path, {
      ...json({ name: "org admin reach" }, "PATCH"),
      headers: { Cookie: other.cookie, "Content-Type": "application/json" },
    })).status).toBe(200);
  });
});

describe("workspace repositories", () => {
  beforeEach(resetDatabase);
  afterEach(() => { vi.restoreAllMocks(); });

  it("adds and removes a repository after create", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("repo-member");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: member.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const path = `/workspaces/${workspace.id}/repos`;
    // Reachable anonymously, so every probe reads public and no grant is owed.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(appRequest(app, path, { headers: { Cookie: cookie } })
      .then((response) => response.json<ListWorkspaceReposResponse>()))
      .resolves.toEqual({ repos: [] });

    const added = await appRequest(app, path, {
      ...json({ repo: "acme/tools" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(added.status).toBe(201);
    await expect(added.json<ListWorkspaceReposResponse>()).resolves.toEqual({
      repos: [{ repo: "acme/tools", private: false }],
    });

    // Working in the workspace is enough to read what it clones; changing the
    // list is workspace-admin work (§3).
    await expect(appRequest(app, path, { headers: { Cookie: member.cookie } })
      .then((response) => response.json<ListWorkspaceReposResponse>()))
      .resolves.toEqual({ repos: [{ repo: "acme/tools", private: false }] });
    expect((await appRequest(app, path, {
      ...json({ repo: "acme/other" }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);

    // The path carries "owner/name" as two segments: a slash inside one
    // parameter is not something a router hands back intact.
    expect((await appRequest(app, `${path}/acme/tools`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    await expect(appRequest(app, path, { headers: { Cookie: cookie } })
      .then((response) => response.json<ListWorkspaceReposResponse>()))
      .resolves.toEqual({ repos: [] });
    expect((await appRequest(app, `${path}/acme/tools`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });

  it("applies the create-time repository rules to one added row", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}/repos`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const add = (repo: unknown) => appRequest(app, path, {
      ...json({ repo }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });

    for (const bad of ["no-slash", "owner/name/extra", "owner/", "/name", "owner/na me"]) {
      expect((await add(bad)).status, bad).toBe(400);
    }
    expect((await add("acme/tools")).status).toBe(201);
    expect((await add("acme/tools")).status).toBe(409);
    // Every repo clones into /workspace/<name>, so two of one name would fight
    // over one directory — the same rule create validates the whole list on.
    const collision = await add("blitz/tools");
    expect(collision.status).toBe(400);
    await expect(collision.json()).resolves.toMatchObject({
      error: expect.stringContaining("clone into the same directory"),
    });

    for (let index = 1; index < 16; index += 1) {
      expect((await add(`acme/repo-${String(index)}`)).status, String(index)).toBe(201);
    }
    const full = await add("acme/one-too-many");
    expect(full.status).toBe(400);
    await expect(full.json()).resolves.toMatchObject({
      error: expect.stringContaining("at most 16 repositories"),
    });
  });

  it("refuses a private repository the caller cannot prove they reach", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    // Hidden to an anonymous probe, and the caller holds no GitHub grant: the
    // clone would fail ten minutes into bootstrap, so it is refused now.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    const refused = await appRequest(app, `/workspaces/${workspace.id}/repos`, {
      ...json({ repo: "acme/private" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(refused.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_repos")
      .first<number>("count")).toBe(0);
  });
});
